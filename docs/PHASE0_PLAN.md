# Food Concierge: Phase 0 (research spike + plan)

Status: **reviewed**. Decisions are recorded in §7. Phase 1 is built.
Date of research: 2026-11-11.

Research caveat: this sandbox could run web searches but could not open provider pages directly (developer.uber.com, techcrunch.com and others were blocked by the session network). Findings below come from search-result summaries of official docs and press coverage. Items marked **(verify)** need a direct read of the source before we rely on them.

---

## 1. Per-provider findings

### Summary

| Provider | Official consumer-ordering API? | Recommended v1 path | ToS risk of browser automation |
|---|---|---|---|
| DoorDash | **Yes, but gated.** DoorDash MCP + CLI ("agentic ordering"), limited beta for *companies ordering for employees*. OAuth consent per user. | Adapter with two backends: **official MCP** (if you get beta access) and **browser** fallback. | **High.** Terms explicitly ban robots/scripts and automated collection without written permission. |
| Uber Eats | **Maybe.** "Consumer Delivery APIs" list *in-app ordering* as a use case. Early access, case-by-case written approval. Marketplace APIs are merchant-side only. | Browser. Apply for Consumer Delivery access in parallel. | **Likely high (verify).** Couldn't retrieve current Uber terms text. |
| Grubhub | **No.** Partner APIs (Orders, Menu, Delivery Status) are restaurant/POS side, onboarding via partner pilot. | Browser only. | **Likely high.** A ToS tracker lists a "No scraping or automated data extraction" clause (text not confirmed). |
| Postmates | No separate API. Runs on Uber's platform. Standalone app status in 2026 is unclear (sources conflict). | Thin adapter on top of the Uber Eats adapter + dedupe. Possibly just a "brand" flag. | Same as Uber. |

