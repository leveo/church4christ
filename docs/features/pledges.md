# Pledges (faith pledge campaigns)

> **Optional, and off until you turn it on.** Pledges works on the default Cloudflare D1
> database and on Supabase (Postgres). It needs no payment provider: a pledge is a promise of
> what someone plans to give, not a payment.

## What it does

When a church raises money for something big, such as a building, a new ministry, or a mission
field, it often asks people to pray and then make a **pledge**: how much they plan to give, how
often, and over how long. **Pledges** puts that whole process online, and still handles the paper
cards people hand in on Sunday.

- **Campaigns.** Each campaign has a title and introduction in every site language, a **giving
  period** (the first and last day a planned gift can fall on), an optional **pledge period**
  (when the online form takes pledges), a longest plan in months, an amount goal, a household
  goal, and an optional **gift guide** (for example "2 households × $50,000").
- **The public form.** People choose whether they are entering a total or each gift, how often
  they will give (one time, monthly, quarterly, yearly, or every few months), for how many
  months, and when to start. The page shows the plan as they type, for example "$100.00 monthly,
  36 gifts from Jan 1, 2027 to Dec 1, 2029". They sign by typing their full name and confirm the
  pledge.
- **A code for each pledge.** Every pledge gets an eight-letter code, such as `KQWMTRZB`. It is
  shown on screen and in the confirmation email. To add to a pledge later, a person enters that
  code with the same email address, and the new pledge is linked to the first one.
- **Confirmation email.** Sent in the person's language with the code, the total and the plan.
  If the email is delayed, the pledge is still saved, and staff can send it again.
- **Paper cards.** Staff enter a card in a few fields. Email, signature and consent are optional
  for a card, and no email goes out until staff choose to send one.
- **Progress.** Each campaign has a dashboard: the amount pledged against the goal, households
  against the household goal, households at each gift-guide level, planned gifts per year, and
  what the past 7 days added.
- **Records and history.** Staff can edit a pledge (the plan is recalculated), archive it,
  restore it, and export everything to CSV. Every change is written to the record's history with
  the administrator's email. The history lists which fields changed, never their old values.

Planned gifts are intentions. Nothing is charged, and the dashboard never calls them income.

### With Giving turned on: track what is actually given

Pledges works on its own. If your site also uses [Giving](giving.md) (which needs the Supabase
database), you can link a campaign to a **giving fund**, for example "Building fund":

- The public pledge page, the thank-you panel and the confirmation email offer **Give online**,
  which opens the give page with that fund already chosen.
- The campaign dashboard adds **Real giving**: what pledging households have actually given,
  everything given to the fund during the campaign, and how many households are **Fulfilled**,
  **On track**, **Behind**, or have **No email to match**.
- Each pledge shows its household's giving: given, due by today, and pledged. The CSV export adds
  the same columns.

Gifts are matched to a household by email: the email of the signed-in person who gave, or the
email on the gift. A first pledge and the pledges that add to it are one household, so a gift is
never counted twice. A paper card without an email cannot be matched until you add one. Giving
uses its own rules here too: only completed gifts, minus refunds, in the campaign's currency, from
when pledging opened (or giving starts, if earlier) to the end of the giving period. Use a fund
kept for this campaign only, or other giving to that fund is counted as well.

Actual gift amounts are finance information. Only people who can open **Giving** themselves (the
Giving area or the finance role) see them; others with the Pledges area see pledged amounts only.
If Giving is turned off later, the link is kept and simply hidden until it is back on.

## How your team uses it

### Turn it on

1. A super admin opens **Settings → Modules**, ticks **Pledges**, and saves. Pledges is off by
   default: no setup preset includes it, and upgraded sites keep it off until someone turns it on.
2. Optional: under **Public dates** on the same card, choose **Public from** and **Public until**.
   Outside those dates the public pledge pages and their menu link are hidden. The admin pages stay
   open, so the team can set up a campaign before it starts and follow up after it ends.
