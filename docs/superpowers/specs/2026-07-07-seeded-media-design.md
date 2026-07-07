# Seeded Media and Editable Images Design

## Summary

Local demo data should look richer by default and still behave like real church-managed content. The seed flow will provide warm documentary-style images for the homepage hero, event inserts, ministry covers, and profile avatars. Those images will use the existing media pipeline: files are stored in the R2 `MEDIA` bucket under `uploads/...`, registered in the `media` table, and served through `/media/<key>`.

The editable surfaces will follow existing product boundaries:

- Admin settings owns the homepage hero image.
- Admin events already owns event insert images.
- Admin ministry management owns ministry cover images.
- A member's profile page owns their own avatar.
- Admin people detail owns staff/member avatar edits by administrators.

## Goals

- Generate a compact Warm Documentary seed image pack for local testing.
- Make the homepage hero image editable from the admin portal.
- Let signed-in users update or remove their own profile picture.
- Let admins update or remove a person's profile picture from the people admin page.
- Seed event and ministry image references so public pages display real images out of the box.
- Reuse the current upload security model, file validation, and `/media/` delivery route.

## Non-Goals

- No new image CDN or third-party media service.
- No schema migration unless implementation proves an existing column or setting is insufficient.
- No image cropping editor in this pass. Uploaded images will rely on object-fit display rules.
- No native SVG uploads. The existing upload rules continue to reject SVG as an inline-safe format.

## Image Style

The selected visual direction is Warm Documentary:

- Natural church-life photography.
- Warm light and welcoming composition.
- Realistic subjects and spaces suitable for a bilingual local church demo.
- No visible real church branding, third-party logos, or watermarks.

Planned generated assets:

- 1 homepage hero background.
- 3 event insert images matching the existing seeded events.
- 6 ministry cover images for the first six seeded ministries.
- 8 profile/avatar portraits for seeded people.

## Data Model

The design reuses current fields where possible:

- `events.image_key` stores an R2 media key such as `uploads/<hash>-summer-bible-camp.webp`.
- `ministries.cover_key` stores an R2 media key.
- `people.avatar_url` stores the displayed avatar reference. For consistency with existing media serving, new avatar uploads should be stored as `/media/<key>` or a media key normalized by the render helper.
- `settings` gains `site.hero_image_key` as a key/value setting for the homepage hero media key.

The `media` table remains the registry for uploaded/generated media metadata.

## Seed Flow

Seeded image files will live in a repo-owned seed asset folder so they are available without regenerating images every time. A seed media script will:

1. Read the seed asset manifest.
2. Upload each image into local R2 using the same content-addressed key format as `uploadKey`.
3. Register each image in the `media` table with `registerMedia`.
4. Update seeded rows/settings with the resulting keys.

The SQL seed remains responsible for core relational demo data. The image seed script handles R2 object writes because SQL alone cannot populate R2.

The local setup path should document that prettier local demos require both:

```sh
npm run db:seed:local
npm run db:seed-media:local
```

If the media script runs more than once, content-addressed keys and upserts should make it safe and idempotent.

## Admin Hero Image

The admin settings page will add a hero image control in the appearance area:

- Current image preview when `site.hero_image_key` exists.
- File input for replacement.
- Remove checkbox to clear the setting.
- Same validation as event images: allowed image content types and max size.

`Hero.astro` will read `site.hero_image_key`:

- When present, render the image as a full-width background with the current heading, subtitle, and CTA overlay.
- Keep a scrim/gradient so text remains readable.
- When absent, fall back to the current abstract SVG hero.

## Profile Avatar Editing

The signed-in `/profile` page will add avatar controls to the identity form:

- Current avatar preview or initials fallback.
- File input for replacement.
- Remove checkbox.
- Uploads use the existing R2/media pipeline.
- Only the signed-in user's own `people.avatar_url` can be changed.

The admin people detail page will expose equivalent controls for admins editing any person.

Rendering should normalize avatar references so both existing absolute paths and new `/media/<key>` references display correctly. If the avatar value is empty, existing initials fallbacks remain.

## Ministry Cover Editing

Ministry covers already have `ministries.cover_key`, but the current admin ministry form does not expose image editing. Seeded covers will populate that field for the first six seeded ministries. The ministries admin tab will add a focused upload/remove control using the same file handling pattern as admin events.

Public ministry cards/detail pages should render `/media/<cover_key>` when present and keep current placeholder styling when absent.

## Event Images

Admin events already support upload, removal, and public display via `/media/<key>`. This work will seed `events.image_key` values for the three demo events and leave the existing editing workflow intact.

## Validation and Security

All new uploads will reuse:

- `ALLOWED_IMAGE_TYPES`.
- `MAX_IMAGE_BYTES`.
- `uploadKey`.
- `registerMedia`.
- R2 `MEDIA.put` with stored content type metadata.

The `/media/` route remains the only public delivery path for uploaded images and continues to restrict keys to the `uploads/` namespace.

## Testing

Focused tests should cover:

- The seed contains media-backed event/ministry/profile/hero references.
- `getSiteIdentity` or a new small helper returns the hero image key without breaking existing settings reads.
- Hero rendering includes `/media/<key>` when seeded and keeps the SVG fallback when unset.
- Profile avatar upload rejects invalid type/oversized files and saves a valid image for the signed-in user.
- Admin person avatar upload saves a valid image for the selected person.
- Existing event upload tests continue to pass.

## Rollout

Implementation should be incremental:

1. Add seed assets, manifest, and media seeding script.
2. Wire seeded event, ministry, avatar, and hero references.
3. Add hero image read/render and admin settings upload UI.
4. Add profile/admin-person avatar upload UI.
5. Add ministry cover upload UI.
6. Run unit and relevant e2e tests, then visually verify the local homepage and profile/admin pages.
