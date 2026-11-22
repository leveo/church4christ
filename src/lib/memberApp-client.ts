// Member app browser glue: registers the per-locale service worker and shows an
// install hint. Chrome/Edge/Android fire `beforeinstallprompt`, so a button opens
// the browser's own install dialog; iOS Safari has no such event, so it gets a
// one-line "Share -> Add to Home Screen" hint instead. A dismissal is remembered
// on the device. Nothing here is needed for the app to work: every page is plain
// server-rendered HTML.

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const DISMISS_KEY = 'c4c-app-install-dismissed';

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function standalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

export function initMemberApp(): void {
  const body = document.body;
  const sw = body.dataset.appSw;
  const scope = body.dataset.appScope;
  if (sw && scope && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(sw, { scope }).catch(() => {
      /* offline support is optional; the pages still work without it */
    });
  }

  const banner = document.querySelector<HTMLElement>('[data-app-install]');
  if (!banner || standalone() || dismissed()) return;
  const button = banner.querySelector<HTMLButtonElement>('[data-app-install-btn]');
  const iosHint = banner.querySelector<HTMLElement>('[data-app-install-ios]');
  const close = banner.querySelector<HTMLButtonElement>('[data-app-install-close]');

  close?.addEventListener('click', () => {
    banner.hidden = true;
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage disabled: the banner simply shows again next time */
    }
  });

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios && iosHint) {
    iosHint.hidden = false;
    banner.hidden = false;
    return;
  }

  let deferred: InstallPromptEvent | null = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    if (button) button.hidden = false;
    banner.hidden = false;
  });
  button?.addEventListener('click', async () => {
    if (!deferred) return;
    banner.hidden = true;
    await deferred.prompt();
    deferred = null;
  });
  window.addEventListener('appinstalled', () => {
    banner.hidden = true;
  });
}
