# Seeded Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add warm documentary seed images and make homepage hero, ministry covers, event inserts, and profile avatars use the existing editable media pipeline.

**Architecture:** Reuse the existing R2-backed upload system: content-addressed `uploads/...` keys, `media` table registration, and `/media/<key>` delivery. Store the homepage hero key in `settings.site.hero_image_key`, event/ministry keys in existing columns, and person avatars in `people.avatar_url` rendered through a small normalization helper.

**Tech Stack:** Astro 7, TypeScript, Cloudflare Workers/D1/R2, Vitest Workers pool, Wrangler local D1/R2, GPT Image asset generation.

---

## File Map

- Create `src/lib/mediaRef.ts`: normalize media keys/URLs and convert upload keys to `/media/...`.
- Create `src/lib/mediaUpload.ts`: shared upload/remove helper used by admin settings, profile, people, and ministry pages.
- Create `scripts/db/seed-media-local.mjs`: idempotently upload seed assets to local R2 and update local D1 rows/settings.
- Create `seed/media/manifest.json`: maps generated files to settings, people, events, and ministries.
- Create `seed/media/*.webp`: generated Warm Documentary seed images.
- Modify `package.json`: add `db:seed-media:local`.
- Modify `src/lib/settings.ts`: add `getHeroImageKey`.
- Modify `src/lib/validate.ts`: allow `site.hero_image_key` through settings parsing.
- Modify `src/components/Hero.astro`: render uploaded hero image when configured, fallback to current SVG.
- Modify `src/components/MinistryCard.astro` and ministry detail pages: render ministry cover image when present.
- Modify `src/pages/admin/settings/index.astro`: upload/remove hero image.
- Modify `src/pages/[locale]/profile.astro`: upload/remove own avatar.
- Modify `src/pages/admin/people/[id].astro`: upload/remove person avatar as admin.
- Modify `src/pages/admin/ministries/index.astro` and `src/components/admin/MinistriesTab.astro`: upload/remove ministry cover image.
- Modify `seed/dev-seed.sql`: seed stable media keys into rows/settings after the media script writes matching keys.
- Modify tests: `test/settings.test.ts`, `test/validate.test.ts`, `test/seed.test.ts`, and `test/e2e/admin.e2e.test.ts`.
- Modify docs: `README.md` to mention `npm run db:seed-media:local`.

---

### Task 1: Media Reference Helpers

**Files:**
- Create: `src/lib/mediaRef.ts`
- Test: `test/mediaRef.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { mediaPath, normalizeAvatarUrl } from '../src/lib/mediaRef';

describe('mediaRef', () => {
  it('turns upload keys into public media URLs', () => {
    expect(mediaPath('uploads/abc123-photo.webp')).toBe('/media/uploads/abc123-photo.webp');
    expect(mediaPath('/media/uploads/abc123-photo.webp')).toBe('/media/uploads/abc123-photo.webp');
    expect(mediaPath(null)).toBeNull();
  });

  it('keeps absolute avatar URLs but normalizes upload keys', () => {
    expect(normalizeAvatarUrl('uploads/abc123-person.webp')).toBe('/media/uploads/abc123-person.webp');
    expect(normalizeAvatarUrl('/media/uploads/abc123-person.webp')).toBe('/media/uploads/abc123-person.webp');
    expect(normalizeAvatarUrl('https://cdn.example/avatar.png')).toBe('https://cdn.example/avatar.png');
    expect(normalizeAvatarUrl('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/mediaRef.test.ts`

Expected: FAIL because `src/lib/mediaRef.ts` does not exist.

- [ ] **Step 3: Implement the helper**

```ts
const UPLOAD_KEY = /^uploads\/[a-z0-9][a-z0-9.-]*$/;

export function mediaPath(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (v.startsWith('/media/uploads/')) return v;
  if (UPLOAD_KEY.test(v)) return `/media/${v}`;
  return v;
}

export function normalizeAvatarUrl(value: string | null | undefined): string | null {
  return mediaPath(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/mediaRef.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mediaRef.ts test/mediaRef.test.ts
git commit -m "feat: normalize media references"
```

