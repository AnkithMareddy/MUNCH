import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rig } from "./helpers.js";

const ORDER = [{ name: "pad thai", quantity: 2, modifiers: ["shrimp"] }, { name: "spring rolls", quantity: 1 }];
const TIP = { type: "percent", value: 15 };

async function connected(opts: Parameters<typeof rig>[0] = {}) {
  const r = await rig(opts);
  await r.call("connect_provider", { provider: "mockeats" });
  await r.call("connect_provider", { provider: "mockdash" });
  return r;
}

async function quoteBoth(r: Awaited<ReturnType<typeof rig>>, slug = "thai-orchid", items = ORDER, tip: unknown = TIP) {
  const out = [];
  for (const provider of ["mockeats", "mockdash"]) {
    const cart = await r.call("build_cart", { provider, restaurant_id: `${provider}:${slug}`, items });
    const quote = await r.call("quote_cart", { cart_id: cart.data.cart.id, ...(tip ? { tip } : {}) });
    out.push({ cart: cart.data.cart, quote: quote.data.quote, text: quote.text, notes: quote.data.notes });
  }
  return out;
}

describe("MCP surface", () => {
  it("exposes every required tool and the intake prompt", async () => {
    const { client } = await rig();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["list_providers", "connect_provider", "disconnect_provider", "search", "get_menu", "build_cart", "quote_cart", "compare", "open_checkout", "place_order"]) expect(tools).toContain(t);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["concierge_intake"]);
    const p = await client.getPrompt({ name: "concierge_intake", arguments: { mood: "thai" } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain("Never ask for a password");
    expect(text).toContain("I'm in the mood for: thai");
    expect(client.getInstructions()).toContain("get_intake_guide");
  });
});

describe("providers and sessions", () => {
  it("lists, connects and disconnects", async () => {
    const r = await rig();
    let list = (await r.call("list_providers")).data;
    expect(list.available.map((p: any) => [p.provider, p.session_valid])).toEqual([["mockeats", false], ["mockdash", false]]);
    expect(list.not_yet_supported.map((p: any) => p.provider)).toEqual(["ubereats", "doordash", "grubhub", "postmates"]);

    const noApps = await r.call("search", { query: "thai" });
    expect(noApps.isError).toBe(true);
    expect(noApps.data.error).toBe("no_connected_providers");

    expect((await r.call("connect_provider", { provider: "mockeats" })).data.status).toBe("connected");
    list = (await r.call("list_providers")).data;
    expect(list.available[0].session_valid).toBe(true);
    await r.call("disconnect_provider", { provider: "mockeats" });
    expect((await r.call("list_providers")).data.available[0].session_valid).toBe(false);

    const real = await r.call("connect_provider", { provider: "ubereats" });
    expect(real.isError).toBe(true);
    expect(real.data.error).toBe("provider_not_available");
  });

  it("stores sessions and preferences encrypted, never in plain text", async () => {
    const r = await connected();
    await r.call("save_preferences", { default_address: "42 Wallaby Way, Brooklyn", dietary: ["vegetarian"] });
    const files = readdirSync(r.ctx.config.dataDir);
    expect(files.sort()).toEqual(["preferences.enc", "sessions.enc"]);
    for (const f of files) {
      const raw = readFileSync(join(r.ctx.config.dataDir, f), "utf8");
      expect(raw).not.toMatch(/Wallaby|vegetarian|mockeats|connected/);
    }
    expect((await r.call("get_preferences")).data.preferences.default_address).toBe("42 Wallaby Way, Brooklyn");
  });

  it("keeps nothing on disk when there is no keychain", async () => {
    const r = await rig({ config: { keys: { description: "none", getKey: async () => undefined } } as any });
    const saved = await r.call("save_preferences", { default_address: "42 Wallaby Way" });
    expect(saved.data.saved_to_disk).toBe(false);
    expect(readdirSync(r.ctx.config.dataDir)).toEqual([]);
    expect((await r.call("get_preferences")).data.preferences.default_address).toBe("42 Wallaby Way");
  });
});

