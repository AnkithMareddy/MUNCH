# MUNCH: Food Concierge

**Tell your AI assistant what you want to eat. It prices the same order on every delivery app you use and tells you which one is cheapest, all-in.**

MUNCH is a free, open-source add-on for AI assistants (Claude, OpenAI agents, and anything else that supports [MCP](https://modelcontextprotocol.io)). It runs on your own computer.

> **Status: early preview.** The full experience works today against two built-in **demo apps with fake data** (MockEats and MockDash), so you can try the conversation end to end. Support for real apps (Uber Eats, DoorDash, Grubhub, Postmates) is in development and not available yet. See the [roadmap](#roadmap).

## Why this is useful

The same meal from the same restaurant usually costs a different amount on each delivery app, and the menu price is the least of it:

- **Menu prices differ.** Restaurants often list higher prices on delivery apps than in store, and not the same on each app.
- **Fees differ.** Delivery fee, service fee and small-order fee are set per app and only show up at checkout.
- **Promos differ.** One app may be running "$5 off $30+" while another has nothing.
- **Memberships change everything.** DashPass, Uber One or Grubhub+ can wipe out fees on one app only.

Finding the cheapest option by hand means building the same cart two or three times and getting to the last checkout screen on each. Almost nobody does that. MUNCH does it for you in one conversation.

### What you get

Here is the comparison from the built-in demo: two pad thai with shrimp and spring rolls from the same restaurant, 15% tip.

| # | App | Subtotal | Fees | Tax | Discounts | Tip | **All-in total** | ETA |
|---|---|---|---|---|---|---|---|---|
| 1 | MockDash (demo) | $46.45 | $6.56 | $4.12 | -$9.24 | $6.97 | **$54.86** | ~40 min |
| 2 | MockEats (demo) | $43.00 | $9.44 | $3.82 | — | $6.45 | **$62.71** | ~35 min |

> Order from Thai Orchid on MockDash: **$54.86 all-in, ~40 min. That's $7.85 cheaper than the next best.**

The app with the *higher* menu prices is the cheaper one here, because a membership and a promo more than cover the difference. That is exactly what is hard to see without doing the full comparison. (These are demo numbers, not real prices.)

## How it works

1. **A short chat, not a form.** What are you in the mood for, your budget, where it's going, any dietary needs, and what tip you want. It remembers your stable answers for next time.
2. **You sign in to your apps yourself.** A real browser window opens on the app's own login page. MUNCH never sees or stores your password.
3. **It prices the same order everywhere.** It finds the same restaurant on each app, builds the same cart, and reads the itemized total from checkout: subtotal, every fee, tax, discounts, tip, ETA.
4. **One clear recommendation.** A comparison table and a single sentence telling you what to order where, and how much you save. Say "I care more about speed" and it re-ranks.
5. **You place the order.** It opens the winning app's checkout with your cart filled in. You review it and tap "Place order" yourself.

It also **flags ghost kitchens** (delivery-only brands run out of a shared kitchen) and tells you why a place was flagged. You choose whether to hide them or just see the label.

See [`DEMO.md`](DEMO.md) for a full example conversation.

## Try it in 5 minutes

You need [Node.js](https://nodejs.org) 20 or newer. **You do not need an API key** if you use Claude Desktop or Claude Code: your own Claude plan runs the assistant, and MUNCH is just a tool it calls.

```bash
git clone https://github.com/AnkithMareddy/MUNCH.git
```

```bash
cd MUNCH && npm install && npm run build
```

Then add it to your assistant (pick one below) and say **"I'm hungry"**.

Things to try with the demo data: Thai, pizza, sushi, burgers, salads or wings, delivered anywhere. Ask for wings to see ghost-kitchen flags. Say you have "MockPass" to see a membership change the winner.

### Claude Desktop

Open Settings → Developer → Edit Config, add this with the real path to your MUNCH folder, and restart Claude:

```json
{
  "mcpServers": {
    "munch": { "command": "node", "args": ["/absolute/path/to/MUNCH/dist/index.js"] }
  }
}
```

### Claude Code

From the MUNCH folder:

```bash
claude mcp add munch -- node "$(pwd)/dist/index.js"
```

### OpenAI (Agents SDK)

Any agent built with the OpenAI Agents SDK can use MUNCH. You use your own OpenAI key.

```ts
import { Agent, MCPServerStdio, run } from "@openai/agents";

const server = new MCPServerStdio({ name: "food-concierge", command: "node", args: ["/absolute/path/to/MUNCH/dist/index.js"] });
await server.connect();
const agent = new Agent({
  name: "Food Concierge",
  instructions: "Before anything else, call get_intake_guide and follow it.",
  mcpServers: [server],
});
console.log((await run(agent, "I'm hungry")).finalOutput);
```

### Chat from the terminal

These use your own API key, set in your terminal. Never commit a key to a repo.

```bash
ANTHROPIC_API_KEY=... npm run harness:claude
```

```bash
OPENAI_API_KEY=... npm run harness:openai
```

MUNCH runs on your computer, so it works with desktop and developer tools. It can't be added as a hosted connector in the ChatGPT or claude.ai web apps.

## Your data and your money

These rules are enforced by the server itself, not left to the AI model:

- **No passwords, ever.** Sign-in happens on the provider's real login page. Only the resulting session is kept, on your machine.
- **No order without your explicit yes.** The default is a handoff: the app's checkout page opens and *you* tap "Place order". Direct ordering (`place_order`) is off unless you set `MUNCH_ENABLE_PLACE_ORDER=1`, and even then it needs a one-time token that only exists after you approve the itemized total in a prompt the model cannot answer for you (your client's confirmation dialog, or a page on `127.0.0.1`). The token is single-use, lasts 5 minutes, and dies if the cart, price or tip changes.
- **Estimates are labeled.** If any part of a total could not be read from the app's checkout, the quote is marked `verified: false` and shown as an estimate.
- **Ghost kitchens are always labeled**, with the reasons, whether or not you choose to hide them.
- **The tip is yours.** The server never picks one. Without a tip, totals are shown as "before tip".
- **Local only.** No backend. Preferences and session data are AES-256-GCM encrypted on disk with a key kept in your OS keychain. If no keychain is available, nothing is written to disk.
- **Logs contain no personal data.** Tool names, timings and error codes only.

## Roadmap

| Phase | What | Status |
|---|---|---|
| 0 | Research and plan ([`docs/PHASE0_PLAN.md`](docs/PHASE0_PLAN.md)) | Done |
| 1 | Server, demo apps, comparison, safe checkout flow | Done |
| 2 | Uber Eats | Next |
| 3 | DoorDash, Grubhub, Postmates (de-duplicated against Uber Eats) | Planned |
| 4 | Tuning restaurant matching and ghost-kitchen detection on real data | Planned |
| 5 | Hardening: session expiry, breakage detection, recorded test fixtures | Planned |

US only for now.

## For developers

```bash
npm test
```

```bash
npm run harness:smoke
```

`harness:smoke` starts the real server and walks the full flow with no AI model and no API key.

### Tools

| Tool | What it does |
|---|---|
| `list_providers` | Supported apps, which are connected, whether each session is valid |
| `connect_provider` / `disconnect_provider` | Start sign-in in a browser window / sign out and delete the session |
| `get_preferences` / `save_preferences` | Saved defaults: address, dietary needs, ghost-kitchen choice, memberships, tip, filters |
| `get_intake_guide` | The concierge playbook, for clients without MCP prompts |
| `search` | Normalized restaurants across connected apps, cross-app matches, ghost-kitchen flags |
| `get_menu` | One restaurant's menu on one app |
| `build_cart` | Maps your order onto that app's menu (fuzzy names and options, with warnings) |
| `quote_cart` | Itemized landed cost: subtotal, fees, tax, discounts, tip, total, ETA |
| `compare` | Ranked table, one-line reason each, one recommendation. Accepts `weights` |
| `open_checkout` | Hands off to the app's checkout page |
| `request_confirmation` | Asks *you* to approve the final total; returns the one-time token |
| `place_order` | Off by default. Needs the token |

Prompt: `concierge_intake`.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `MUNCH_ENABLE_PLACE_ORDER` | off | `1` enables `place_order` |
| `MUNCH_MOCK` | on | `0` hides the demo providers |
| `MUNCH_DATA_DIR` | OS app-data folder | Where encrypted files live |
| `MUNCH_LOG` | on | `silent` turns off logs |

### Adding a delivery app

1. Create `src/providers/<name>/adapter.ts` implementing [`ProviderAdapter`](src/providers/ProviderAdapter.ts). Return the normalized types from [`src/core/types.ts`](src/core/types.ts); money is integer cents.
2. Register it in [`src/providers/registry.ts`](src/providers/registry.ts) and add its id to `ProviderId` in `types.ts`.
3. Add fixture-based tests under `test/`.

Nothing in `src/core` or `src/tools` needs to change. Adapter rules: never touch passwords, never submit an order outside `placeOrder`, never change account settings, and set `verified: false` on anything you could not read from the provider. [`src/providers/mock/adapter.ts`](src/providers/mock/adapter.ts) is a complete small example.

### Layout

```
src/core/        types, cart mapping, quote assembly, confirmation tokens
src/core/compare restaurant matching, ghost-kitchen detection, ranking
src/providers/   ProviderAdapter interface, registry, mock provider
src/storage/     keychain key, encrypted store, preferences, sessions
src/tools/       MCP tools
src/prompts/     the intake guide
harness/         smoke test and Claude / OpenAI chat clients
data/            known virtual-brand list (editable)
```

## Terms of service: read before using with real apps

Support for real apps (not built yet) will work by driving your own logged-in browser session. Delivery apps' terms generally prohibit automated access, so using MUNCH with a real account could get that account flagged or suspended. That risk is yours to weigh. MUNCH is not affiliated with or endorsed by any delivery app. The project does not, and will not, evade bot detection or solve CAPTCHAs. Details and open questions are in [`docs/PHASE0_PLAN.md`](docs/PHASE0_PLAN.md).

## License

[MIT](LICENSE)
