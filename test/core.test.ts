import { describe, expect, it } from "vitest";
import { mapOrderToMenu } from "../src/core/cartMapper.js";
import { detectGhostKitchens } from "../src/core/compare/ghostKitchen.js";
import { assignMatchGroups, normalizeAddress, normalizeRestaurantName, sameRestaurantConfidence } from "../src/core/compare/matching.js";
import { rankQuotes } from "../src/core/compare/ranking.js";
import { ConfirmationService } from "../src/core/confirm.js";
import { fmt, pct, tipCents } from "../src/core/money.js";
import { assembleQuote } from "../src/core/quote.js";
import { similarity } from "../src/core/text.js";
import type { Cart, MenuItem, Quote, Restaurant } from "../src/core/types.js";
import type { ProviderQuote } from "../src/providers/ProviderAdapter.js";
import { redact } from "../src/util/logger.js";

const r = (over: Partial<Restaurant> & { id: string; name: string }): Restaurant => ({ provider: "mockeats", cuisines: [], supports_pickup: false, ...over });

describe("money", () => {
  it("formats cents and never uses floats for totals", () => {
    expect(fmt(1234)).toBe("$12.34");
    expect(fmt(5)).toBe("$0.05");
    expect(fmt(-250)).toBe("-$2.50");
    expect(pct(1999, 8.875)).toBe(177);
    expect(tipCents(2000, { type: "percent", value: 15 })).toBe(300);
    expect(tipCents(2000, { type: "flat", cents: 450 })).toBe(450);
  });
});

describe("text similarity", () => {
  it("handles spelling variants and extra words", () => {
    expect(similarity("Pad Thai", "Phad Thai Noodles")).toBeGreaterThan(0.6);
    expect(similarity("margherita pizza", "Pizza Margherita")).toBeGreaterThan(0.8);
    expect(similarity("pad thai", "Green Curry")).toBeLessThan(0.3);
  });
});

describe("restaurant matching", () => {
  it("normalizes names and addresses", () => {
    expect(normalizeRestaurantName("Luigi's Pizzeria - Court St (Delivery)")).toBe("luigis pizzeria");
    expect(normalizeAddress("123 Court Street, Brooklyn, NY")).toBe(normalizeAddress("123 Court St"));
    expect(normalizeAddress("500 Industrial Way, Unit 4, Brooklyn")).toBe("500 industrial way");
  });

  it("matches the same restaurant across apps", () => {
    const a = r({ id: "mockeats:1", name: "Luigi's Pizzeria", address: "123 Court Street, Brooklyn", lat: 40.6895, lng: -73.9925 });
    const b = r({ id: "mockdash:1", provider: "mockdash", name: "Luigis Pizzeria - Court St", address: "123 Court St, Brooklyn", lat: 40.6896, lng: -73.9925 });
    expect(sameRestaurantConfidence(a, b)).toBeGreaterThan(0.8);
    const [ga, gb] = assignMatchGroups([a, b]);
    expect(ga!.match_group).toBe(gb!.match_group);
  });

  it("does not merge two branches of a chain", () => {
    const a = r({ id: "mockeats:1", name: "Burger Barn", address: "240 Atlantic Ave", lat: 40.6884, lng: -73.9891 });
    const b = r({ id: "mockdash:2", provider: "mockdash", name: "Burger Barn", address: "900 Flatbush Ave", lat: 40.65, lng: -73.96 });
    expect(sameRestaurantConfidence(a, b)).toBe(0);
    const [ga, gb] = assignMatchGroups([a, b]);
    expect(ga!.match_group).not.toBe(gb!.match_group);
  });

  it("does not merge different restaurants at one address", () => {
    const a = r({ id: "mockeats:1", name: "Wing Mania", address: "500 Industrial Way" });
    const b = r({ id: "mockdash:2", provider: "mockdash", name: "Pasta Planet", address: "500 Industrial Way" });
    expect(sameRestaurantConfidence(a, b)).toBe(0);
  });
});