describe("search", () => {
  it("normalizes across apps and matches the same restaurant", async () => {
    const r = await connected();
    const { data } = await r.call("search", { query: "thai" });
    expect(data.searched).toEqual(["mockeats", "mockdash"]);
    expect(data.results.map((x: any) => x.name).sort()).toEqual(["Thai Orchid", "Thai Orchid Restaurant"]);
    expect(data.results[0].match_group).toBe(data.results[1].match_group);
    expect(data.same_restaurant_on_multiple_apps[0].providers).toEqual(["mockeats", "mockdash"]);
  });

  it("labels ghost kitchens with reasons, and asks about the preference when it was never set", async () => {
    const r = await connected();
    const { data } = await r.call("search", { query: "wings" });
    const wing = data.results.find((x: any) => x.name === "Wing Mania");
    expect(wing.ghost_kitchen.flagged).toBe(true);
    expect(wing.ghost_kitchen.reasons[0]).toMatch(/3 different brands deliver from the same address/);
    const pasq = data.results.find((x: any) => x.name.startsWith("Pasqually"));
    expect(pasq.ghost_kitchen.reasons.join(" ")).toMatch(/known virtual brand.*Chuck E\. Cheese/);
    expect(data.notes.join(" ")).toMatch(/never said whether to hide ghost kitchens/);
  });

  it("hides ghost kitchens once the user says real restaurants only, and remembers it", async () => {
    const r = await connected();
    await r.call("save_preferences", { exclude_ghost_kitchens: true });
    const { data } = await r.call("search", { query: "pizza" });
    expect(data.results.every((x: any) => !x.ghost_kitchen.flagged)).toBe(true);
    expect(data.results.map((x: any) => x.name)).toContain("Luigi's Pizzeria");
    expect(data.hidden_by_filters.ghost_kitchens).toBe(2);
    const shown = await r.call("search", { query: "pizza", exclude_ghost_kitchens: false });
    expect(shown.data.results.some((x: any) => x.ghost_kitchen.flagged)).toBe(true);
  });

  it("applies rating and ETA filters and 'surprise me'", async () => {
    const r = await connected();
    await r.call("save_preferences", { exclude_ghost_kitchens: true });
    const all = (await r.call("search", {})).data;
    expect(all.count).toBe(9);
    const strict = (await r.call("search", { min_rating: 4.6, max_eta_min: 40 })).data;
    expect(strict.results.map((x: any) => x.name).sort()).toEqual(["Luigi's Pizzeria", "Thai Orchid", "Thai Orchid Restaurant"]);
  });
});

