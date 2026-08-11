# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Plain static HTML on Cloudflare Workers — no build step, no framework. `src/index.js` routes `/api/lead` to `functions/api/lead.js` and serves everything else from static assets (see `wrangler.jsonc`).
- Each page is a directory with its own `index.html` (`pricing/`, `green-trail/`, `blue-trail/`, `black-trail/`, `pro-bono/`, `brand/`, `logo/`, `design-system/`, plus root `index.html`). Every page carries its own inline `<style>` with the `:root` token block copied verbatim — keep that block byte-identical across all pages (diff it after any token change) and cross-check `design-system/index.html` as the canonical token reference.
- Local dev: `npx wrangler dev` serves the whole site including `functions/api/lead.js`; verify new routes with `curl -o /dev/null -w '%{http_code}' <url>` and check `.assetsignore` doesn't exclude a new directory.
- Sharp edge: don't combine the `hidden` attribute with an inline `style="display:..."` on the same element — the inline style wins the cascade and the element stays visible regardless of `hidden`/`.hidden` in JS. Toggle visibility via `element.style.display` (or a CSS class) instead.
- Sharp edge: any `display:grid` with fixed/`fr`-only (non-`auto-fit`) column tracks needs a class hooked into the page's `@media (max-width:960px)` block (e.g. `.g2,.hero,.terms{grid-template-columns:1fr!important}`) or it silently causes horizontal overflow at 375px — `minmax(0,1fr)` tracks and `repeat(auto-fit,minmax(Npx,1fr))` are safe without one.
- Nav/footer link targets across the 5 pages are hand-resolved (no router): sub-pages use `../` to reach root anchors like `../#book`, `../#training`.
- Sharp edge: `design-system/index.html`, `brand/index.html`, and `logo/index.html` carry responsive rules keyed to literal style strings, e.g. `[style*="font:800 64px"]{...!important}` inside `@media (max-width:960px)`. Grep a file for `style*=` before changing any declaration it might match — an edit that changes the matched substring breaks mobile sizing silently.
- The four internal-only pages (`brand/`, `logo/`, `design-system/`, `pro-bono/`) share a thin dark utility bar (`background:#0E1729`) cross-linking each other, documented under design-system's "07 — Navigation & Footer" section: Archivo wordmark, mono links — same split as the primary nav pattern.
- `pro-bono/doc-page.js` is a copied upstream print/paginated-document component (carries `@ds-adherence-ignore`) — do not edit it; page-specific content and styling belongs in `pro-bono/index.html`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