describe("ghost kitchen detection", () => {
  const brands = [{ name: "It's Just Wings", operator: "Chili's" }];
  it("flags known virtual brands and says why", () => {
    const f = detectGhostKitchens([r({ id: "x", name: "Its Just Wings", address: "1 Main St" })], undefined, brands).get("x")!;
    expect(f.flagged).toBe(true);
    expect(f.reasons[0]).toContain("Chili's");
  });

  it("flags three or more brands at one address, counting cross-app duplicates once", () => {
    const list = [
      r({ id: "a", name: "Wing Mania", address: "500 Industrial Way, Unit 4" }),
      r({ id: "a2", provider: "mockdash", name: "Wing Mania (Delivery)", address: "500 Industrial Way" }),
      r({ id: "b", name: "Burger Bros", address: "500 Industrial Way" }),
    ];
    expect(detectGhostKitchens(list, list, []).get("a")!.flagged).toBe(false);
    const more = [...list, r({ id: "c", name: "Pasta Planet", address: "500 Industrial Way" })];
    const f = detectGhostKitchens(more, more, []).get("a")!;
    expect(f.flagged).toBe(true);
    expect(f.reasons.join(" ")).toMatch(/3 different brands/);
    expect(f.reasons.join(" ")).toContain("Pasta Planet");
  });

  it("uses context listings that are not in the result set", () => {
    const target = [r({ id: "a", name: "Wing Mania", address: "500 Industrial Way" })];
    const context = [r({ id: "b", name: "Burger Bros", address: "500 Industrial Way" }), r({ id: "c", name: "Pasta Planet", address: "500 Industrial Way" })];
    expect(detectGhostKitchens(target, context, []).get("a")!.flagged).toBe(true);
  });

  it("flags delivery-only wording and provider labels; leaves normal restaurants alone", () => {
    expect(detectGhostKitchens([r({ id: "a", name: "Pasta Planet", description: "Delivery only. Fresh pasta." })], undefined, []).get("a")!.flagged).toBe(true);
    expect(detectGhostKitchens([r({ id: "a", name: "Foo", provider_says_virtual: true })], undefined, []).get("a")!.flagged).toBe(true);
    const normal = detectGhostKitchens([r({ id: "a", name: "Luigi's Pizzeria", address: "123 Court St" })], undefined, brands).get("a")!;
    expect(normal).toEqual({ flagged: false, confidence: 0, reasons: [] });
  });
});

const menu: MenuItem[] = [
  {
    id: "i1", name: "Phad Thai Noodles", price_cents: 1500, dietary_tags: [], available: true,
    modifiers: [
      { id: "m1", name: "Protein", required: true, min_select: 1, max_select: 1, options: [{ id: "o1", name: "Chicken", price_delta_cents: 0, is_default: true }, { id: "o2", name: "Shrimp", price_delta_cents: 300 }] },
      { id: "m2", name: "Spice Level", required: false, min_select: 0, max_select: 1, options: [{ id: "o3", name: "Medium", price_delta_cents: 0 }] },
    ],
  },
  { id: "i2", name: "Crispy Veggie Spring Rolls", price_cents: 700, dietary_tags: ["vegan"], available: true, modifiers: [] },
  { id: "i3", name: "Thai Iced Tea", price_cents: 500, dietary_tags: [], available: false, modifiers: [] },
];
const map = (desired: Parameters<typeof mapOrderToMenu>[0]["desired"]) => mapOrderToMenu({ provider: "mockdash", restaurantId: "mockdash:t", restaurantName: "T", mode: "delivery", desired, menu });