---

### Task 2: Shared Upload Helper

**Files:**
- Create: `src/lib/mediaUpload.ts`
- Test: `test/mediaUpload.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { saveImageUpload } from '../src/lib/mediaUpload';
import { uploadKey } from '../src/lib/upload';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

describe('saveImageUpload', () => {
  it('stores a valid image in R2 and registers media metadata', async () => {
    const file = new File([pngBytes], 'Tiny Hero.PNG', { type: 'image/png' });
    const key = await saveImageUpload({
      db: env.DB,
      media: (env as { MEDIA: R2Bucket }).MEDIA,
      file,
      uploadedBy: 'admin@example.com',
    });

    expect(key).toBe(await uploadKey(pngBytes.buffer as ArrayBuffer, 'Tiny Hero.PNG'));
    expect(await (env as { MEDIA: R2Bucket }).MEDIA.get(key)).not.toBeNull();
    const row = await env.DB.prepare('SELECT filename, content_type, size, uploaded_by FROM media WHERE r2_key = ?')
      .bind(key)
      .first<{ filename: string; content_type: string; size: number; uploaded_by: string }>();
    expect(row).toEqual({ filename: 'Tiny Hero.PNG', content_type: 'image/png', size: pngBytes.length, uploaded_by: 'admin@example.com' });
  });

  it('rejects unsupported image types', async () => {
    await expect(saveImageUpload({
      db: env.DB,
      media: (env as { MEDIA: R2Bucket }).MEDIA,
      file: new File(['x'], 'x.svg', { type: 'image/svg+xml' }),
      uploadedBy: 'admin@example.com',
    })).rejects.toThrow('image_type');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/mediaUpload.test.ts`

Expected: FAIL because `src/lib/mediaUpload.ts` does not exist.

- [ ] **Step 3: Implement the helper**

```ts
import type { AppDb } from './appDb';
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, registerMedia, uploadKey } from './upload';

export interface SaveImageUploadInput {
  db: AppDb;
  media: R2Bucket;
  file: File;
  uploadedBy: string | null;
}

export async function saveImageUpload(input: SaveImageUploadInput): Promise<string> {
  const { db, media, file, uploadedBy } = input;
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) throw new Error('image_type');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('image_too_large');
  const bytes = await file.arrayBuffer();
  const key = await uploadKey(bytes, file.name);
  await media.put(key, bytes, { httpMetadata: { contentType: file.type } });
  await registerMedia(db, { r2Key: key, filename: file.name, contentType: file.type, size: file.size, uploadedBy });
  return key;
}

export function uploadErrorKey(e: unknown): string {
  if (e instanceof Error && e.message === 'image_type') return 'errors.imageType';
  if (e instanceof Error && e.message === 'image_too_large') return 'errors.imageTooLarge';
  return 'admin.form.badRequest';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/mediaUpload.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mediaUpload.ts test/mediaUpload.test.ts
git commit -m "feat: share image upload handling"
```

---

### Task 3: Hero Setting and Rendering

**Files:**
- Modify: `src/lib/settings.ts`
- Modify: `src/lib/validate.ts`
- Modify: `src/components/Hero.astro`
- Modify: `src/pages/[locale]/index.astro`
- Test: `test/settings.test.ts`
- Test: `test/validate.test.ts`
- Test: `test/e2e/public.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/settings.test.ts`:

```ts
import { getHeroImageKey } from '../src/lib/settings';

it('getHeroImageKey returns the configured homepage hero media key', async () => {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('site.hero_image_key', 'uploads/hero.webp')").run();
  expect(await getHeroImageKey(env.DB)).toBe('uploads/hero.webp');
});
```

