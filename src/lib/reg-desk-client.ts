// The check-in desk's browser script (bundled for /admin/registration/<id>/checkin only). It enhances plain
// server-rendered forms: actions post in place and the page re-reads its own HTML for the results, counts and
// notice (so the server stays the only renderer); every 10 s while the tab is visible it polls a cheap change
// marker and refreshes when another desk changed something; and "Scan code" reads the QR from the confirmation
// email with the camera (BarcodeDetector where the browser has it, otherwise jsQR, loaded only on demand).

interface DeskCopy { scanHint: string; scanDenied: string; scanStop: string; error: string; confirm: string }

const POLL_MS = 10_000;

export function initDesk(doc: Document = document): void {
  const root = doc.querySelector<HTMLElement>('[data-reg-desk]');
  if (!root) return;
  const copy = JSON.parse(root.dataset.copy ?? '{}') as DeskCopy;
  const pollUrl = root.dataset.poll ?? '';
  let version = root.dataset.version ?? '';
  let busy = false;

  const searchInput = (): HTMLInputElement | null => root.querySelector<HTMLInputElement>('#desk-q');
  const setNotice = (text: string) => {
    const el = root.querySelector<HTMLElement>('[data-desk-notice]');
    if (el) el.textContent = text;
  };

  /** Re-read this page (optionally with done/error params) and swap the live regions in place. */
  async function refresh(extra: Record<string, string> = {}, swapNotice = false): Promise<void> {
    const url = new URL(window.location.href);
    url.search = '';
    const q = searchInput()?.value.trim() ?? '';
    if (q) url.searchParams.set('q', q);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), { headers: { accept: 'text/html' }, credentials: 'same-origin' });
    if (!res.ok) return;
    // The markup comes only from this same page on our own origin, server-rendered by Astro, which escapes every
    // user value (names, confirmation numbers); scripts in parsed or innerHTML-assigned markup never run.
    const html = new DOMParser().parseFromString(await res.text(), 'text/html');
    for (const sel of ['[data-desk-results]', '[data-desk-counts]', ...(swapNotice ? ['[data-desk-notice]'] : [])]) {
      const next = html.querySelector(sel);
      const current = root!.querySelector(sel);
      if (next && current) current.innerHTML = next.innerHTML;
    }
    const nextRoot = html.querySelector<HTMLElement>('[data-reg-desk]');
    if (nextRoot?.dataset.version) version = nextRoot.dataset.version;
  }

  // Actions: post in place, then show the server-rendered result.
  root.addEventListener('submit', async (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.matches('[data-desk-action]')) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const outcome = (await res.json().catch(() => null)) as { ok: boolean; done?: string; count?: number; code?: string } | null;
      if (outcome?.ok && outcome.done) {
        await refresh({ done: outcome.done, ...(outcome.count !== undefined ? { count: String(outcome.count) } : {}) }, true);
      } else if (outcome?.code === 'NEEDS_CONFIRM') {
        setNotice(copy.confirm);
      } else {
        setNotice(copy.error);
      }
    } catch {
      setNotice(copy.error);
    } finally {
      busy = false;
    }
  });

  // Follow other desks while this tab is visible.
  if (pollUrl) {
    window.setInterval(async () => {
      if (doc.visibilityState !== 'visible' || busy) return;
      try {
        const res = await fetch(pollUrl, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { version?: string };
        if (data.version && data.version !== version) await refresh();
      } catch {
        /* offline for a moment: try again on the next tick */
      }
    }, POLL_MS);
  }

  setupScanner(root, copy);
}

type Detect = (video: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>;

async function makeDetector(): Promise<Detect> {
  const Native = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(src: CanvasImageSource): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
  if (Native) {
    const detector = new Native({ formats: ['qr_code'] });
    return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
  }
  // iPad/iPhone Safari has no BarcodeDetector: decode frames with jsQR, fetched only now.
  const { default: jsQR } = await import('jsqr');
  return async (video, canvas) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    return jsQR(frame.data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

function setupScanner(root: HTMLElement, copy: DeskCopy): void {
  const start = root.querySelector<HTMLButtonElement>('[data-desk-scan]');
  const panel = root.querySelector<HTMLElement>('[data-desk-scanner]');
  const video = root.querySelector<HTMLVideoElement>('[data-desk-video]');
  const stopBtn = root.querySelector<HTMLButtonElement>('[data-desk-scan-stop]');
  const status = root.querySelector<HTMLElement>('[data-desk-scan-status]');
  const form = root.querySelector<HTMLFormElement>('[data-desk-search]');
  if (!start || !panel || !video || !stopBtn || !status || !form || !navigator.mediaDevices?.getUserMedia) return;
  start.hidden = false;
  const canvas = document.createElement('canvas');
  let stream: MediaStream | null = null;
  let running = false;

  const stop = () => {
    running = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    panel.hidden = true;
    start.focus();
  };

  start.addEventListener('click', async () => {
    panel.hidden = false;
    status.textContent = copy.scanHint;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = stream;
      await video.play();
      const detect = await makeDetector();
      running = true;
      const tick = async () => {
        if (!running) return;
        try {
          const value = (await detect(video, canvas))?.trim();
          if (value) {
            stop();
            const input = form.querySelector<HTMLInputElement>('#desk-q');
            if (input) input.value = value.slice(0, 120);
            form.requestSubmit();
            return;
          }
        } catch {
          /* a frame that cannot be read: keep scanning */
        }
        window.setTimeout(() => requestAnimationFrame(tick), 150);
      };
      requestAnimationFrame(tick);
    } catch {
      stop();
      panel.hidden = false;
      status.textContent = copy.scanDenied;
    }
  });
  stopBtn.addEventListener('click', stop);
}
