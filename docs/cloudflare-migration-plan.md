# Switchback Strategy → Cloudflare Worker + grounded agent

## Context

`switchbackstrategy.ai` is a hand-written static site (no build step) currently deployed via **Cloudflare Pages**, with one Pages Function (`functions/api/lead.js`) that writes leads into HubSpot. Two things need to happen:

1. **The deploy config is broken.** `README.md` documents a build output directory of `site/`, but every asset lives at the repo root and `site/` contains only a stray `.DS_Store`. Deploying as documented would ship an empty directory.
2. **Add a grounded conversational agent** to the landing page, reusing the proven pattern from `allenhoem.com` (the `allenhoem-agent-worker` repo): a Cloudflare Worker that holds the Anthropic key, injects a grounding corpus, rate-limits, and streams SSE straight to the browser.

The move from Pages to a **single Worker with Static Assets** is what makes this coherent: one project, one `wrangler.jsonc`, one atomic deploy, no CORS, and a path to Durable Objects later if the agent ever needs server-side session state. Cloudflare's current guidance is that new projects start on Workers, not Pages.

### Answering the design question: "should I use Cloudflare AI chat / Project Think instead? Is agent chat just embedding SDKs?"

**No — keep the proxy pattern. Your instinct is right, and here's the precise reason.**

The allenhoem worker is not an agent loop. It makes exactly **one** `fetch` to `api.anthropic.com` and pipes the SSE body through. The tool-calling loop runs **on Anthropic's servers** via the MCP connector (`mcp_servers` + `mcp_toolset`, beta `mcp-client-2025-11-20`). That single design choice is why the Worker never accumulates subrequests, never burns CPU, needs no Durable Object, and fits in ~200 lines with zero dependencies.

Cloudflare's Agents SDK / Project Think / `@cloudflare/ai-chat` buy you a Durable Object per conversation: server-side persistence, resumable streams across reconnect and device, sub-agents, scheduled background agent work, human-in-the-loop gates. Real capabilities — but every one of them is about the agent **outliving the request**. A landing-page chat that answers in 5–20 seconds, where the browser holds history in `sessionStorage` and replays it each turn, needs none of it. Adopting Think here would mean a framework dependency, a build step on a site that currently has none, a paid-plan requirement for DO, and moving the tool loop into your Worker where subrequest and CPU limits start to matter.

So: substantially yes, at this scale it *is* mostly SDK plumbing you don't need. The proxy is the more effective, scalable, and composable design **for a marketing-site agent**. Revisit Think when a specific requirement forces it — a logged-in SaaS assistant that must survive a dropped connection, or background agent work. The seam that makes that swap cheap is keeping `src/chat.ts` behind a stable `POST /api/chat` contract.

---

## Target architecture

```
switchbackstrategy.ai              → one Worker
  ├── static assets (public/)      → landing page, pro-bono, brand pages
  ├── POST /api/lead               → HubSpot (ported from Pages Function)
  └── POST /api/chat               → SSE proxy to api.anthropic.com
```

Same origin throughout — the CORS machinery in the allenhoem worker (`ALLOWED_ORIGINS`, `corsHeaders`) is **deleted**, not ported. It only existed because that site is on GitHub Pages talking cross-origin to `*.workers.dev`.

**Confirmed decisions:**
- **Agent scope:** grounded Q&A + hand-off. The agent answers questions and, when a visitor is ready, recommends a trail and scrolls them to the existing `#book` form with the goal textarea pre-filled. **No tools, no MCP server.** `/api/lead` stays the single write path into HubSpot.
- **Model:** `claude-sonnet-5` only, `thinking: {type: "disabled"}`, `max_tokens: 2048`. No `SUBSTANTIVE_RE` regex router.

---

## Two bugs to fix while porting (do not copy these forward)