Add to `test/validate.test.ts` inside `parseSettingsForm` tests:

```ts
it('allows the homepage hero image key setting', () => {
  const r = parseSettingsForm(fdOf({ 'site.hero_image_key': 'uploads/hero.webp' }));
  expect(r).toEqual({ ok: true, data: { 'site.hero_image_key': 'uploads/hero.webp' } });
});
```

Add to `test/e2e/public.test.ts`:

```ts
it('renders a configured homepage hero image through /media', async () => {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('site.hero_image_key', 'uploads/hero-test.webp')").run();
  const res = await get('/en');
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('/media/uploads/hero-test.webp');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/settings.test.ts test/validate.test.ts && npm run test:e2e -- test/e2e/public.test.ts`

Expected: unit tests FAIL because helper/allowlist are missing, e2e FAIL because hero image is not rendered.

- [ ] **Step 3: Implement settings helper and allowlist**

In `src/lib/settings.ts`:

```ts
export async function getHeroImageKey(db: AppDb): Promise<string> {
  return getSetting(db, 'site.hero_image_key', '');
}
```

In `src/lib/validate.ts`, add `'site.hero_image_key'` to the settings key allowlist and treat it as a plain string setting.

- [ ] **Step 4: Wire Hero component**

Change `Hero.astro` props to accept `heroImageKey?: string`, import `mediaPath`, and render an image layer before the SVG fallback:

```astro
const { locale, heroImageKey = '' } = Astro.props;
const heroImage = mediaPath(heroImageKey);
```

```astro
{
  heroImage ? (
    <img src={heroImage} alt="" class="absolute inset-0 h-full w-full object-cover" fetchpriority="high" />
  ) : (
    <svg>...</svg>
  )
}
```

In `src/pages/[locale]/index.astro`, load `getHeroImageKey(db)` with the other homepage queries and pass `<Hero locale={locale} heroImageKey={heroImageKey} />`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/settings.test.ts test/validate.test.ts && npm run test:e2e -- test/e2e/public.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings.ts src/lib/validate.ts src/components/Hero.astro src/pages/[locale]/index.astro test/settings.test.ts test/validate.test.ts test/e2e/public.test.ts
git commit -m "feat: render configurable hero image"
```

---

### Task 4: Admin Settings Hero Upload

**Files:**
- Modify: `src/pages/admin/settings/index.astro`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`
- Test: `test/e2e/admin.e2e.test.ts`

- [ ] **Step 1: Write failing e2e test**

Add to `test/e2e/admin.e2e.test.ts`:

```ts
it('admin uploads a homepage hero image from settings and the public home page renders it', async () => {
  const cookie = await sessionCookie(1, 'admin@example.com');
  const form = new FormData();
  form.set('site.name.en', 'Church4Christ');
  form.set('site.name.zh', '四方基督教会');
  form.set('site.tagline.en', 'A church for the city');
  form.set('site.tagline.zh', '城市中的教会');
  form.set('site.service_times.en', 'Sundays');
  form.set('site.service_times.zh', '主日');
  form.set('site.address', '123 Grace Avenue');
  form.set('site.email', 'hello@example.com');
  form.set('site.phone', '(555) 010-4444');
  form.set('site.map_url', 'https://maps.example.com');
  form.set('site.giving_url', 'https://give.example.com');
  form.set('site.youtube_url', 'https://youtube.example.com');
  form.set('theme.name', 'sanctuary');
  form.set('theme.default_mode', 'light');
  form.set('locale.default', 'en');
  form.set('site.hero_image_key', '');
  form.set('hero_image', new File([pngBytes], 'hero.png', { type: 'image/png' }));

  const res = await SELF.fetch(`${ORIGIN}/admin/settings`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie },
    body: form,
    redirect: 'manual',
  });
  expect(res.status).toBe(303);

  const key = await uploadKey(pngBytes.buffer as ArrayBuffer, 'hero.png');
  const html = await (await get('/en')).text();
  expect(html).toContain(`/media/${key}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- test/e2e/admin.e2e.test.ts`

Expected: FAIL because settings does not process `hero_image`.

- [ ] **Step 3: Implement upload/remove UI and POST handling**

In `src/pages/admin/settings/index.astro`, import `env`, `saveImageUpload`, `uploadErrorKey`, and `mediaPath`. Add `site.hero_image_key` to `KEYS`. On non-modules POST, before `setSettings`, process:

```ts
const data = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => !k.startsWith('module.')));
const heroFile = fd.get('hero_image');
if (heroFile instanceof File && heroFile.size > 0) {
  try {
    data['site.hero_image_key'] = await saveImageUpload({
      db,
      media: (env as { MEDIA: R2Bucket }).MEDIA,
      file: heroFile,
      uploadedBy: user.email,
    });
  } catch (e) {
    errors['site.hero_image_key'] = uploadErrorKey(e);
  }
} else if (fd.get('remove_hero_image')) {
  data['site.hero_image_key'] = '';
}
if (Object.keys(errors).length === 0) await setSettings(db, data);
```

Add `en`/`zh` labels:

```ts
'admin.settings.heroImage': 'Homepage hero image',
'admin.settings.currentHeroImage': 'Current hero image',
'admin.settings.changeHeroImage': 'Change hero image',
'admin.settings.removeHeroImage': 'Remove hero image',
```

Render preview/file input in the appearance card.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- test/e2e/admin.e2e.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/settings/index.astro src/i18n/en.ts src/i18n/zh.ts test/e2e/admin.e2e.test.ts
git commit -m "feat: edit homepage hero image"
```

---

### Task 5: Profile and Admin Person Avatars

**Files:**
- Modify: `src/lib/adminDb.ts`
- Modify: `src/pages/[locale]/profile.astro`
- Modify: `src/pages/admin/people/[id].astro`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`
- Test: `test/e2e/admin.e2e.test.ts`

- [ ] **Step 1: Write failing e2e tests**

Add tests that POST `avatar` to `/en/profile` as Sarah and to `/admin/people/3` as admin, then assert `people.avatar_url` is the deterministic `/media/` URL.

```ts
it('member uploads their own profile avatar', async () => {
  const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
  const form = new FormData();
  form.set('display_name', 'Sarah Johnson 莎拉');
  form.set('first_name', 'Sarah');
  form.set('last_name', 'Johnson');
  form.set('phone', '');
  form.set('lang', 'en');
  form.set('avatar', new File([pngBytes], 'sarah.png', { type: 'image/png' }));
  const res = await SELF.fetch(`${ORIGIN}/en/profile`, { method: 'POST', headers: { origin: ORIGIN, cookie }, body: form, redirect: 'manual' });
  expect(res.status).toBe(303);
  const key = await uploadKey(pngBytes.buffer as ArrayBuffer, 'sarah.png');
  const row = await env.DB.prepare('SELECT avatar_url FROM people WHERE id = 3').first<{ avatar_url: string }>();
  expect(row?.avatar_url).toBe(`/media/${key}`);
});

