# Missions (a map and timeline of mission trips)

> **Optional, and off until you turn it on.** Missions works on the default Cloudflare D1
> database and on Supabase (Postgres). Photos use the site's existing image storage.

## What it does

Many churches send teams out every year, near and far. **Missions** gives those trips a home on
the website, so members and visitors can see where the church has gone and read the stories.

- **A world map** with a pin for each trip. Hover or tab to a pin to see its name, place and
  year; select it to open the story. The map is a plain page element, so it works without
  JavaScript and on any phone.
- **Headline numbers:** how many trips, how many countries, and the span of years.
- **A year filter** and **a timeline** of trip cards, newest year first.
- **A story page for each trip:** cover photo, dates, place, team size, who went, the story,
  a photo gallery, and an optional YouTube film. The film loads only when a visitor chooses to
  watch it.
- **Every site language.** Title, place, summary, story and "who went" each have a tab per
  language. A missing translation falls back to the site's default language, then English.

### Support a mission with Giving

Missions works on its own. If your site also uses [Giving](giving.md) (which needs the Supabase
database), choose a **giving fund** on a trip, for example "Missions" or a fund just for that
trip. Its story page then shows **Support this mission**, which opens the give page with that fund
already chosen, so gifts go through the same online giving (Stripe) and statements as everything
else. If the fund is turned off in Giving, the button disappears.

### Sensitive places

Some trips go to places where showing the location could put partners at risk. Leave the
**latitude and longitude empty** for such a trip. It is still listed in the timeline, with
whatever place name you choose (for example "East Asia"), but it gets no pin on the map. Only
**Published** trips ever appear publicly. A draft's text and photos are never sent to a public page.

## How your team uses it

### Turn it on

1. A super admin opens **Settings → Modules**, ticks **Missions**, and saves. Missions is off by
   default: no setup preset includes it, and upgraded sites keep it off until someone turns it on.
2. Optional: under **Public dates** on the same card, choose when the public pages show. Outside
   those dates the mission pages and their menu link are hidden. The admin pages stay available.
3. Editors can manage trips. To let another administrator do it, a super admin ticks the
   **Missions** area on that person in **People**.

When the module is on, **Missions** appears in the main menu under **Connect**.

### Add a trip

1. Open **Mission trips** in the admin menu and choose **New trip**.
2. Write the title, the place to show, a short summary and the story (Markdown).
3. Set the web address, the year, and the dates if you have them. Add the team size and a note
   such as "Led by Pastor Lee" if you want them shown.
4. For a map pin, enter the country code (for example `GH`) and the latitude and longitude. Any
   map site shows them when you select a place.
5. Optional: paste a YouTube link and choose a cover photo.
6. Save as **Draft**, check it, then change the status to **Published**.

After the first save, the trip page also lets you upload gallery photos (up to 24), remove a
photo, remove the cover, or delete the trip. Deleting a trip removes it and its gallery list;
the uploaded files stay in the media library.

The public page is `/en/missions` (or the same path in any site language).

## How it fits together

Trips live in the database with one text row per language. The public page reads published trips
only, works out the headline numbers, and places each pin from its latitude and longitude on a
world outline. The outline is a single image drawn in the theme's colors, so the map follows the
site's light and dark themes.

## For developers

- **Module:** `missions` in `config/capabilities.json` (group `content`, `schedulable: true`,
  nav key `nav.missions`). Public prefix `/missions`; admin prefix `/admin/missions` (route class
  `console`, area `missions`; pages allow editors or the area grant).
- **Migrations:** D1 `migrations/0056_missions.sql`, Postgres `migrations-supabase/0048_missions.sql`.
  Tables: `mission_trips`, `mission_trip_i18n`, `mission_trip_photos`. The migration writes
  `module.missions = 0` on an existing installation.
- **Code:** `src/lib/missionDb.ts`, `src/lib/missionForms.ts`, `src/lib/missionMap.ts` (pin
  projection, country names from `Intl.DisplayNames`, headline numbers).
- **Map outline:** `public/images/missions/world-land.svg`, used as a CSS mask so its color comes
  from the design tokens. It is generated once by `scripts/missions/build-world-map.mjs` from
  world-atlas `land-110m` (ISC license, Natural Earth public-domain data) in an equirectangular
  projection; `projectPin` uses the same formula. No map library ships to the browser or Worker.
- **Giving link:** `mission_trips.fund_id` (nullable, no foreign key: D1 has no `funds` table),
  read through `linkedGivingFund` only while Giving is on and the fund is active.
- **Pages:** `src/pages/[locale]/missions/`, `src/pages/admin/missions/`.
- **Tests:** `test/missions.test.ts`, `test/node/pledgesMissionsMigrationDefault.test.ts`.
