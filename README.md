# MUNCH: Food Concierge

A model-agnostic agent that prices the **same food order on every delivery app you use** and tells you the best deal by true all-in cost: fees, tax, tip and promos included.

It is an [MCP](https://modelcontextprotocol.io) server, so it plugs into any LLM client that speaks MCP: Claude Desktop, Claude Code, the OpenAI Agents SDK, and others.

> **Status: Phase 1.** Everything works end to end against two built-in **demo providers** with fake data (MockEats and MockDash). Real apps (Uber Eats, DoorDash, Grubhub, Postmates) are not built yet. See [`docs/PHASE0_PLAN.md`](docs/PHASE0_PLAN.md) for the plan, research and risks.

## What it does

1. Asks a few short questions (mood, budget, address, dietary needs, tip, ghost-kitchen preference).
2. Has you sign in to each delivery app yourself, in a real browser window.
3. Searches every connected app, matches the same restaurant across apps, builds the same order on each, and reads the itemized total from checkout.
4. Recommends the best option and hands you off to the app's own checkout page.

## Safety rules built into the server

- **No passwords, ever.** Sign-in happens on the provider's real login page. Only the resulting session is kept, on your machine.
- **No order without your explicit yes.** The default is a handoff: the app's checkout page opens and *you* tap "Place order". Direct ordering (`place_order`) is off unless you set `MUNCH_ENABLE_PLACE_ORDER=1`, and even then it needs a one-time token that only exists after you approve the itemized total in a prompt the model cannot answer for you (your client's confirmation dialog, or a page on `127.0.0.1`). The token is single-use, lasts 5 minutes, and dies if the cart, price or tip changes.
- **Estimates are labeled.** If any part of a total could not be read from the app's checkout, the quote is marked `verified: false` and shown as an estimate.
- **Ghost kitchens are always labeled**, with the reasons, whether or not you choose to hide them.
- **The tip is yours.** The server never picks one. Without a tip, totals are shown as "before tip".
- **Local only.** No backend. Preferences and session data are AES-256-GCM encrypted on disk with a key kept in your OS keychain. If no keychain is available, nothing is written to disk.
- **Logs contain no personal data.** Tool names, timings and error codes only.

## Setup

Requires Node 20+.

```bash
npm install
```

```bash
npm test
```

```bash
npm run harness:smoke
```

`harness:smoke` starts the real server over stdio and walks the full flow with no LLM and no API key.

```bash
npm run build
```

## Connect to Claude

**Claude Code** (from this folder, after `npm run build`):

```bash
claude mcp add munch -- node "$(pwd)/dist/index.js"
```

**Claude Desktop**: add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), with your own path, then restart:

```json
{
  "mcpServers": {
    "munch": { "command": "node", "args": ["/absolute/path/to/MUNCH/dist/index.js"] }
  }
}
```

Then pick the **Food Concierge** prompt (`concierge_intake`) or just say "I'm hungry".

**Terminal chat with the Claude API** (manual tool loop over MCP):

```bash
ANTHROPIC_API_KEY=... npm run harness:claude
```

## Connect to OpenAI

The OpenAI Agents SDK can run any stdio MCP server. Terminal chat:

```bash
OPENAI_API_KEY=... npm run harness:openai
```

In your own agent:

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

The Agents SDK does not use MCP prompts, so the same guide is also served by the `get_intake_guide` tool and the server's `instructions`.

## Tools

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

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MUNCH_ENABLE_PLACE_ORDER` | off | `1` enables `place_order` |
| `MUNCH_MOCK` | on | `0` hides the demo providers |
| `MUNCH_DATA_DIR` | OS app-data folder | Where encrypted files live |
| `MUNCH_LOG` | on | `silent` turns off logs |

## Adding a provider

1. Create `src/providers/<name>/adapter.ts` implementing [`ProviderAdapter`](src/providers/ProviderAdapter.ts). Return the normalized types from [`src/core/types.ts`](src/core/types.ts); money is integer cents.
2. Register it in [`src/providers/registry.ts`](src/providers/registry.ts) and add its id to `ProviderId` in `types.ts`.
3. Add fixture-based tests under `test/`.

Nothing in `src/core` or `src/tools` needs to change. Adapter rules: never touch passwords, never submit an order outside `placeOrder`, never change account settings, and set `verified: false` on anything you could not read from the provider. [`src/providers/mock/adapter.ts`](src/providers/mock/adapter.ts) is a complete small example.

## Terms of service

The real-app adapters (not built yet) will drive your own logged-in browser session. Delivery apps' terms generally prohibit automated access, and using this could get an account flagged or suspended. The project does not, and will not, evade bot detection or solve CAPTCHAs. Details and open questions are in [`docs/PHASE0_PLAN.md`](docs/PHASE0_PLAN.md).

## Layout

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