describe("cart mapping", () => {
  it("maps differently named dishes and options, with prices", () => {
    const cart = map([{ name: "pad thai", quantity: 2, modifiers: ["shrimp", "medium spice"] }, { name: "veggie spring rolls", quantity: 1 }]);
    expect(cart.lines.map((l) => l.name)).toEqual(["Phad Thai Noodles", "Crispy Veggie Spring Rolls"]);
    expect(cart.lines[0]!.selected_options.map((o) => o.option)).toEqual(["Shrimp", "Medium"]);
    expect(cart.subtotal_cents).toBe(2 * 1800 + 700);
    expect(cart.unmapped).toEqual([]);
  });

  it("defaults required options and warns", () => {
    const cart = map([{ name: "Phad Thai Noodles", quantity: 1 }]);
    expect(cart.lines[0]!.selected_options).toEqual([{ modifier: "Protein", option: "Chicken", price_delta_cents: 0 }]);
    expect(cart.warnings.join(" ")).toContain('Defaulted to "Chicken"');
  });

  it("reports missing dishes, unavailable items and unknown options instead of guessing", () => {
    const cart = map([{ name: "cheeseburger", quantity: 1 }, { name: "thai iced tea", quantity: 1 }, { name: "pad thai", quantity: 1, modifiers: ["extra peanuts"] }]);
    expect(cart.unmapped).toEqual(["cheeseburger", "thai iced tea"]);
    expect(cart.warnings.join(" ")).toContain('no option like "extra peanuts"');
  });

  it("uses an exact item id when given", () => {
    expect(map([{ name: "whatever", quantity: 1, item_id: "i2" }]).lines[0]!.name).toBe("Crispy Veggie Spring Rolls");
  });
});

const pq = (over: Partial<ProviderQuote> = {}): ProviderQuote => ({
  subtotal_cents: 2000, delivery_fee_cents: 299, service_fee_cents: 300, small_order_fee_cents: 0, other_fees: [], tax_cents: 178,
  discounts: [], total_before_tip_cents: 2777, eta_min: 30, verified: true, estimate_notes: [], ...over,
});
const cart = (id = "c1"): Cart => ({ ...map([{ name: "Crispy Veggie Spring Rolls", quantity: 1 }]), id });

describe("quote assembly", () => {
  it("adds the user's tip to the provider's total", () => {
    const q = assembleQuote({ cart: cart(), pq: pq(), tip: { type: "percent", value: 15 } });
    expect(q.tip_cents).toBe(300);
    expect(q.total_cents).toBe(3077);
    expect(q.verified).toBe(true);
    expect(q.tip_status).toBe("set");
  });

  it("marks the tip as needing user input when none was given", () => {
    const q = assembleQuote({ cart: cart(), pq: pq() });
    expect(q.tip_status).toBe("needs_user_input");
    expect(q.total_cents).toBe(2777);
  });

  it("downgrades to an estimate when line items don't add up to the app's total", () => {
    const q = assembleQuote({ cart: cart(), pq: pq({ total_before_tip_cents: 2900 }) });
    expect(q.verified).toBe(false);
    expect(q.total_cents).toBe(2900);
    expect(q.estimate_notes[0]).toContain("$27.77");
  });

  it("downgrades to an estimate when the app's total can't be read", () => {
    expect(assembleQuote({ cart: cart(), pq: pq({ total_before_tip_cents: undefined }) }).verified).toBe(false);
  });

  it("changes the hash when the tip or total changes", () => {
    const a = assembleQuote({ cart: cart(), pq: pq(), tip: { type: "flat", cents: 300 } });
    const b = assembleQuote({ cart: cart(), pq: pq(), tip: { type: "flat", cents: 400 } });
    const c = assembleQuote({ cart: cart(), pq: pq(), tip: { type: "flat", cents: 300 } });
    expect(a.quote_hash).not.toBe(b.quote_hash);
    expect(a.quote_hash).toBe(c.quote_hash);
  });
});

const quote = (over: Partial<Quote>): Quote => ({ ...assembleQuote({ cart: cart(), pq: pq(), tip: { type: "flat", cents: 300 } }), match_group: "g", rating: 4.5, ...over });

