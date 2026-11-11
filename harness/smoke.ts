/**
 * End-to-end check with no LLM: starts the real server over stdio (exactly how
 * Claude Desktop or the OpenAI Agents SDK would) and walks the whole flow.
 *
 *   npm run harness:smoke
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", join(root, "src/index.ts")],
  env: { ...(process.env as Record<string, string>), MUNCH_DATA_DIR: mkdtempSync(join(tmpdir(), "munch-smoke-")), MUNCH_ENABLE_PLACE_ORDER: "1", MUNCH_LOG: "silent" },
});
const client = new Client({ name: "smoke", version: "0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  console.log("\n┌─ The server asks the USER directly (the model can't answer this) ─\n" + req.params.message.replace(/^/gm, "│ ") + "\n└─ user clicks: Yes\n");
  return { action: "accept", content: { confirm: true } };
});
await client.connect(transport);

let step = 0;
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[]).map((c) => c.text).join("\n");
  const start = text.search(/^[{[]/m);
  const head = start > 0 ? text.slice(0, start).trim() : "";
  console.log(`\n── ${++step}. ${name}(${JSON.stringify(args)})${res.isError ? "  → ERROR" : ""}`);
  if (head) console.log(head);
  let data: any;
  try {
    data = JSON.parse(text.slice(start));
  } catch {
    console.log(text.slice(0, 300) + "…");
  }
  return { data, isError: res.isError };
}
const show = (label: string, v: unknown) => console.log(`   ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

console.log("Tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
console.log("Prompts:", (await client.listPrompts()).prompts.map((p) => p.name).join(", "));

await call("get_intake_guide");
show("providers", (await call("list_providers")).data.available.map((p: any) => `${p.name}=${p.status}`));
await call("connect_provider", { provider: "mockeats" });
await call("connect_provider", { provider: "mockdash" });
show("saved", (await call("save_preferences", { default_address: "1 Demo Plaza, Brooklyn, NY", exclude_ghost_kitchens: true, memberships: { mockdash: true } })).data.preferences);

const wings = (await call("search", { query: "wings", exclude_ghost_kitchens: false })).data;
for (const r of wings.results) show(`${r.app} / ${r.name}`, r.ghost_kitchen.flagged ? `GHOST KITCHEN: ${r.ghost_kitchen.reasons.join(" ")}` : "ok");

const found = (await call("search", { query: "thai" })).data;
for (const r of found.results) show(r.app, `${r.name}, ${r.rating}★, ~${r.eta_min} min`);
show("same restaurant on", found.same_restaurant_on_multiple_apps[0].providers);

const items = [{ name: "pad thai", quantity: 2, modifiers: ["shrimp"] }, { name: "spring rolls", quantity: 1 }];
const tip = { type: "percent", value: 15 };
const quotes: any[] = [];
for (const provider of ["mockeats", "mockdash"]) {
  const cart = (await call("build_cart", { provider, restaurant_id: `${provider}:thai-orchid`, items })).data.cart;
  if (cart.warnings.length) show("warnings", cart.warnings);
  quotes.push((await call("quote_cart", { cart_id: cart.id, tip })).data.quote);
}

const cmp = (await call("compare", { quote_ids: quotes.map((q) => q.id) })).data;
const best = cmp.ranked[0];
await call("compare", { quote_ids: quotes.map((q) => q.id), weights: { total: 0.1, eta: 0.9 } });

show("handoff", (await call("open_checkout", { cart_id: best.cart_id })).data.tell_user);

// Safety checks around direct ordering (flag is ON for this run only).
const bad = await call("place_order", { cart_id: best.cart_id, confirmation_token: "made-up-token" });
show("refused", bad.data.message);
const conf = (await call("request_confirmation", { quote_id: best.quote_id })).data;
const placed = await call("place_order", { cart_id: best.cart_id, confirmation_token: conf.confirmation_token.token });
show("placed", placed.data);
const again = await call("place_order", { cart_id: best.cart_id, confirmation_token: conf.confirmation_token.token });
show("token reuse refused", again.isError);

await client.close();
const okAll = bad.isError && placed.data.status === "placed" && again.isError && cmp.ranked.length === 2;
console.log(okAll ? "\nSMOKE OK" : "\nSMOKE FAILED");
process.exit(okAll ? 0 : 1);
