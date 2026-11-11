/**
 * Try a delivery app end to end from the terminal, with no AI model and no API key.
 * It drives the same tools an assistant would, one step at a time, and stops at
 * the app's checkout page. It never places an order.
 *
 *   npm run try -- ubereats
 */
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContext } from "../src/context.js";
import { createServer } from "../src/server.js";

const provider = process.argv[2] ?? "ubereats";
const ctx = createContext({ experimental: [provider], enableMock: provider.startsWith("mock"), log: { info() {}, warn() {}, error() {} } });
const client = new Client({ name: "try", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([createServer(ctx).connect(a), client.connect(b)]);
const rl = createInterface({ input: process.stdin });
// Lines are queued so answers can be typed ahead or piped in.
const queue: string[] = [];
const waiters: ((line: string) => void)[] = [];
rl.on("line", (line) => (waiters.length ? waiters.shift()!(line) : queue.push(line)));
rl.on("close", () => waiters.splice(0).forEach((w) => w("")));
const ask = (q: string): Promise<string> => {
  process.stdout.write(`\n${q} `);
  return new Promise<string>((resolve) => (queue.length ? resolve(queue.shift()!) : waiters.push(resolve))).then((s) => s.trim());
};

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  process.stdout.write(`\n… ${name}`);
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = (res.content as { text: string }[]).map((c) => c.text).join("\n");
  const start = text.search(/^[{[]/m);
  const data = JSON.parse(text.slice(start));
  console.log(` (${((Date.now() - started) / 1000).toFixed(1)}s)${res.isError ? "  FAILED" : ""}`);
  if (start > 0) console.log(text.slice(0, start).trim());
  if (res.isError) {
    console.log(`\n  What happened: ${data.message}\n  Code: ${data.error}${data.next_step ? `\n  Suggested next step: ${data.next_step}` : ""}`);
    throw Object.assign(new Error("stopped"), { code: data.error });
  }
  return data;
}

console.log(`Trying ${provider}. A browser window will open. Nothing will be ordered: this stops at the checkout page.\nIf anything fails, copy what this prints and send it to Claude (it contains no personal data).`);
try {
  let status = (await call("connect_provider", { provider })).status;
  if (status === "pending") {
    await ask("Sign in in the browser window, then press Enter here.");
    status = (await call("list_providers")).available.find((p: any) => p.provider === provider)?.status;
  }
  if (status !== "connected") throw new Error(`not signed in (status: ${status})`);
  console.log("  Signed in.");

  const query = await ask('What do you want to search for? (for example "thai", or leave empty for the home page):');
  const found = await call("search", { query: query || undefined, exclude_ghost_kitchens: false });
  const list = found.results.slice(0, 10);
  if (list.length === 0) throw new Error("search returned no restaurants");
  list.forEach((r: any, i: number) => console.log(`  ${i + 1}. ${r.name}  ${r.rating ?? "?"}★  up to ${r.eta_min ?? "?"} min`));
  console.log(`  (${found.count} found)`);
  const pick = list[(parseInt(await ask("Pick a restaurant by number:"), 10) || 1) - 1] ?? list[0];

  const menu = await call("get_menu", { provider, restaurant_id: pick.id });
  menu.items.slice(0, 40).forEach((m: any) => console.log(`  - ${m.name}  ${m.price_note ?? m.price}${m.has_options ? "  (has choices)" : ""}${m.available ? "" : "  SOLD OUT"}`));
  console.log(`  (${menu.items.length} dishes)`);

  const dish = await ask("Type a dish name to add (one dish):");
  const options = await ask('Any choices, separated by commas? (for example "chicken, medium"; leave empty for defaults):');
  const items = [{ name: dish, quantity: 1, modifiers: options ? options.split(",").map((s) => s.trim()).filter(Boolean) : undefined }];
  let built: any;
  try {
    built = await call("build_cart", { provider, restaurant_id: pick.id, items });
  } catch (e) {
    if ((e as { code?: string }).code !== "existing_cart") throw e;
    const yes = await ask("You already have a cart at this restaurant. Add this dish on top of it? Type yes to continue, anything else to stop:");
    if (!/^y/i.test(yes)) throw e;
    built = await call("build_cart", { provider, restaurant_id: pick.id, items, existing_cart: "keep" });
  }
  for (const l of built.cart.lines) console.log(`  ${l.quantity} × ${l.name} ${l.selected_options.length ? `(${l.selected_options.map((o: any) => o.option).join(", ")})` : ""}`);
  for (const w of built.cart.warnings) console.log(`  ! ${w}`);

  const tip = parseFloat(await ask("Tip percent for the quote (for example 15):")) || 0;
  const quote = await call("quote_cart", { cart_id: built.cart.id, tip: { type: "percent", value: tip } });
  console.log(`  ${quote.quote.display.label}: ${quote.quote.display.total}`);
  for (const n of [...quote.quote.estimate_notes, ...quote.notes]) console.log(`  ! ${n}`);

  await ask("Compare the lines above with the Uber Eats checkout page in the browser. Do the fees and tax match? Press Enter to finish.");
  const out = await call("open_checkout", { cart_id: built.cart.id });
  console.log(`\n  ${out.tell_user}`);
  console.log("\nAll steps worked. You can remove the item from your cart in the browser. Nothing was ordered.");
} catch (e) {
  if ((e as Error).message !== "stopped") console.log(`\nStopped: ${(e as Error).message}`);
  console.log("\nIt stopped before finishing. Copy everything above and send it to Claude.");
}
await ask("Press Enter to close the browser.");
rl.close();
await ctx.browsers.closeAll();
process.exit(0);