### DoorDash
- **Official MCP exists** ([About DoorDash MCP](https://developer.doordash.com/en-US/docs/mcp/overview/about_mcp/), [DoorDash MCP & CLI](https://developer.doordash.com/en-US/mcp/)). Capabilities per docs: discover stores near an address, browse menus, build cart, apply promotions, **preview totals**, place order, track, receipts, reorder. Auth is a DoorDash OAuth consent flow, so our server never touches credentials. That fits our "no passwords" rule better than browser automation does.
- **Catch:** it is a limited, company-level beta for workplace ordering ([press release](https://about.doordash.com/en-us/news/doordash-ordering-connector)). The waitlist opened Sept 30, 2026 and joining it doesn't grant access. A personal consumer tool may not qualify.
- DoorDash Drive API is for merchants requesting Dasher deliveries. Not relevant.
- Terms: a ToS tracker reproduces clauses banning access "with any robot, spider, script, web crawler" and automated collection "unless DoorDash has given you prior permission ... in writing", plus a ban on circumventing security measures ([provision](https://conductatlas.com/platform/doordash/doordash-terms-of-service/provision/CA-P-025953/prohibition-on-web-scraping-and-deep-linking/)) **(verify against DoorDash's own terms)**.
- Context: DoorDash reported only "several hundred" third-party agent orders in Q3 2026. Agent ordering is new and the platforms are watching it closely.

### Uber Eats
- **Marketplace APIs** ([intro](https://developer.uber.com/docs/eats/introduction)) are for merchants: menus, stores, incoming orders. They need an NDA, a licensing agreement and partner-manager approval. Not usable for consumer ordering.
- **Consumer Delivery APIs** ([intro](https://developer.uber.com/docs/consumer-delivery/introduction)) are meant for "voice assistants, chatbots, or existing apps", with in-app Uber Eats ordering as a listed use case. Early access, case-by-case approval. This is the one to apply for. **(verify scopes and whether fees/taxes are exposed)**
- Uber Direct is merchant-initiated delivery. Not relevant.
- The web app at ubereats.com is a JS app backed by internal JSON endpoints. That enables the "passive network capture" approach in §3.

### Grubhub
- All documented APIs are partner/POS side ([developer support](https://grubhub-developers.zendesk.com/hc/en-us/articles/115005713943-Release-Notes)). v1 partner APIs are deprecated in favor of v2. No consumer ordering API found.
- Browser automation is the only path. Grubhub+ (and Amazon Prime's Grubhub+ perk) affects fees, so read the applied discount from checkout rather than guessing.

### Postmates
- Uber acquired Postmates in 2020 and moved it onto Uber's backend. Whether the standalone US app still exists in Nov 2026 is unclear: app stores still list it, but some sources say it was fully absorbed. **(verify on your phone)**
- Working hypothesis to test in Phase 3: Postmates stores share Uber store IDs and pricing. If so, dedupe on store ID and only show Postmates separately when its quote actually differs (for example, a Postmates-only promo).
- An Uber account may log in to both, so one session might cover both. That needs testing.

### Login / 2FA flows (all browser providers)
- Login pages use email/phone + OTP (SMS/email), password, or SSO (Google/Apple/Facebook). The user does all of this in a visible window. We only detect the "logged in" state (e.g. an account menu element or an authenticated API response), then save the session.
- **Risk:** Google sign-in often blocks browsers that are under automation control ("This browser may not be secure"). Mitigation: launch the user's installed Chrome (`channel: "chrome"`) with a persistent profile, and tell users who use Google SSO to use email/OTP instead if they get blocked.

### Fee page structure (what a "true total" needs)
On every app, tax, service fee and small-order fee only resolve **at checkout, with a real cart and a delivery address**. Menu prices on delivery apps are often marked up compared with in-store prices, and that markup differs per app, so item subtotals differ too. To get a real landed cost we must:
1. Build a real cart in the user's account on each app.
2. Load the checkout/review page (never click "Place order").
3. Read the itemized fee breakdown. All apps show one, sometimes behind a "Fees & estimated taxes" expander.
4. Read promos and membership savings as the app applies them. Don't compute them ourselves.

Anything we can't read from checkout gets `verified: false` and an "estimate" label.

---

## 2. ToS and policy risks (for your decision)

1. **Browser automation likely breaches all three providers' terms**, even when it's the user's own logged-in session and human-paced. The concrete risk is the *user's account* getting flagged or suspended, not just ours. I recommend:
   - Telling users plainly when they connect each provider.
   - Keeping v1 personal and local (don't distribute it publicly) until you've decided on the legal posture.
   - Applying for official access (DoorDash MCP, Uber Consumer Delivery) in parallel.
2. **No anti-bot evasion.** These sites run bot detection. I won't add stealth plugins, fingerprint spoofing or CAPTCHA solving: that is "circumventing security measures", which DoorDash's terms ban outright. If a challenge shows up, we pause, put the visible window in front, and let the user handle it.
3. **Real carts get modified.** Building a cart on each app changes the user's real cart, which may sync to their phone. We detect an existing cart and ask before replacing it.
4. **Rate limiting.** One browser action at a time per provider, at least 2–4 s between page loads with jitter, menus cached 10 min and search cached 5 min. Providers are queried one after another, not in parallel.
5. **Reading internal JSON responses** that the page itself loads is technically more robust than reading HTML, but it's the same ToS category. We would only read responses the user's page already requested, never call those endpoints directly.

---

## 3. Key design decisions

### 3.1 Enforcing explicit confirmation (the hard part)
A token the *model* can request and then pass back doesn't prove the *user* said yes, because the model sits in the middle. Plan:
- `quote_cart` returns the quote plus a `quote_hash` (cart contents, total, address, provider).
- A `request_confirmation(cart_id)` step asks the user **directly, outside the model**:
  1. **Preferred:** MCP **elicitation** (`elicitation/create`). The client shows the user a prompt with the itemized total and they click Yes or No. The model never sees or produces the yes.
  2. **Fallback** for clients without elicitation: open a local page (`http://127.0.0.1:<port>/confirm/<id>`) in the already-visible browser showing the itemized total with a Confirm button.
- Only then does the server mint a token: random, single-use, held in memory only, bound to `cart_id + quote_hash`, 5-minute expiry. Any cart or price change invalidates it.
- `open_checkout` (the v1 default) only hands off. The user still taps "Place order" themselves.
- `place_order` sits behind `MUNCH_ENABLE_PLACE_ORDER=1`, which is off by default. It re-quotes before submitting and refuses if the total moved.

### 3.2 Session storage, encrypted at rest
Playwright's persistent context is a whole Chromium profile directory, which is hard to encrypt as a unit. Options:
- **A (recommended):** a persistent profile per provider under the OS app-data directory with permissions 0700. Chromium already encrypts cookie values using the OS keychain on macOS and Windows, and on Linux when libsecret is available. Our own data (prefs, cache, session metadata, tokens) goes in an AES-256-GCM file whose key lives in the OS keychain (`@napi-rs/keyring`).
- **B (stricter):** use a normal context and save `storageState` (cookies + localStorage) encrypted with our key, decrypted into a temporary profile at launch and wiped on exit. Fully encrypted by us, but it loses some profile state, which means more re-logins and more bot-check friction.

### 3.3 Long-running login
`connect_provider` can take minutes (2FA). Many MCP clients time out tool calls after about 60 s. So `connect_provider` opens the window and returns `status: "pending"` right away, and `list_providers` / `connect_provider` report `connected` once login is detected. Progress notifications keep the call alive on clients that support them.

### 3.4 Model-agnostic intake
Not every MCP client supports **prompts** (OpenAI Agents SDK support is partial). The intake guidance therefore ships three ways: the `concierge_intake` prompt, the server `instructions` field, and a `get_intake_guide` tool. Preferences are saved through `get_preferences` / `save_preferences` tools.

### 3.5 Money and comparisons
- All amounts are integer cents, with currency on every quote.
- Tip: to compare fairly we use **one tip policy across apps** (default: the same % of subtotal, configurable). The provider's own suggested tip is shown separately.
- Ranking score = weighted sum of normalized total, ETA, rating and intake fit. The default weights favor total, and the user can re-weight ("speed matters more").
- Restaurant matching: normalized name (strip "– Downtown", "(Delivery)" etc.) + geo distance < ~150 m + phone/address match when available. Each match gets a confidence score, and low-confidence matches are shown as "possibly the same".
- Ghost kitchen flags, each with a reason: (a) bundled known-virtual-brand list, (b) ≥3 distinct brands at the same street address across results, (c) name/description patterns ("delivery only", "by <parent brand>"), (d) optional web-presence check (see questions). The flag is shown with its reasons. The filter is on by default and saved as a preference.

---

## 4. Proposed repo structure

```
munch/
  package.json            # single package, Node 20+, ESM, TypeScript
  tsconfig.json
  src/
    server.ts             # MCP entry (stdio; Streamable HTTP optional)
    tools/                # one file per tool, zod input schemas
    prompts/conciergeIntake.ts
    core/
      types.ts            # Restaurant, MenuItem, Modifier, Cart, Quote, ProviderSession, UserPreferences (zod)
      money.ts
      cartMapper.ts       # desired order → provider menu (fuzzy name + modifier mapping)
      compare/
        matching.ts       # cross-app restaurant matching
        ghostKitchen.ts
        ranking.ts
        render.ts         # comparison table + recommendation sentence
      confirm/
        token.ts          # HMAC single-use tokens
        elicit.ts         # elicitation + localhost fallback
    providers/
      ProviderAdapter.ts  # shared interface
      registry.ts
      mock/
      ubereats/  { adapter.ts, login.ts, parse.ts, selectors.ts }
      doordash/  { adapter.ts, browser/, official-mcp/ }
      grubhub/
      postmates/ { adapter.ts, dedupe.ts }
    browser/
      sessionManager.ts   # persistent headed contexts, login detection, expiry
      throttle.ts         # per-provider serial queue + rate limit
      selectorGuard.ts    # fails loudly with clear "selector broke" errors
    storage/
      keychain.ts  encryptedStore.ts  prefs.ts  cache.ts
    util/logger.ts        # structured logs, PII redaction (addresses, names, phone, email, tokens)
  data/virtual-brands.json
  test/
    unit/                 # normalization, matching, ranking, tokens, money
    adapters/             # fixture-driven per provider
    fixtures/<provider>/  # recorded HTML/JSON, PII scrubbed
  scripts/record-fixtures.ts   # run locally by you; scrubs PII before writing
  harness/
    claude/               # Claude Desktop + Claude Code config, smoke script
    openai/               # OpenAI Agents SDK (JS) client driving the same server
  README.md  DEMO.md  docs/
```

Tooling: `@modelcontextprotocol/sdk`, `zod`, `playwright`, `vitest`, `tsup`, `@napi-rs/keyring`, `pino` (with a redaction layer), `fastest-levenshtein`.

### Adapter interface (sketch)
```ts
interface ProviderAdapter {
  id: ProviderId;                          // "ubereats" | "doordash" | ...
  displayName: string;
  capabilities: { search: boolean; quote: "verified" | "estimate"; placeOrder: boolean };
  sessionStatus(): Promise<ProviderSession>;
  connect(): Promise<ProviderSession>;     // opens real login page; user signs in
  disconnect(): Promise<void>;
  search(c: SearchCriteria): Promise<Restaurant[]>;
  getMenu(restaurantId: string): Promise<MenuItem[]>;
  buildCart(restaurantId: string, items: DesiredItem[]): Promise<Cart>;  // includes unmapped items + warnings
  quote(cart: Cart): Promise<Quote>;       // reads checkout page; never submits
  checkoutUrl(cart: Cart): Promise<string>;
  placeOrder?(cart: Cart, token: VerifiedToken): Promise<OrderReceipt>;
  overlapsWith?: ProviderId[];             // e.g. postmates → ["ubereats"]
}
```

---

## 5. Phase plan and limits of this environment

| Phase | What I can do here | What needs your machine |
|---|---|---|
| 1 Mock + skeleton | Everything, plus an automated MCP-client test proving every tool works end to end | A live demo in Claude Desktop, and an OpenAI API key for the Agents SDK harness |
| 2 Uber Eats | Adapter code, parsers, fixture tests | **Real login and fixture recording.** This sandbox can't reach the provider sites or show a headed browser. You run `scripts/record-fixtures.ts` locally (PII scrubbed) and I build against those fixtures. |
| 3 DoorDash/Grubhub/Postmates | Same as Phase 2 | Same as Phase 2 |
| 4 Comparison | Everything (pure logic) | none |
| 5 Hardening | Most of it | Expiry/re-login testing |

Big risks, in order: (1) ToS / account suspension, (2) bot checks blocking automated browsers (including Google SSO), (3) selectors and internal APIs changing without notice, (4) quotes requiring real carts, (5) my not being able to test live sites from this sandbox.

---

## 6. Questions for you

1. **Distribution and ToS posture.** Is this for your own personal use for now, or do you plan to publish it? That changes how hard I'd push official APIs first and how loud the warnings should be.
2. **Official access.** Will you apply for the DoorDash MCP beta and Uber Consumer Delivery access? If so, I'll build DoorDash with the official MCP as the preferred backend and the browser as fallback.
3. **Session encryption.** Option A (persistent profile + Chromium's keychain cookie encryption + our encrypted store) or Option B (fully self-encrypted `storageState`, more re-logins)?
4. **Real-cart side effects.** OK to build real carts on each app (asking first if a cart already exists)? There's no way to get verified fees without it.
5. **Data capture method.** OK to read the JSON responses the provider page itself loads, with DOM parsing as fallback? Or DOM-only?
6. **Tip policy for comparison.** Same % across apps (default 15%?), a flat amount, or exclude tip from the ranking and show it separately?
7. **Ghost-kitchen web check.** OK to make a light outbound lookup (restaurant name + city only, no user data) to check for a standalone website? Or keep detection fully offline?
8. **Platform and region.** US only? Which OS do you develop on (macOS, Windows, Linux)? That affects keychain and Chrome-channel testing.
9. **OpenAI harness.** OK with the JS Agents SDK (`@openai/agents`) so everything stays TypeScript? Or do you want Python?

---

## 7. Decisions (from review, 2026-11-11)

| Question | Decision |
|---|---|
| Distribution | Will be published on GitHub for others to use. So: clear ToS warnings in the README and at connect time, no bot-detection evasion, official APIs preferred wherever access is granted. |
| Region | US only for now. |
| Login | In a real browser window opened from the AI client. The user signs in themselves. |
| Real carts | Yes, build real carts on each app. |
| Reading menus and prices | Allowed. |
| Tip | Ask the user. The server never chooses a tip; without one, totals are labeled "before tip". The user can ask to have their tip remembered. |
| Ghost kitchens | Ask the user's preference once and save it. Flagged places are always labeled with the reasons, whether hidden or shown. |

Still open (defaults in use until you say otherwise):
- **Session encryption:** Option A (browser profile + our encrypted store).
- **Official API access:** not applied for yet. Applying for the DoorDash MCP beta and Uber Consumer Delivery access is recommended before publishing.
- **Ghost-kitchen web lookup:** off. Detection is fully offline for now.
- **OpenAI harness:** TypeScript (`@openai/agents`).
- **Your OS:** unknown. Needed for Phase 2 browser and keychain testing.

## 8. Phase 2 approach (Uber Eats)

The live site can't be reached from the development sandbox, so Phase 2 is split:

- **2a (done):** visible-browser session manager (the user's installed Chrome, one profile per app, no stealth or CAPTCHA handling), sign-in flow that only watches for the signed-in state, session expiry detection, sign-out that deletes the profile, a recording tool (`npm run record -- ubereats`) and a PII scrubber. All tested headless against a fake local site.
- **2b (next):** search, menu, cart, quote and checkout handoff, written against a real recording.

Assumptions in `src/providers/ubereats/site.ts` are marked UNVERIFIED until a recording confirms them: the login URL, the internal API path pattern, and the cookie that signals a signed-in session.

## Sources
- [About DoorDash MCP](https://developer.doordash.com/en-US/docs/mcp/overview/about_mcp/) · [DoorDash MCP & CLI](https://developer.doordash.com/en-US/mcp/) · [DoorDash ordering connector announcement](https://about.doordash.com/en-us/news/doordash-ordering-connector) · [Kingy AI: DoorDash MCP beta](https://kingy.ai/news/doordash-mcp-corporate-ordering-beta/)
- [DoorDash Drive: get production access](https://developer.doordash.com/docs/drive/how_to/get_production_access)
- [TechCrunch: DoorDash "several hundred" agent orders](https://techcrunch.com/2026/10/30/doordash-said-its-only-received-several-hundred-orders-from-ai-agents/) · [beri.net: Uber agent orders](https://www.beri.net/article/uber-doordash-third-party-ai-agent-orders-four-rides-500-eats-orders-agentic-commerce-first-party-assistant-retail)
- [Uber Eats Marketplace APIs](https://developer.uber.com/docs/eats/introduction) · [Uber Consumer Delivery APIs](https://developer.uber.com/docs/consumer-delivery/introduction) · [Uber Eats getting started](https://developer.uber.com/docs/eats/guides/getting-started)
- [Grubhub developer release notes](https://grubhub-developers.zendesk.com/hc/en-us/articles/115005713943-Release-Notes) · [Supergood: Grubhub API report](https://supergood.ai/api-report-card/grubhub)
- [ConductAtlas: DoorDash scraping clause](https://conductatlas.com/platform/doordash/doordash-terms-of-service/provision/CA-P-025953/prohibition-on-web-scraping-and-deep-linking/) · [ConductAtlas: Grubhub no-scraping clause](https://conductatlas.com/platform/grubhub/grubhub-terms-of-use/provision/CA-P-028371/no-scraping-or-automated-data-extraction/)
- [AppsRhino: Postmates](https://www.appsrhino.com/blogs/what-is-postmates-how-does-it-work-everything-you-need-to-know)