3. Give staff access: a super admin opens a person in **People** and ticks the **Pledges** area.
   Pledge records hold personal details, so only administrators with this grant (and super admins)
   can open them.

### Create a campaign

1. Open **Pledges** in the admin menu and choose **New campaign**.
2. Write the title and introduction. Each language has its own tab.
3. Set the web address (for example `room-to-grow`), the giving period, the longest plan, the goals,
   and the gift guide, one row per line such as `10 x 10000`.
4. Leave the status as **Draft** while you prepare. Choose **Published** when it is ready. The
   public page is `/en/pledge/room-to-grow` (or the same path in any site language). With only one
   published campaign, `/en/pledge` opens it directly.

The pledge page is not added to the main menu automatically. Add it under **Navigation** if you
want it there, or share the link in the bulletin and on screen.

### Enter a paper card

On the campaign dashboard choose **Add a paper pledge**, type what the card says, and save. If the
card adds to an earlier pledge, choose **An addition to an earlier pledge** and enter its code.
If the card has an email address, open the record and choose **Send confirmation**.

### Follow up

The campaign dashboard shows the progress cards and the list of pledges. Open a record to see its
planned gifts and history, edit it, archive it, or send its confirmation. **Export CSV** downloads
every pledge with its planned gifts.

## How it fits together

1. A person fills in the form. The server checks every field and calculates the plan again from
   scratch, so what is stored never depends on the browser.
2. The pledge, one row per planned gift, and the first history entry are saved together. A pledge
   never exists without its schedule.
3. A reload or double click sends the same hidden form key, so it shows the same pledge instead of
   saving a second one. The same key with different details is refused.
4. The confirmation email is sent and its result is recorded on the pledge.

To limit abuse, the form has a hidden field that catches simple bots, and each email address can
send five online pledges a day.

## For developers

- **Module:** `pledges` in `config/capabilities.json` (group `community`, `schedulable: true`, no
  `requiresBackend`). Public prefix `/pledge`; admin prefix `/admin/pledges` (route class
  `adminOnly`, area `pledges` in `src/lib/adminAreas.ts`).
- **Migrations:** D1 `migrations/0055_pledges.sql`, Postgres `migrations-supabase/0047_pledges.sql`.
  Tables: `pledge_campaigns`, `pledge_campaign_i18n`, `pledges`, `pledge_installments`,
  `pledge_events`. No table references `people(id)`; staff actions store the admin's email as text.
  The migration writes `module.pledges = 0` on an existing installation.
- **Code:** `src/lib/pledgePlan.ts` (pure plan math in integer cents, also used by the browser
  preview), `src/lib/pledgeForms.ts` (form parsing), `src/lib/pledgeDb.ts` (data layer and goal
  progress), `src/lib/pledgeNotify.ts` (confirmation email).
- **Giving link:** `pledge_campaigns.fund_id` (nullable, no foreign key: D1 has no `funds`
  table). `src/lib/pledgeGiving.ts` matches gifts per household (pure `matchPledgeGiving`) and
  `loadPledgeGiving` returns null before any query unless the caller says Giving is on, so D1 never
  reaches the giving tables. The gift query is `fundGiftsByGiver` in `src/lib/givingDb.ts`, sharing
  Giving's effective-date, refund and test-mode rules. The editor only renders the fund picker while
  Giving is on; a save without the field keeps the stored link. `/give?fund=<id>` preselects an
  active fund and keeps it through the sign-in link.
- **Pages:** `src/pages/[locale]/pledge/`, `src/pages/admin/pledges/`.
- **Tests:** `test/pledgePlan.test.ts`, `test/pledgeDb.test.ts`, `test/pledgeGiving.test.ts`,
  `test/pledgesMissionsCampus.test.ts`, `test/pg/pledgeGiving.test.ts` (real Postgres),
  `test/node/pledgesMissionsMigrationDefault.test.ts`.
- Not included: payment collection, handwritten (drawn) signatures, PDF receipts, and scanning
  paper cards. A typed name is the online signature; the card itself is the signed record.