describe("cart, quote, compare", () => {
  it("prices the same order on both apps with itemized, differing fees", async () => {
    const r = await connected();
    await r.call("search", { query: "thai" });
    const [eats, dash] = await quoteBoth(r);
    expect(eats!.cart.lines.map((l: any) => l.name)).toEqual(["Pad Thai", "Vegetable Spring Rolls"]);
    expect(dash!.cart.lines.map((l: any) => l.name)).toEqual(["Phad Thai Noodles", "Crispy Veggie Spring Rolls"]);
    expect(dash!.cart.warnings.join(" ")).toMatch(/approximately/);

    // MockEats: 2×(15.00+3.00) + 7.00 = 43.00; fees 2.99 + 6.45; tax 3.82; tip 6.45
    expect(eats!.quote).toMatchObject({ subtotal_cents: 4300, delivery_fee_cents: 299, service_fee_cents: 645, small_order_fee_cents: 0, tax_cents: 382, tip_cents: 645, total_cents: 6271, verified: true, tip_status: "set" });
    // MockDash marks the menu up 8% and auto-applies a $5 promo.
    expect(dash!.quote.subtotal_cents).toBe(2 * (1620 + 325) + 755);
    expect(dash!.quote.discounts).toEqual([{ label: "$5 off orders $30+", amount_cents: 500, kind: "promo" }]);
    const q = dash!.quote;
    expect(q.total_cents).toBe(q.subtotal_cents + q.delivery_fee_cents + q.service_fee_cents + q.tax_cents - 500 + q.tip_cents);
    expect(eats!.text).toMatch(/TOTAL\s+\$62\.71/);

    const cmp = await r.call("compare", { quote_ids: [eats!.quote.id, dash!.quote.id] });
    expect(cmp.data.ranked).toHaveLength(2);
    expect(cmp.data.recommendation).toMatch(/^Order from .* on Mock(Eats|Dash) \(demo\): \$\d+\.\d\d all-in, ~\d+ min\. That's \$\d+\.\d\d cheaper than the next best/);
    expect(cmp.text).toContain("| # | App |");
    expect(cmp.data.warnings).toEqual([]);

    const speed = await r.call("compare", { quote_ids: [eats!.quote.id, dash!.quote.id], weights: { total: 0, eta: 1, rating: 0, fit: 0 } });
    expect(speed.data.ranked[0].app).toBe("MockEats (demo)");
  });

  it("applies memberships as itemized discounts", async () => {
    const r = await connected();
    const [before] = await quoteBoth(r);
    await r.call("save_preferences", { memberships: { mockeats: true } });
    const [after] = await quoteBoth(r);
    expect(after!.quote.discounts.map((d: any) => d.kind)).toEqual(["membership", "membership"]);
    expect(after!.quote.total_cents).toBe(before!.quote.total_cents - 299 - 215);
  });

  it("never invents a tip: without one the total is before tip and says so", async () => {
    const r = await connected();
    const [eats] = await quoteBoth(r, "thai-orchid", ORDER, null);
    expect(eats!.quote.tip_status).toBe("needs_user_input");
    expect(eats!.quote.tip_cents).toBe(0);
    expect(eats!.notes.join(" ")).toMatch(/Ask the user what tip/);
    const conf = await r.call("request_confirmation", { quote_id: eats!.quote.id });
    expect(conf.data.error).toBe("tip_not_set");

    await r.call("save_preferences", { tip: { type: "flat", cents: 500 } });
    const [saved] = await quoteBoth(r, "thai-orchid", ORDER, null);
    expect(saved!.quote.tip_cents).toBe(500);
    expect(saved!.notes.join(" ")).toMatch(/saved tip/);
  });

  it("labels an unverifiable price as an estimate everywhere", async () => {
    const r = await connected();
    const [eats, dash] = await quoteBoth(r, "green-bowl", [{ name: "harvest grain bowl", quantity: 1 }]);
    expect(eats!.quote.verified).toBe(true);
    expect(dash!.quote.verified).toBe(false);
    expect(dash!.quote.display.total).toMatch(/^~\$.* \(estimate\)$/);
    expect(dash!.text).toMatch(/ESTIMATED TOTAL \(not verified\)/);
    expect(dash!.notes.join(" ")).toMatch(/ESTIMATE/);
    const cmp = await r.call("compare", { quote_ids: [eats!.quote.id, dash!.quote.id] });
    expect(cmp.data.warnings.join(" ")).toMatch(/estimate/);
    expect(cmp.data.ranked.find((x: any) => !x.verified).total).toMatch(/estimate/);
  });

  it("reports items an app doesn't have, and refuses an empty cart", async () => {
    const r = await connected();
    const partial = await r.call("build_cart", { provider: "mockeats", restaurant_id: "mockeats:thai-orchid", items: [{ name: "pad thai", quantity: 1 }, { name: "tiramisu", quantity: 1 }] });
    expect(partial.data.cart.unmapped).toEqual(["tiramisu"]);
    const none = await r.call("build_cart", { provider: "mockeats", restaurant_id: "mockeats:thai-orchid", items: [{ name: "tiramisu", quantity: 1 }] });
    expect(none.data.error).toBe("nothing_matched");
    const wrong = await r.call("build_cart", { provider: "mockdash", restaurant_id: "mockeats:thai-orchid", items: ORDER });
    expect(wrong.data.error).toBe("provider_mismatch");
  });

  it("carries the ghost-kitchen flag through to the quote and comparison", async () => {
    const r = await connected();
    await r.call("search", { query: "wings" });
    const [eats] = await quoteBoth(r, "wing-mania", [{ name: "10 piece wings", quantity: 1 }]);
    expect(eats!.quote.ghost_kitchen.flagged).toBe(true);
    const cmp = await r.call("compare", { quote_ids: [eats!.quote.id] });
    expect(cmp.data.ranked[0].likely_ghost_kitchen).toBe(true);
    expect(cmp.data.recommendation).toMatch(/looks like a ghost kitchen/);
  });
});

describe("checkout and ordering safety", () => {
  it("hands off to the app's checkout only for a cart the user has seen priced", async () => {
    const r = await connected();
    const cart = await r.call("build_cart", { provider: "mockeats", restaurant_id: "mockeats:thai-orchid", items: ORDER });
    expect((await r.call("open_checkout", { cart_id: cart.data.cart.id })).data.error).toBe("not_quoted");
    await r.call("quote_cart", { cart_id: cart.data.cart.id, tip: TIP });
    const out = await r.call("open_checkout", { cart_id: cart.data.cart.id });
    expect(out.data.checkout_url).toContain("mockeats.example/checkout");
    expect(out.data.tell_user).toMatch(/Nothing has been ordered/);
  });

  it("place_order is off by default, even with a valid token", async () => {
    const r = await connected();
    const [eats] = await quoteBoth(r);
    const conf = await r.call("request_confirmation", { quote_id: eats!.quote.id });
    const res = await r.call("place_order", { cart_id: eats!.cart.id, confirmation_token: conf.data.confirmation_token.token });
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe("place_order_disabled");
  });

  it("with the flag on: needs a token the user approved, shows them the itemized total, and works once", async () => {
    const r = await connected({ config: { enablePlaceOrder: true } });
    const [eats] = await quoteBoth(r);
    expect((await r.call("place_order", { cart_id: eats!.cart.id, confirmation_token: "guessed" })).data.error).toBe("confirmation_invalid");

    const conf = await r.call("request_confirmation", { quote_id: eats!.quote.id });
    expect(r.elicitations[0]).toMatch(/TOTAL\s+\$62\.71/);
    expect(r.elicitations[0]).toContain("2 × Pad Thai (Shrimp)");
    const token = conf.data.confirmation_token.token;
    const placed = await r.call("place_order", { cart_id: eats!.cart.id, confirmation_token: token });
    expect(placed.data.status).toBe("placed");
    expect((await r.call("place_order", { cart_id: eats!.cart.id, confirmation_token: token })).isError).toBe(true);
  });

  it("no token when the user declines", async () => {
    const r = await connected({ config: { enablePlaceOrder: true }, answer: false });
    const [eats] = await quoteBoth(r);
    const conf = await r.call("request_confirmation", { quote_id: eats!.quote.id });
    expect(conf.data.status).toBe("declined");
    expect(conf.data.confirmation_token).toBeUndefined();
  });

  it("a token dies if the price changes after the user said yes", async () => {
    const r = await connected({ config: { enablePlaceOrder: true } });
    const [eats] = await quoteBoth(r);
    const conf = await r.call("request_confirmation", { quote_id: eats!.quote.id });
    // Fees change between the yes and the order (here: a membership kicks in).
    await r.call("save_preferences", { memberships: { mockeats: true } });
    const res = await r.call("place_order", { cart_id: eats!.cart.id, confirmation_token: conf.data.confirmation_token.token });
    expect(res.data.error).toBe("confirmation_invalid");
    expect(res.data.message).toMatch(/changed after the user confirmed/);
    expect(res.data.next_step).toMatch(/Nothing was ordered/);
  });

  it("a token for one cart can't place another", async () => {
    const r = await connected({ config: { enablePlaceOrder: true } });
    const [eats, dash] = await quoteBoth(r);
    const conf = await r.call("request_confirmation", { quote_id: eats!.quote.id });
    const res = await r.call("place_order", { cart_id: dash!.cart.id, confirmation_token: conf.data.confirmation_token.token });
    expect(res.data.error).toBe("confirmation_invalid");
  });

  it("clients without a confirmation dialog get a local page only the user can click", async () => {
    const r = await connected({ config: { enablePlaceOrder: true }, elicitation: false });
    const [eats] = await quoteBoth(r);
    const first = await r.call("request_confirmation", { quote_id: eats!.quote.id });
    expect(first.data.status).toBe("awaiting_user");
    expect(first.data.confirmation_token).toBeUndefined();
    // Asking again does not help the model: still waiting, still no token.
    expect((await r.call("request_confirmation", { quote_id: eats!.quote.id })).data.status).toBe("awaiting_user");

    const html = await (await fetch(first.data.confirm_url)).text();
    expect(html).toMatch(/TOTAL\s+\$62\.71/);
    const k = /name="k" value="([0-9a-f]+)"/.exec(html)![1];
    await fetch(first.data.confirm_url, { method: "POST", body: `answer=yes&k=${k}`, headers: { "content-type": "application/x-www-form-urlencoded" } });

    const second = await r.call("request_confirmation", { quote_id: eats!.quote.id });
    expect(second.data.status).toBe("confirmed");
    const placed = await r.call("place_order", { cart_id: eats!.cart.id, confirmation_token: second.data.confirmation_token.token });
    expect(placed.data.status).toBe("placed");
    await r.ctx.confirm.close();
  });
});