**1. Truncation on Sonnet 5.** The allenhoem worker sends `max_tokens: 1024` with no `thinking` field. On `claude-sonnet-5`, omitting `thinking` now runs **adaptive thinking by default**, and `max_tokens` is a hard cap on thinking **plus** answer text. Answers can truncate mid-sentence with `stop_reason: "max_tokens"`. Fix: set `thinking: {type: "disabled"}` explicitly and raise `max_tokens` to 2048. (Also note `claude-sonnet-5` rejects non-default `temperature`/`top_p`/`top_k` — don't add them.)

**2. Prompt-cache minimums are model-specific.** Sonnet 5 requires a **1024-token** minimum cacheable prefix; Haiku 4.5 requires **4096**. Below the threshold the request silently doesn't cache — no error, just `cache_creation_input_tokens: 0`. The grounding corpus must comfortably exceed 1024 tokens (it will), and `cache_control` goes on the **last** system block.

**3. KV rate limiting races.** The allenhoem `checkRateLimit` does a read-then-write increment against eventually-consistent KV. Fine at portfolio scale, wrong for a commercial endpoint. Use Cloudflare's native **rate limiting binding** for burst control — but note it only supports **10s or 60s** periods, so keep a KV counter for the daily global cap.

---

## Target repo layout

```
wrangler.jsonc              new — Worker + assets + bindings
package.json                new — wrangler devDependency, scripts
.gitignore                  new — .dev.vars, node_modules, .DS_Store
public/                     moved from repo root
  index.html                + agent panel markup & client script
  pro-bono/                 index.html, doc-page.js
  brand/, design-system/, logo/
  assets/                   mark.svg, mark-light.svg, og.png
  _headers                  security + caching (verify support, see Risks)
  robots.txt, sitemap.xml
src/
  index.ts                  router: /api/lead, /api/chat, else ASSETS
  lead.ts                   ported from functions/api/lead.js
  chat.ts                   SSE proxy (ported from allenhoem src/index.js)
  persona.ts                SYSTEM_PERSONA for Switchback
  grounding.ts              GENERATED — do not edit
  ratelimit.ts              rate-limit binding + KV daily cap
content/                    grounding source of truth (new)
  services.md, approach.md, trails.md, pricing.md, faq.md, pro-bono.md
scripts/build-grounding.mjs adapted from allenhoem
```

**Deleted:** `functions/` (compiled into `src/lead.ts`), `site/` (empty but for `.DS_Store`), all `.DS_Store` files.

---

## Implementation

### Phase 1 — Restructure to a Worker (no behavior change)

1. Create `package.json` (`wrangler` ^4, `type: module`, scripts `dev`/`deploy`/`build:grounding`) and `.gitignore` (`.dev.vars`, `node_modules`, `.DS_Store`).
2. `git mv` all site assets into `public/`. Delete `site/` and every `.DS_Store`. Asset paths in `index.html` are already relative (`assets/mark.svg`) and need no edit.
3. Port `functions/api/lead.js` → `src/lead.ts`. The logic is sound — keep `recommendTrail()`, `SIGNALS`, `SIZE_TRAIL`, `TRAIL_LINE`, the honeypot check, and the 409-conflict upsert path **unchanged**. Only the signature changes: `onRequestPost({request, env})` → an exported `handleLead(request, env)`. Export `recommendTrail` and `TRAIL_LINE` — Phase 3 reuses them.
4. Write `src/index.ts`: route `POST /api/lead` → `handleLead`, `POST /api/chat` → `handleChat`, everything else → `env.ASSETS.fetch(request)`.
5. Write `wrangler.jsonc`: `main: "src/index.ts"`, `assets: {directory: "./public", binding: "ASSETS"}`, `compatibility_date: "2026-07-01"`.
6. **Deploy to `*.workers.dev` first and verify the whole site renders and the lead form still works.** Do not move the custom domain yet.

**Trail taxonomy (as of Services & Pricing v2, `24204a8`):** the canonical set is **Green Trail**, **Blue Trail**, **Pro-Line**, and **Team AI Training Workshop**, and it is already consistent across `functions/api/lead.js`, `index.html`, and `design-system/index.html`. Use exactly these names in the grounding corpus. Note "Trailmap" still appears in `index.html` — it refers to the free intro session ("one free hour"), **not** a paid tier; keep that distinction in the grounding copy or the agent will offer a Trailmap as though it were an engagement level.

### Phase 2 — Grounding pipeline

1. Author `content/*.md` as the agent's source of truth: what Switchback does, the trail taxonomy and what each engagement includes, how pricing works (fixed fee, never hourly), the approach, the pro-bono program, and an FAQ. Target **well above 1024 tokens** so prompt caching engages.
2. `scripts/build-grounding.mjs` — adapt from `allenhoem-agent-worker/scripts/build-grounding.mjs`. Reuse its `htmlToText()` helper verbatim (it already strips tags, decodes entities, and pipe-delimits tables) to pull the landing-page copy from `public/index.html` so the agent can't drift from what a visitor is reading. Concatenate `content/*.md` + extracted landing-page text, emit `src/grounding.ts` as a single exported string constant.
3. Never hand-edit `src/grounding.ts`; regenerate and redeploy when content changes.

### Phase 3 — The chat endpoint

`src/chat.ts`, ported from `allenhoem-agent-worker/src/index.js` with these deltas:

| Keep | Change |
|---|---|
| `validateMessages()` — ≤16 msgs, ≤4000 chars, first/last must be `user` | Delete `ALLOWED_ORIGINS` / `corsHeaders()` entirely (same-origin now) |
| SSE passthrough: `new Response(upstream.body, {...})` | Delete `pickModel()` / `SUBSTANTIVE_RE` — Sonnet 5 only |
| `cache_control: {type: "ephemeral"}` on the grounding system block | Delete `mcp_servers` / `tools` — no MCP server for Switchback |
| `logQuestion()` via `ctx.waitUntil` to KV under `q:` prefix | Add `thinking: {type: "disabled"}`, `max_tokens: 2048` |
| Upstream-error mapping (429 → 429, else 502) with a generic client message | Replace KV read-then-write limiter with the rate-limit binding + KV daily cap |

Request shape:

```ts
{
  model: "claude-sonnet-5",
  max_tokens: 2048,
  thinking: { type: "disabled" },
  stream: true,
  system: [
    { type: "text", text: SYSTEM_PERSONA },
    { type: "text", text: `<reference_material>\n${GROUNDING}\n</reference_material>`,
      cache_control: { type: "ephemeral" } },
  ],
  messages,
}
```

`src/persona.ts` — model the system prompt on the allenhoem persona, but for Switchback: ground strictly in the reference material; stay on Switchback's services, trails, and approach; decline unrelated requests in one sentence; **never invent pricing or delivery commitments**; when a visitor seems ready to engage, recommend a trail and tell them to use the form below rather than collecting contact details in chat; no hype, no AI clichés.

### Phase 4 — The panel UI

Port the client from the uploaded `allenhoem.com/index.html` (lines ~857–1092). It is well-built and should be reused nearly wholesale — `sessionStorage` persistence, `escapeHtml()` before `formatText()`, the SSE reader loop matching `content_block_delta` / `text_delta`, the interrupted-stream salvage in `catch`, and the busy/disabled states are all correct as written.

Changes:
- **Restyle to the Switchback design system.** The source panel uses Tailwind utility classes; `index.html` here uses inline styles and `:root` custom properties (`--sbs-paper`, `--sbs-ink`, `--sbs-accent`, Archivo / Public Sans / IBM Plex Mono). Rewrite the class strings as inline styles using those tokens — do not introduce Tailwind.
- `ENDPOINT` becomes the relative `'/api/chat'` — no localhost/production branch, no absolute URL.
- Replace `SUGGESTIONS` with Switchback chips (e.g. "How does a Trailmap session work?", "What does an engagement cost?", "We're 80 people — where do we start?").
- Replace the `gtag` calls in `track()` with a no-op or your analytics of choice; strip the allenhoem GA tag.
- Swap `allen.hoem@gmail.com` for `allen@switchbackstrategy.ai` in every error string.
- **Add the hand-off:** a "Take me to the form" affordance that scrolls to `#book` and pre-fills `#f-goal` from the conversation. The form's existing submit path is untouched.

### Phase 5 — Secrets, safety, cutover

1. `wrangler secret put ANTHROPIC_API_KEY` / `HUBSPOT_TOKEN`; `HUBSPOT_NEWSLETTER_LIST_ID` as a plain var.
2. **Split preview from production.** The current README instructs setting `HUBSPOT_TOKEN` for both, which means every preview-URL form submission writes into the live CRM. Add an `SBS_ENV` var; when it isn't `"production"`, `handleLead` computes and returns the recommendation but skips the HubSpot calls.
3. Set a **monthly spend cap in the Anthropic console.** This is the backstop that makes a public LLM endpoint safe to leave running.
4. Rate limits: burst via the binding (e.g. 5 requests / 60s per IP), daily global cap via KV. Keep the two distinct 429 messages the allenhoem worker already writes.
5. **Cutover, last:** move the custom domain from the Pages project to the Worker. A hostname can only be attached to one at a time — verify the Worker fully on `*.workers.dev` first, then switch, then delete the Pages project.
6. Rewrite `README.md` — the `site/` build-output instructions are wrong and must not survive.

---

## Verification

**Local:** `npx wrangler dev` with `ANTHROPIC_API_KEY` and `HUBSPOT_TOKEN` in `.dev.vars`.
1. `/` renders identically to the current site; `/pro-bono/`, `/brand/`, `/design-system/`, `/logo/` all resolve; `assets/mark.svg` and `og.png` load.
2. `curl -X POST localhost:8787/api/chat -d '{"messages":[{"role":"user","content":"What does Switchback do?"}]}'` streams `content_block_delta` events.
3. Malformed bodies return the right codes: non-JSON → 400 `bad_json`; 17 messages → 400 `bad_messages`; last message `assistant` → 400; `GET /api/chat` → 404.
4. Lead form submits end-to-end and renders the personalized `TRAIL_LINE` message; honeypot (`company_website` filled) returns 200 without a CRM write.

**Deployed:**
5. **Confirm prompt caching is live** — log `usage.cache_read_input_tokens` from the SSE `message_start` event. If it stays `0` across repeated turns, the corpus is under the 1024-token minimum or something volatile is leaking into the system prefix.
6. Confirm no answer ends with `stop_reason: "max_tokens"` on a long strategy question.
7. Exceed the burst limit and confirm a 429 with the friendly message, not a stack trace.
8. Verify the agent's trail names and pricing language match the landing page verbatim.
9. Preview deployment: submit the form, confirm **no** contact appears in HubSpot.

---

## Risks / open items

- **`_headers` support on Workers Static Assets** — verify during Phase 1. If unsupported in your `compatibility_date`, set the security and cache headers in the Worker response path instead. Don't lose HSTS or the immutable `assets/*` caching.
- **A public agent endpoint holding your Anthropic key is a free LLM proxy for anyone who finds it.** Rate limiting plus the console spend cap are the minimum. If you see abuse, add Turnstile on the panel's first message — that's a clean Phase 6, not a blocker.
- **The `switchback-advisor` skill uses a different vocabulary** (Trailhead Session, Flow Trail, Technical Singletrack, Expert Line, Guide Pass) than the site's shipped Services & Pricing v2 taxonomy (Green Trail, Blue Trail, Pro-Line, Team AI Training Workshop). **The site is the source of truth** for the grounding corpus. Worth reconciling the skill separately so internal advice and public copy don't drift, but not a blocker for this migration.
- **Pricing now lives in the page copy.** Services & Pricing v2 put concrete tier pricing on the landing page, so the Phase 2 extractor will pull those numbers into the agent's context. Re-run `build:grounding` and redeploy on every pricing change, or the agent will quote stale prices with full confidence.
- Brand pages carry `noindex` and stay that way; `sitemap.xml` continues to list only `/` and `/pro-bono/`.