describe("ranking", () => {
  const cheapSlow = quote({ id: "a", provider: "mockeats", total_cents: 3000, eta_min: 50 });
  const priceyFast = quote({ id: "b", provider: "mockdash", total_cents: 3400, eta_min: 20 });

  it("ranks by all-in total by default and states the saving", () => {
    const c = rankQuotes([priceyFast, cheapSlow]);
    expect(c.ranked[0]!.quote.id).toBe("a");
    expect(c.recommendation).toContain("$30.00 all-in");
    expect(c.recommendation).toContain("$4.00 cheaper than the next best");
    expect(c.ranked[0]!.reason).toMatch(/Lowest all-in total/);
    expect(c.ranked[1]!.reason).toMatch(/\$4\.00 more than the cheapest; fastest/);
  });

  it("re-ranks when the user cares more about speed", () => {
    const c = rankQuotes([cheapSlow, priceyFast], { weights: { total: 0.2, eta: 0.8, rating: 0, fit: 0 } });
    expect(c.ranked[0]!.quote.id).toBe("b");
    expect(c.recommendation).toContain("costs $4.00 more");
  });

  it("labels estimates and never states them as final", () => {
    const c = rankQuotes([quote({ id: "a", total_cents: 3000, verified: false }), priceyFast]);
    expect(c.recommendation).toContain("~$30.00 (estimate)");
    expect(c.recommendation).toContain("about $4.00 cheaper");
    expect(c.table_markdown).toContain("~$30.00 (estimate)");
    expect(c.warnings.join(" ")).toMatch(/estimate/);
  });

  it("warns about missing tip, different restaurants, partial orders, budget and ghost kitchens", () => {
    const c = rankQuotes(
      [quote({ id: "a", tip_status: "needs_user_input", tip_cents: 0, match_group: "x", fit: 0.5 }), quote({ id: "b", total_cents: 9000, ghost_kitchen: { flagged: true, confidence: 0.9, reasons: ["Known virtual brand."] } })],
      { budget_cents: 2000 },
    );
    const w = c.warnings.join(" ");
    expect(w).toMatch(/Tip has not been set/);
    expect(w).toMatch(/different restaurants/);
    expect(w).toMatch(/full order/);
    expect(w).toMatch(/over the \$20\.00 budget/);
    expect(c.table_markdown).toContain("👻");
    expect(c.ranked.find((x) => x.quote.id === "b")!.reason).toMatch(/likely ghost kitchen/);
  });
});

describe("confirmation tokens", () => {
  it("works once, for the right cart and hash only", () => {
    const s = new ConfirmationService();
    const { token } = s.mintToken("c1", "h1");
    expect(s.consumeToken(token, "c1", "h1")).toEqual({ ok: true });
    expect(s.consumeToken(token, "c1", "h1").ok).toBe(false);
    expect(s.consumeToken("made-up", "c1", "h1").ok).toBe(false);
    expect(s.consumeToken(s.mintToken("c1", "h1").token, "c2", "h1").ok).toBe(false);
    const changed = s.consumeToken(s.mintToken("c1", "h1").token, "c1", "h2");
    expect(changed.ok === false && changed.reason).toMatch(/changed after the user confirmed/);
  });

  it("expires after five minutes", () => {
    let now = 1_000_000;
    const s = new ConfirmationService(() => now);
    const { token } = s.mintToken("c1", "h1");
    now += 5 * 60 * 1000 + 1;
    expect(s.consumeToken(token, "c1", "h1").ok).toBe(false);
  });

  it("local confirm page: needs the page's secret, and only a click confirms", async () => {
    const s = new ConfirmationService();
    const { url } = await s.createLocalConfirmation({ cartId: "c1", quoteId: "q1", quoteHash: "h1", title: "Confirm <b>", body: "TOTAL $1.00" });
    const html = await (await fetch(url)).text();
    expect(html).toContain("TOTAL $1.00");
    expect(html).not.toContain("<b>");
    expect((await fetch(url, { method: "POST", body: "answer=yes&k=wrong", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(403);
    expect(s.findPending("q1")!.status).toBe("waiting");
    const k = /name="k" value="([0-9a-f]+)"/.exec(html)![1];
    expect((await fetch(url, { method: "POST", body: `answer=yes&k=${k}`, headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } })).status).toBe(403);
    await fetch(url, { method: "POST", body: `answer=yes&k=${k}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(s.findPending("q1")!.status).toBe("confirmed");
    await s.close();
  });
});

describe("log redaction", () => {
  it("strips personal data by key and by pattern", () => {
    const out = JSON.stringify(redact({ tool: "search", address: "123 Court St", msg: "user a@b.com at 718-555-0101 lives at 42 Wallaby Way", nested: { confirmation_token: "abc", ms: 5 } }));
    expect(out).not.toMatch(/Court|a@b\.com|555-0101|Wallaby|abc/);
    expect(out).toContain('"tool":"search"');
    expect(out).toContain('"ms":5');
  });
});