it('admin uploads a profile avatar for another person', async () => {
  const cookie = await sessionCookie(1, 'admin@example.com');
  const form = new FormData();
  form.set('action', 'save');
  form.set('display_name', 'Sarah Johnson 莎拉');
  form.set('first_name', 'Sarah');
  form.set('last_name', 'Johnson');
  form.set('email', 'sarah.johnson@example.com');
  form.set('phone', '');
  form.set('role', 'member');
  form.set('active', '1');
  form.set('lang', 'en');
  form.set('birthday', '');
  form.set('address', '');
  form.set('membership_status', 'member');
  form.set('joined_on', '2020-01-01');
  form.set('avatar', new File([pngBytes], 'sarah-admin.png', { type: 'image/png' }));

  const res = await SELF.fetch(`${ORIGIN}/admin/people/3`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie },
    body: form,
    redirect: 'manual',
  });
  expect(res.status).toBe(303);
  const key = await uploadKey(pngBytes.buffer as ArrayBuffer, 'sarah-admin.png');
  const row = await env.DB.prepare('SELECT avatar_url FROM people WHERE id = 3').first<{ avatar_url: string }>();
  expect(row?.avatar_url).toBe(`/media/${key}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:e2e -- test/e2e/admin.e2e.test.ts`

Expected: FAIL because avatar upload fields are ignored.

- [ ] **Step 3: Add avatar persistence helper**

In `src/lib/adminDb.ts`:

```ts
export async function setPersonAvatar(db: AppDb, personId: number, avatarUrl: string | null): Promise<void> {
  await db.prepare(`UPDATE people SET avatar_url = ?1, updated_at = datetime('now') WHERE id = ?2 AND deleted_at IS NULL`)
    .bind(avatarUrl, personId)
    .run();
}
```

- [ ] **Step 4: Implement profile/admin upload handling**

In both profile pages, import `saveImageUpload`, `uploadErrorKey`, `mediaPath`, and `setPersonAvatar`. Process `avatar` and `remove_avatar` after the identity save succeeds:

```ts
const avatarFile = fd.get('avatar');
if (avatarFile instanceof File && avatarFile.size > 0) {
  const key = await saveImageUpload({ db, media: (env as { MEDIA: R2Bucket }).MEDIA, file: avatarFile, uploadedBy: user.email });
  await setPersonAvatar(db, targetPersonId, `/media/${key}`);
} else if (fd.get('remove_avatar')) {
  await setPersonAvatar(db, targetPersonId, null);
}
```

Add preview and labels:

```ts
'profile.avatar': 'Profile picture',
'profile.currentAvatar': 'Current profile picture',
'profile.changeAvatar': 'Change profile picture',
'profile.removeAvatar': 'Remove profile picture',
'admin.person.avatar': 'Profile picture',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:e2e -- test/e2e/admin.e2e.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/adminDb.ts src/pages/[locale]/profile.astro src/pages/admin/people/[id].astro src/i18n/en.ts src/i18n/zh.ts test/e2e/admin.e2e.test.ts
git commit -m "feat: edit profile avatars"
```

---

### Task 6: Ministry Cover Editing and Rendering

**Files:**
- Modify: `src/components/MinistryCard.astro`
- Modify: `src/pages/[locale]/ministries/[slug].astro`
- Modify: `src/components/admin/MinistriesTab.astro`
- Modify: `src/pages/admin/ministries/index.astro`
- Modify: `src/lib/ministryDb.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`
- Test: `test/e2e/volunteer.e2e.test.ts` or `test/e2e/admin.e2e.test.ts`

- [ ] **Step 1: Write failing e2e test**

Add this test to `test/e2e/volunteer.e2e.test.ts`:

```ts
it('admin uploads a ministry cover image and the public ministry index renders it', async () => {
  const cookie = await sessionCookie(1, 'admin@example.com');
  const form = new FormData();
  form.set('_action', 'updateCover');
  form.set('ministry_id', '1');
  form.set('cover_image', new File([pngBytes], 'worship-cover.png', { type: 'image/png' }));

  const res = await SELF.fetch(`${ORIGIN}/admin/ministries?tab=ministries`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie },
    body: form,
    redirect: 'manual',
  });
  expect(res.status).toBe(303);

  const key = await uploadKey(pngBytes.buffer as ArrayBuffer, 'worship-cover.png');
  const row = await env.DB.prepare('SELECT cover_key FROM ministries WHERE id = 1').first<{ cover_key: string }>();
  expect(row?.cover_key).toBe(key);

  const html = await (await get('/en/ministries')).text();
  expect(html).toContain(`/media/${key}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- test/e2e/volunteer.e2e.test.ts`

Expected: FAIL because ministry cover upload UI is missing.

- [ ] **Step 3: Add DB helper**

In `src/lib/ministryDb.ts`:

```ts
export async function setMinistryCoverKey(db: AppDb, ministryId: number, coverKey: string | null): Promise<void> {
  await db.prepare(`UPDATE ministries SET cover_key = ?1 WHERE id = ?2 AND deleted_at IS NULL`)
    .bind(coverKey, ministryId)
    .run();
}
```

- [ ] **Step 4: Render covers**

In `MinistryCard.astro`, add `coverKey?: string | null`; render an image with `mediaPath(coverKey)` above the card body when present. Update call sites to pass `coverKey={m.coverKey}`.

In ministry detail, render a wide cover image from `ministry.coverKey` when present.

- [ ] **Step 5: Add admin upload/remove**

In `src/pages/admin/ministries/index.astro`, handle `_action=updateCover`, upload via `saveImageUpload`, and call `setMinistryCoverKey`. In `MinistriesTab.astro`, add a file form inside each edit details panel:

```astro
<form method="post" enctype="multipart/form-data" class="mt-3 grid gap-2">
  <input type="hidden" name="ministry_id" value={m.id} />
  <input type="file" name="cover_image" accept="image/jpeg,image/png,image/webp,image/gif" />
  <label><input type="checkbox" name="remove_cover" /> {t(lang, 'admin.console.removeCover')}</label>
  <button name="_action" value="updateCover" class={btn}>{t(lang, 'admin.console.saveCover')}</button>
</form>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:e2e -- test/e2e/volunteer.e2e.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/MinistryCard.astro src/pages/[locale]/ministries/[slug].astro src/components/admin/MinistriesTab.astro src/pages/admin/ministries/index.astro src/lib/ministryDb.ts src/i18n/en.ts src/i18n/zh.ts test/e2e/volunteer.e2e.test.ts
git commit -m "feat: edit ministry cover images"
```

---

### Task 7: Generate and Seed Demo Media

**Files:**
- Create: `seed/media/manifest.json`
- Create: `seed/media/*.webp`
- Create: `scripts/db/seed-media-local.mjs`
- Modify: `seed/dev-seed.sql`
- Modify: `package.json`
- Modify: `README.md`
- Test: `test/seed.test.ts`

- [ ] **Step 1: Generate assets**

Use the image generation skill with `gpt-image-2` and Warm Documentary prompts. Generate:

- `hero-worship-gathering.webp`
- `event-summer-bible-camp.webp`
- `event-baptism-sunday.webp`
- `event-easter-celebration.webp`
- `ministry-worship.webp`
- `ministry-children.webp`
- `ministry-youth.webp`
- `ministry-college.webp`
- `ministry-family.webp`
- `ministry-seniors.webp`
- `avatar-david-chen.webp`
- `avatar-sarah-johnson.webp`
- `avatar-grace-lin.webp`
- `avatar-mark-liu.webp`
- `avatar-faithful-wang.webp`
- `avatar-amy-chen.webp`
- `avatar-ben-wu.webp`
- `avatar-esther-lin.webp`

Use prompts that avoid real identities, logos, and readable text.

- [ ] **Step 2: Write failing seed test**

Add to `test/seed.test.ts`:

```ts
it('seeds media-backed demo image references', async () => {
  const hero = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site.hero_image_key'").first<{ value: string }>();
  expect(hero?.value).toMatch(/^uploads\/[a-z0-9][a-z0-9.-]+\.webp$/);
  const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE image_key IS NOT NULL').first<{ n: number }>();
  expect(events?.n).toBe(3);
  const ministries = await env.DB.prepare('SELECT COUNT(*) AS n FROM ministries WHERE cover_key IS NOT NULL').first<{ n: number }>();
  expect(ministries?.n).toBeGreaterThanOrEqual(6);
  const avatars = await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE avatar_url LIKE '/media/uploads/%'").first<{ n: number }>();
  expect(avatars?.n).toBeGreaterThanOrEqual(8);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/seed.test.ts`

Expected: FAIL because seed image references are missing.

- [ ] **Step 4: Add manifest and seed-media script**

Manifest shape:

```json
{
  "settings": { "site.hero_image_key": "hero-worship-gathering.webp" },
  "events": { "1": "event-summer-bible-camp.webp", "2": "event-baptism-sunday.webp", "3": "event-easter-celebration.webp" },
  "ministries": { "1": "ministry-worship.webp", "2": "ministry-children.webp", "3": "ministry-youth.webp", "4": "ministry-college.webp", "5": "ministry-family.webp", "6": "ministry-seniors.webp" },
  "people": { "2": "avatar-david-chen.webp", "3": "avatar-sarah-johnson.webp", "4": "avatar-grace-lin.webp", "5": "avatar-mark-liu.webp", "6": "avatar-faithful-wang.webp", "7": "avatar-amy-chen.webp", "8": "avatar-ben-wu.webp", "9": "avatar-esther-lin.webp" }
}
```

`seed-media-local.mjs` computes content-addressed keys, writes local R2 using `wrangler r2 object put --local`, then runs `wrangler d1 execute DB --local --command "<updates>"`.

- [ ] **Step 5: Wire deterministic keys into SQL seed**

After generated files exist, compute their `uploadKey` values and update `seed/dev-seed.sql` with literal key strings. The final SQL must contain actual values like the following shape, with the real hash prefixes produced for the generated files:

```sql
UPDATE events SET image_key = 'uploads/0123456789abcdef-event-summer-bible-camp.webp' WHERE id = 1;
UPDATE ministries SET cover_key = 'uploads/0123456789abcdef-ministry-worship.webp' WHERE id = 1;
UPDATE people SET avatar_url = '/media/uploads/0123456789abcdef-avatar-sarah-johnson.webp' WHERE id = 3;
INSERT INTO settings (key, value) VALUES ('site.hero_image_key', 'uploads/0123456789abcdef-hero-worship-gathering.webp');
```

- [ ] **Step 6: Add npm script and docs**

`package.json`:

```json
"db:seed-media:local": "node scripts/db/seed-media-local.mjs"
```

README local seed section:

```sh
npm run db:seed:local
npm run db:seed-media:local
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- test/seed.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add seed/media scripts/db/seed-media-local.mjs seed/dev-seed.sql package.json README.md test/seed.test.ts
git commit -m "feat: seed demo media assets"
```

---

### Task 8: Final Verification

**Files:**
- No planned source edits unless verification finds a bug.

- [ ] **Step 1: Run full verification**

```bash
npm test
npm run build
```

Expected: both commands pass.

- [ ] **Step 2: Run targeted e2e verification**

```bash
npm run test:e2e -- test/e2e/admin.e2e.test.ts
npm run test:e2e -- test/e2e/public.test.ts
npm run test:e2e -- test/e2e/volunteer.e2e.test.ts
```

Expected: all targeted e2e suites pass.

- [ ] **Step 3: Run local seed media smoke**

```bash
npm run db:migrate:local
npm run db:seed:local
npm run db:seed-media:local
npm run dev
```

Expected: local homepage, events, ministries, and profile/admin pages show seeded images through `/media/uploads/...`.

- [ ] **Step 4: Commit verification fixes if needed**

```bash
git status --short
git add <changed-files>
git commit -m "fix: polish seeded media workflow"
```

Only commit if verification required fixes.

---

## Self-Review

- Spec coverage: hero image, profile avatars, admin person avatars, ministry covers, seeded event images, media script, upload validation, docs, and verification are all mapped to tasks.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: media keys are `uploads/...`, public image paths are `/media/uploads/...`, and avatar values are stored as public paths while event/ministry/hero store raw keys.
