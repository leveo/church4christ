# Single-feature editions

Church4Christ is one codebase with switchable modules. Some churches look for a single tool
first: a kids check-in kiosk, volunteer scheduling, small groups, or a church website.
Single-feature editions are small public repositories that meet them there. Each one
describes one setup preset and installs a pinned release of this repository with only that
preset's features turned on.

| Edition repository | Preset | Features |
|---|---|---|
| [`church-checkin`](https://github.com/leveo/church-checkin) | `checkin` | People & Households, Children Check-in |
| [`church-volunteer-scheduling`](https://github.com/leveo/church-volunteer-scheduling) | `volunteer-scheduling` | Volunteer Scheduling, Spiritual Gifts, People & Households |
| [`church-small-groups`](https://github.com/leveo/church-small-groups) | `small-groups` | Groups, Fellowships, People & Households |
| [`church-website-cms`](https://github.com/leveo/church-website-cms) | `website` | The website preset |

## What an edition contains

Editions contain no application code. Each repository holds a README, an `AGENTS.md` for
coding agents, the GPL v3 license, an `edition.json` with its pinned version and metadata,
and an issue-template config that sends issues to this repository. Screenshots and
documentation links point into this repository at the pinned release tag.

Installing an edition gives a church the full Church4Christ codebase at that release. An
administrator can turn on other modules later in **Settings → Modules**, and upgrades follow
the normal [upgrade guide](upgrade.md).

## Where editions are defined

- `config/capabilities.json` defines the presets. Once released, a preset's module list
  must not change, because installations record it in their setup manifest; add a new
  preset instead.
- `config/editions.json` holds each edition's repository name, preset, README copy (English
  and Chinese), screenshots, documentation links, demo instructions, description, and topics.
  Describe only capabilities the software has, and state limits plainly.
- `node scripts/editions/render.mjs --all <dir>` renders every edition, pinned to the
  `package.json` version, into `<dir>/<repo>/`. `test/node/editions.test.ts` checks the
  config and the rendered files.

## Publishing after a release

After a release tag exists, render the editions and publish each one:

1. Render into a scratch directory: `node scripts/editions/render.mjs --all <dir>`.
2. For each edition, clone its repository, replace the files with the rendered set, and
   commit only if something changed (`docs: pin edition to vX.Y.Z`). Push without force.
3. Keep repository metadata in sync with `edition.json`:
   `gh repo edit leveo/<repo> --description "…" --homepage "…" --add-topic …`.

A new edition repository is created once with `gh repo create leveo/<repo> --public`, then
published the same way. Turn off its wiki and projects; issues stay on so the contact links
show, and the template sends people to this repository.
