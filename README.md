# switchbackstrategy.ai

Static marketing site for Switchback Strategy LLC, served by **Cloudflare Pages**.
The lead form posts to a Pages Function that writes into HubSpot.

```
site/
  index.html            landing page (no build step — plain HTML + inline styles)
  pro-bono/             pro bono flyer — public, indexed, print-ready
  design-system/        brand guidelines — noindex
  logo/                 mark specimen sheet — noindex
  brand/                voice & style guide — noindex
  assets/               logo mark, OG image
  functions/api/lead.js POST /api/lead → HubSpot
  _headers              security + caching headers
  robots.txt, sitemap.xml
```

## Deploy

1. Push this repo to `allen-at-switchback-strategy/website` on `main`.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**, pick the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `site`
4. Deploy. Every push to `main` ships; PRs get preview URLs automatically.

## Custom domain

Pages → your project → **Custom domains → Set up a domain** → `switchbackstrategy.ai`.
If the domain's nameservers are already on Cloudflare, the DNS record is created for you and
TLS provisions in a few minutes. Add `www.switchbackstrategy.ai` too and let Cloudflare
redirect it to the apex.

## Environment variables

Pages → Settings → **Variables and Secrets**. Set for both Production and Preview:

| Name | Required | What |
| --- | --- | --- |
| `HUBSPOT_TOKEN` | yes | Private app token (encrypted) |
| `HUBSPOT_NEWSLETTER_LIST_ID` | no | Static list id for the newsletter opt-in |

## HubSpot setup (once)

1. **Private app** — HubSpot → Settings → Integrations → Private Apps → Create.
   Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`,
   `crm.objects.notes.write`, and `crm.lists.write` if you use the list.
   Copy the token into `HUBSPOT_TOKEN`.
2. **Custom contact properties** — Settings → Properties → Contact properties → Create:
   - `sbs_recommended_trail` — single-line text
   - `sbs_commercialization_goal` — multi-line text
   - `sbs_newsletter_optin` — single checkbox
3. **Workflow for the thank-you + nurture** — Automation → Workflows → contact-based,
   enrolment trigger `sbs_recommended_trail is known` *and* `Create date is in the last 1 day`.
   Actions: send the thank-you email, then branch on `sbs_recommended_trail` so the
   follow-up copy matches the trail the form recommended. This is where the personalized
   messaging lives — the function only records the signal.
4. **Newsletter** — Marketing → Lists → create a static list, put its id in
   `HUBSPOT_NEWSLETTER_LIST_ID`.

The function returns a personalized confirmation string that the page renders inline, so the
visitor sees the recommendation immediately even before HubSpot's email lands.

## Local development

```
npx wrangler pages dev site
```

Put `HUBSPOT_TOKEN=...` in a `.dev.vars` file at the repo root (git-ignored) to exercise the
function locally.

## Editing content

`index.html` is hand-editable — every style is inline, colors come from the `:root` custom
properties at the top. Two notes:

- The dark **stat band** (`50B+`, `$6M+`, …) is `<section id="stat-band">`. To hide it, uncomment
  `/* #stat-band{display:none} */` in the `<style>` block near the top — one line, nothing else
  moves. To change a number, edit the cell's big `<div>`; to add a fifth, copy one cell `<div>` and
  change `repeat(4,1fr)` to `repeat(5,1fr)` in the section's own `style`. Beyond five, use
  `repeat(3,1fr)` and let it wrap to two rows.
- Photography is currently hatched placeholders with a note describing the intended shot.
  Replace each placeholder `<div>` with an `<img src="/assets/...">` when the real photos exist.

## Indexing

Only `/` and `/pro-bono/` are in the sitemap. The three brand-reference pages carry
`<meta name="robots" content="noindex,nofollow">` — they are reachable by URL but stay out of
search results. They are internal guidelines published for convenience, not marketing pages.

Two things to review before sharing those URLs widely:

- **Brand Voice section 07** documents terms retired because of name collisions with a large CRM
  vendor's vocabulary, and explains why. That is sound internal guidance and awkward public
  reading. Consider cutting the section from the published copy.
- **Tagline** — the published pages all now read "Pivot. Perfect. Ascend.", matching the design
  tokens. Drafts elsewhere carried "Position" and "Protect"; if either of those is actually the
  real one, say so and it changes in one pass. The `.dc.html` sources still hold the open question.

The design source of truth is the Switchback Strategy design system (Landing Page, Logo System,
Brand Voice, Design System, Pro Bono Flyer). Regenerate from there rather than
back-porting large edits by hand.
