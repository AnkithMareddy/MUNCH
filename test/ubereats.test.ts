import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSessions } from "../src/browser/sessions.js";
import { UberEatsAdapter } from "../src/providers/ubereats/adapter.js";
import { dollars, e5ToCents, etaUpper, findEmbeddedStore, parseCheckout, parseFeed, parseMenuItem, parseStore, ParseError, storeUrlId } from "../src/providers/ubereats/parse.js";
import { UBEREATS } from "../src/providers/ubereats/site.js";
import { Throttle, TtlCache } from "../src/util/throttle.js";
import { checkoutData, FEED_HOME, FEED_SEARCH, IDS, ITEMS, startFakeUberEats, STORE_DATA, STORE_PATH, type FakeUberEats } from "./fixtures/ubereatsFake.js";
import { rig, type Rig } from "./helpers.js";

const RID = `ubereats:${IDS.STORE}`;

describe("Uber Eats parsing (shapes from a real recording)", () => {
  it("reads money, E5 amounts and time ranges", () => {
    expect(dollars("$1,234.50")).toBe(123450);
    expect(dollars("-$0.49")).toBe(-49);
    expect(dollars("Free")).toBe(0);
    expect(dollars("Uber One")).toBeUndefined();
    expect(e5ToCents(3894000)).toBe(3894);
    expect(e5ToCents({ high: 0, low: 3307000, unsigned: false })).toBe(3307);
    expect(etaUpper("27–45 Min")).toBe(45);
    expect(etaUpper("Delivered in 12 to 24 min")).toBe(24);
    expect(etaUpper("12 min")).toBe(12);
    expect(storeUrlId("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")).toBe("ChssPU5fSmuMfZ4PGis8TQ"); // same encoding as the id pairs seen in the recording
  });

  it("finds stores in carousels and in search results", () => {
    const home = parseFeed(FEED_HOME);
    expect(home.map((s) => s.restaurant.name)).toEqual(["Thai Sample", "Burger Sample"]);
    expect(home[0]!.restaurant).toMatchObject({ id: RID, rating: 4.8, eta_min: 45, delivery_fee_cents: 49 });
    expect(home[0]!.actionUrl).toBe(`/store/thai-sample-main-st/${storeUrlId(IDS.STORE)}`);
    expect(parseFeed(FEED_SEARCH)).toHaveLength(1);
    expect(() => parseFeed({})).toThrow(ParseError);
  });

  it("reads a restaurant and its menu, listing each dish once", () => {
    const { restaurant, items } = parseStore(STORE_DATA);
    expect(restaurant).toMatchObject({ name: "Thai Sample", address: "123 Main St, Springfield, CA 90000", lat: 33.6618, rating: 4.8, rating_count: 2000, eta_min: 45, cuisines: ["Thai", "Asian Fusion"] });
    expect(items.map((i) => [i.name, i.category, i.price_cents, i.has_options])).toEqual([
      ["Panang Curry", "Curries", 100, true],
      ["Thai Ice Coffee", "Drinks", 475, false],
    ]);
    expect(items[0]!.price_note).toBe("Priced by add-ons");
  });

  it("reads a dish's option groups", () => {
    const item = parseMenuItem(ITEMS[IDS.CURRY], RID);
    expect(item.modifiers.map((m) => [m.name, m.required, m.options.length])).toEqual([["Curry Protein Choice", true, 3], ["Spice Level", false, 2]]);
    expect(item.modifiers[0]!.options[2]).toMatchObject({ name: "Chicken", price_delta_cents: 1595 });
  });

  it("reads the checkout: full fees, savings as separate lines, and a before-tip total", () => {
    // The figures from the real recording: $25.20 subtotal, $38.94 total including a $6.61 preselected tip.
    const q = parseCheckout({
      checkoutPayloads: {
        total: { total: { value: { amountE5: 3894000 } } },
        subtotal: { subtotal: { value: { amountE5: 2520000 } } },
        fareBreakdown: {
          charges: [
            { title: { text: "Subtotal" }, value: { text: "$25.20" }, fareBreakdownChargeMetadata: { fareInfoID: "eats_fare.subtotal" } },
            { title: { text: "Delivery Fee" }, value: { text: "$0.00", accessibilityText: "before promotion: $0.49, now: $0.00" }, action: { infoBottomSheet: { paragraphs: [{ subtitle: "Saving with Uber One" }] } }, fareBreakdownChargeMetadata: { fareInfoID: "eats.mp.charges.bundled_delivery_fee" } },
            { title: { text: "Other Fees" }, value: { text: "$5.17", accessibilityText: "before promotion: $5.42, now: $5.17" } },
            { title: { text: "Taxes" }, value: { text: "$1.96" } },
          ],
        },
        upfrontTipping: { options: [{ amount: 496, isSelectedTip: false }, { amount: 661, isSelectedTip: true }] },
        eta: { rangeText: "25–40 min" },
      },
    });
    expect(q).toMatchObject({ subtotal_cents: 2520, delivery_fee_cents: 49, tax_cents: 196, other_fees: [{ label: "Other Fees", amount_cents: 542 }], selected_tip_cents: 661, total_before_tip_cents: 3233, eta_min: 40, verified: true });
    expect(q.discounts).toEqual([
      { label: "Uber One: lower delivery fee", amount_cents: 49, kind: "membership" },
      { label: "Other Fees discount", amount_cents: 25, kind: "promo" },
    ]);
    // Every line accounted for: fees − savings = Uber's own before-tip total.
    expect(q.subtotal_cents + q.delivery_fee_cents + 542 + q.tax_cents - 74).toBe(q.total_before_tip_cents);
  });

  it("finds a store inside state shipped with the page, however it is wrapped", () => {
    const state = { a: { b: [{ stores: { x: { data: STORE_DATA } } }] } };
    const json = JSON.stringify(state);
    for (const text of [json, encodeURIComponent(json), JSON.stringify(json), json.replace(/"/g, "\\u0022")]) {
      expect(findEmbeddedStore(["unrelated", text], IDS.STORE)?.title).toBe("Thai Sample");
    }
    expect(findEmbeddedStore([json], IDS.OTHER_STORE)).toBeUndefined();
    expect(findEmbeddedStore(["{broken json " + IDS.STORE + " catalogSectionsMap"], IDS.STORE)).toBeUndefined();
  });

  it("refuses to guess when the breakdown is missing or unreadable", () => {
    expect(() => parseCheckout({ checkoutPayloads: {} })).toThrow(ParseError);
    const q = parseCheckout({ checkoutPayloads: { total: { total: { value: { amountE5: 1000000 } } }, subtotal: { subtotal: { value: { amountE5: 900000 } } }, fareBreakdown: { charges: [{ title: { text: "Mystery" }, value: { text: "see app" } }] } } });
    expect(q.verified).toBe(false);
    expect(q.estimate_notes[0]).toMatch(/Mystery/);
  });
});

describe("Uber Eats adapter, end to end against a local stand-in site", () => {
  let fake: FakeUberEats;
  let browsers: BrowserSessions;
  let r: Rig;
  let available = true;
  const ORDER = [{ name: "panang curry", quantity: 2, modifiers: ["chicken", "spicy"] }, { name: "thai iced coffee", quantity: 1 }];

  beforeAll(async () => {
    fake = await startFakeUberEats();
    const o = fake.origin;
    const site = { ...UBEREATS, homeUrl: `${o}/`, loginUrl: `${o}/login-redirect/`, cookieDomains: [o], searchUrl: (q: string) => `${o}/search?q=${encodeURIComponent(q)}`, feedUrl: () => `${o}/feed` };
    browsers = new BrowserSessions(join(mkdtempSync(join(tmpdir(), "munch-ue-")), "profiles"), { headless: true, channel: "chromium" });
    r = await rig({ config: { enableMock: false } });
    r.ctx.throttle = new Throttle(() => 0);
    r.ctx.registry.register(new UberEatsAdapter(browsers, r.ctx.sessions, site));
    try {
      await browsers.context("ubereats");
    } catch {
      available = false;
    }
  }, 60_000);

  afterAll(async () => {
    await browsers.closeAll();
    fake.server.close();
  });

  it("signs in through the site's own page", async (t) => {
    if (!available) return t.skip();
    expect((await r.call("search", { query: "thai" })).data.error).toBe("no_connected_providers");
    const first = (await r.call("connect_provider", { provider: "ubereats" })).data;
    expect(first.status).toBe("pending");
    expect(first.notice).toMatch(/terms generally prohibit/);
    await (await browsers.page("ubereats")).click("#go"); // the user signs in
    await expect.poll(async () => (await r.call("list_providers")).data.available[0].status, { timeout: 8000 }).toBe("connected");
  }, 30_000);

  it("searches, and says whose address the results are for", async (t) => {
    if (!available) return t.skip();
    const res = (await r.call("search", { query: "thai" })).data;
    expect(res.results.map((x: any) => x.name)).toEqual(["Thai Sample"]);
    expect(res.results[0]).toMatchObject({ id: RID, rating: 4.8, eta_min: 45 });
    expect(res.notes.join(" ")).toMatch(/delivery address currently selected in the user's Uber Eats account/);
    const home = (await r.call("search", {})).data;
    expect(home.count).toBe(2);
  }, 30_000);

  it("reads the menu from the restaurant page", async (t) => {
    if (!available) return t.skip();
    const menu = (await r.call("get_menu", { provider: "ubereats", restaurant_id: RID })).data;
    expect(menu.items.map((i: any) => i.name)).toEqual(["Panang Curry", "Thai Ice Coffee"]);
    expect(menu.items[0]).toMatchObject({ has_options: true, price_note: "Priced by add-ons", modifiers: [] });
    expect(new URL((await browsers.page("ubereats")).url()).pathname).toBe(STORE_PATH);
  }, 30_000);

  it("reads the menu when the site ships it inside the page instead of loading it separately", async (t) => {
    if (!available) return t.skip();
    for (const mode of ["encoded", "plain"] as const) {
      fake.state.ssr = mode;
      fake.state.calls.length = 0;
      r.ctx.menuCache = new TtlCache(60000);
      (r.ctx.registry.get("ubereats") as any).open = undefined;
      const menu = await r.call("get_menu", { provider: "ubereats", restaurant_id: RID });
      expect(menu.isError).toBe(false);
      expect(menu.data.items.map((i: any) => i.name)).toEqual(["Panang Curry", "Thai Ice Coffee"]);
      expect(fake.state.calls).not.toContain("getStoreV1");
    }
    // Shipped in a form we can't read: fall back to the site's own in-page navigation.
    fake.state.ssr = "hidden";
    fake.state.calls.length = 0;
    r.ctx.menuCache = new TtlCache(60000);
    (r.ctx.registry.get("ubereats") as any).open = undefined;
    const menu = await r.call("get_menu", { provider: "ubereats", restaurant_id: RID });
    expect(menu.data.items).toHaveLength(2);
    expect(fake.state.calls).toContain("getStoreV1");
    fake.state.ssr = undefined;
    (r.ctx.registry.get("ubereats") as any).open = undefined;
  }, 90_000);

  it("refuses to touch a cart the user already has, until they say so", async (t) => {
    if (!available) return t.skip();
    fake.seedCart([{ title: "Old Spring Rolls", quantity: 2 }]);
    const res = await r.call("build_cart", { provider: "ubereats", restaurant_id: RID, items: ORDER });
    expect(res.data.error).toBe("existing_cart");
    expect(res.data.message).toContain("2 × Old Spring Rolls");
    expect(fake.state.calls.filter((c) => /DraftOrderV2/.test(c))).toEqual([]);
    fake.state.drafts.clear();
  }, 90_000);

  let cartId = "";
  let quoteId = "";
  it("builds the cart by clicking the site's own dialog, and the site receives exactly the order", async (t) => {
    if (!available) return t.skip();
    const res = await r.call("build_cart", { provider: "ubereats", restaurant_id: RID, items: ORDER });
    expect(res.isError).toBe(false);
    const cart = res.data.cart;
    cartId = cart.id;
    // Options were loaded only for the dish that has them, and priced from them.
    expect(cart.lines.map((l: any) => [l.name, l.quantity, l.unit_price_cents, l.selected_options.map((o: any) => o.option)])).toEqual([
      ["Panang Curry", 2, 1695, ["Chicken", "(Spicy)"]],
      ["Thai Ice Coffee", 1, 475, []],
    ]);
    expect(cart.subtotal_cents).toBe(3865);

    const draft = [...fake.state.drafts.values()][0]!;
    expect(draft.items.map((i) => i.title)).toEqual(["Panang Curry", "Panang Curry", "Thai Ice Coffee"]);
    expect(Object.values(draft.items[0].customizations).flat().map((o: any) => o.title)).toEqual(["Chicken", "(Spicy)"]);
    expect(fake.state.calls.filter((c) => /DraftOrderV2/.test(c))).toEqual(["createDraftOrderV2", "addItemsToDraftOrderV2", "addItemsToDraftOrderV2"]);
  }, 60_000);

  it("quotes from the checkout page: verified, itemized, with the user's tip instead of Uber's preselected one", async (t) => {
    if (!available) return t.skip();
    const res = await r.call("quote_cart", { cart_id: cartId, tip: { type: "flat", cents: 500 } });
    expect(res.isError).toBe(false);
    const q = res.data.quote;
    quoteId = q.id;
    const expected = checkoutData("x", [{ price: 3865, quantity: 1, customizations: {} }]).checkoutPayloads;
    const uberTotal = expected.total.total.value.amountE5 / 1000;
    const uberTip = expected.upfrontTipping.options[1]!.amount;
    expect(q).toMatchObject({ verified: true, subtotal_cents: 3865, delivery_fee_cents: 49, tax_cents: Math.round(3865 * 0.0775), tip_cents: 500, tip_status: "set", eta_min: 45 });
    expect(q.total_cents).toBe(uberTotal - uberTip + 500);
    expect(q.discounts.map((d: any) => [d.label, d.kind])).toEqual([["Uber One: lower delivery fee", "membership"], ["Uber One: lower other fees", "membership"]]);
    expect(res.text).toMatch(/Other Fees\s+\$7\.73/);
    expect(res.text).toMatch(/TOTAL\s+\$/);
    expect(new URL((await browsers.page("ubereats")).url()).pathname).toBe("/checkout");
  }, 60_000);

  it("reaches checkout when the site shows no cart button at all, and says how it got there", async (t) => {
    if (!available) return t.skip();
    fake.state.cartUi = "none";
    const page = await browsers.page("ubereats");
    await page.goto(fake.origin + "/feed"); // leave checkout, as a user who wandered off would
    const q = await r.call("quote_cart", { cart_id: cartId, tip: { type: "flat", cents: 500 } });
    expect(q.isError).toBe(false);
    expect(q.data.quote.verified).toBe(true);
    quoteId = q.data.quote.id;
    const trace = (r.ctx.registry.get("ubereats") as any).trace.join(" | ");
    expect(trace).toMatch(/opened the cart with \[aria-label="View cart"\]/); // the earlier quote
    expect(trace).toMatch(/no button found, opening the checkout page directly/);
    fake.state.cartUi = undefined;
  }, 60_000);

  it("hands off at checkout and never presses Place order", async (t) => {
    if (!available) return t.skip();
    const res = (await r.call("open_checkout", { cart_id: cartId })).data;
    expect(res.opened_in_browser).toBe(true);
    expect(res.tell_user).toMatch(/tap "Place order" yourself/);
    expect(res.tell_user).toMatch(/Uber Eats has its own tip preselected \(\$\d+\.\d\d\)/);
    expect(await (await browsers.page("ubereats")).locator('[data-testid="place-order-btn"]').count()).toBe(1);
    expect(fake.state.calls).not.toContain("checkoutOrdersByDraftOrdersV1");
    // Direct ordering stays unavailable for Uber Eats even if someone turns the flag on.
    r.ctx.config.enablePlaceOrder = true;
    const conf = await r.call("request_confirmation", { quote_id: quoteId });
    const placed = await r.call("place_order", { cart_id: cartId, confirmation_token: conf.data.confirmation_token.token });
    expect(placed.data.error).toBe("not_supported");
    expect(fake.state.calls).not.toContain("checkoutOrdersByDraftOrdersV1");
    r.ctx.config.enablePlaceOrder = false;
  }, 60_000);

  it("labels the total an estimate when Uber's total doesn't match the line items", async (t) => {
    if (!available) return t.skip();
    fake.state.wrongSum = true;
    const q = (await r.call("quote_cart", { cart_id: cartId, tip: { type: "flat", cents: 500 } })).data.quote;
    expect(q.verified).toBe(false);
    expect(q.display.total).toMatch(/estimate/);
    expect(q.estimate_notes.join(" ")).toMatch(/Line items add up to/);
    fake.state.wrongSum = false;
  }, 60_000);

  it("catches the site adding something other than what was asked", async (t) => {
    if (!available) return t.skip();
    fake.state.drafts.clear();
    fake.state.breakRadios = true; // the dialog now lists choices in a different order than the menu data
    const res = await r.call("build_cart", { provider: "ubereats", restaurant_id: RID, items: [{ name: "panang curry", quantity: 1, modifiers: ["chicken"] }] });
    expect(res.data.error).toBe("cart_mismatch");
    expect(res.data.next_step).toMatch(/Do not quote or check out this cart/);
    fake.state.breakRadios = false;
    fake.state.drafts.clear();
  }, 60_000);

  it("fails clearly, without guessing, when the site doesn't behave as recorded", async (t) => {
    if (!available) return t.skip();
    fake.state.swapItem = true; // the site opens a different restaurant than the one requested
    (r.ctx.registry.get("ubereats") as any).open = undefined; // as if the store page had not been opened yet
    r.ctx.menuCache = new (await import("../src/util/throttle.js")).TtlCache(1);
    await new Promise((x) => setTimeout(x, 5));
    const res = await r.call("build_cart", { provider: "ubereats", restaurant_id: RID, items: [{ name: "thai ice coffee", quantity: 1 }] });
    expect(res.data.error).toBe("site_changed");
    expect(res.data.message).toMatch(/a different restaurant opened/);
    expect(res.data.next_step).toMatch(/look at the browser window/);
    fake.state.swapItem = false;
    // And one app failing does not sink a search: it is reported as skipped.
    fake.state.emptySearch = true;
    expect((await r.call("search", { query: "zzz" })).data.count).toBe(0);
    fake.state.emptySearch = false;
  }, 60_000);

  it("notices a sign-out and asks to reconnect", async (t) => {
    if (!available) return t.skip();
    await (await browsers.context("ubereats")).clearCookies();
    const res = await r.call("get_menu", { provider: "ubereats", restaurant_id: RID });
    expect(res.isError).toBe(true);
    expect(res.data.error).toMatch(/session_expired|not_connected/);
  }, 30_000);
});
