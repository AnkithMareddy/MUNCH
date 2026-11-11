/**
 * A local stand-in for ubereats.com, for tests.
 *
 * The JSON shapes, endpoint names, URL layout, data-testid hooks and input
 * naming are copied from a real recording of the site (Nov 2026). The values
 * (restaurant, dishes, prices) are made up. It proves the adapter's logic
 * against the recorded structure; it cannot prove the live site still matches.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const STORE = "11111111-2222-4333-8444-555555555555";
export const OTHER_STORE = "99999999-2222-4333-8444-555555555555";
const SECTION = "e9b059bc-0000-4000-8000-3021f9fef701";
const CURRY = "9a306193-0000-4000-8000-d16e8faca611";
const COFFEE = "25cba964-0000-4000-8000-831054faa354";
const G_PROTEIN = "27219645-0000-4000-8000-31e63da384a7";
const G_SPICE = "242bc6c7-0000-4000-8000-af634f631069";
const O = { none: "008a6ef7-0000-4000-8000-ac6adacb32da", tofu: "dc9fbc62-0000-4000-8000-f5370a9ba673", chicken: "5e774b6a-0000-4000-8000-9140ebda1e2c", mild: "8c60b221-0000-4000-8000-f7fc10db0219", spicy: "f225d598-0000-4000-8000-09ac00866703" };

const b64 = (uuid: string) => Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
export const STORE_PATH = `/store/thai-sample-main-st/${b64(STORE)}`;

const storeCard = (uuid: string, name: string, rating: string, eta: [number, number], fee: string) => ({
  storeUuid: uuid,
  title: { text: name },
  meta: [
    { text: "Uber One benefits apply", badgeType: "MembershipBenefit", badgeDataWithFallback: { membership: { brandingType: "UBER_ONE", badgeTextType: "DELIVERY_FEE_REPLACEMENT", originalDeliveryFee: fee }, type: "membership" } },
    { text: `${eta[0]} min`, accessibilityText: `Delivered in ${eta[0]} to ${eta[1]} min`, badgeType: "ETD" },
  ],
  rating: { text: rating, accessibilityText: `${rating} out of 5 stars`, badgeType: "RATINGS" },
  actionUrl: `/store/${name.toLowerCase().replace(/[^a-z]+/g, "-")}-main-st/${b64(uuid)}`,
  favorite: false,
  signposts: null,
  meta2: null,
});

export const FEED_HOME = {
  feedItems: [
    { uuid: "c1", type: "REGULAR_CAROUSEL", carousel: { stores: [storeCard(STORE, "Thai Sample", "4.8", [27, 45], "$0.49"), storeCard(OTHER_STORE, "Burger Sample", "4.6", [12, 24], "$5.49")], header: { title: { text: "Featured on Uber Eats" } } } },
    { uuid: "DIVIDER", type: "DIVIDER", dividerPayload: { height: 1 } },
  ],
  storesMap: {},
  currencyCode: "USD",
};
export const FEED_SEARCH = { feedItems: [{ uuid: "s1", type: "REGULAR_STORE", store: storeCard(STORE, "Thai Sample", "4.8", [27, 45], "$0.49") }], storesMap: {}, currencyCode: "USD" };

const catalogItem = (uuid: string, title: string, price: number, custom: boolean, sub: string) => ({
  uuid,
  title,
  itemDescription: `${title} description`,
  price,
  priceTagline: custom ? { text: "Priced by add-ons", accessibilityText: "Priced by add-ons" } : { text: `$${(price / 100).toFixed(2)}` },
  isSoldOut: false,
  hasCustomizations: custom,
  isAvailable: true,
  subsectionUuid: sub,
  sectionUuid: SECTION,
});

export const STORE_DATA = {
  title: "Thai Sample",
  uuid: STORE,
  slug: "thai-sample-main-st",
  location: { address: "123 Main St, Springfield, CA 90000", streetAddress: "123 Main St", city: "Springfield", latitude: 33.6618, longitude: -117.9988 },
  currencyCode: "USD",
  isOrderable: true,
  etaRange: { text: "27–45 Min", accessibilityText: "Delivered in 27 to 45 min" },
  rating: { ratingValue: 4.8 },
  storeInfoMetadata: { rawRatingStats: { storeRatingScore: 4.76, ratingCount: "2,000+" } },
  cuisineList: ["Thai", "Asian Fusion"],
  phoneNumber: "+15555550100",
  supportedDiningModes: [{ mode: "DELIVERY", title: "Delivery", isAvailable: true, isSelected: true }],
  parentChain: null,
  catalogSectionsMap: {
    [SECTION]: [
      { type: "HORIZONTAL_GRID", catalogSectionUUID: "sub-featured", payload: { standardItemsPayload: { title: { text: "Featured items" }, catalogItems: [catalogItem(CURRY, "Panang Curry", 100, true, "sub-curry")] }, type: "standardItemsPayload" } },
      { type: "VERTICAL_GRID", catalogSectionUUID: "sub-curry", payload: { standardItemsPayload: { title: { text: "Curries" }, catalogItems: [catalogItem(CURRY, "Panang Curry", 100, true, "sub-curry")] }, type: "standardItemsPayload" } },
      { type: "VERTICAL_GRID", catalogSectionUUID: "sub-drinks", payload: { standardItemsPayload: { title: { text: "Drinks" }, catalogItems: [catalogItem(COFFEE, "Thai Ice Coffee", 475, false, "sub-drinks")] }, type: "standardItemsPayload" } },
    ],
    "48a165fe-0000-4000-8000-17ca007b1055": [],
  },
};

const option = (uuid: string, title: string, price: number) => ({ defaultQuantity: 0, minPermitted: 0, maxPermitted: 0, price, title, uuid, isSoldOut: false, childCustomizationList: [] });
export const ITEMS: Record<string, any> = {
  [CURRY]: {
    itemDescription: "Coconut curry with jasmine rice",
    price: 100,
    sectionUuid: SECTION,
    subsectionUuid: "sub-curry",
    title: "Panang Curry",
    uuid: CURRY,
    isSoldOut: false,
    hasCustomizations: true,
    customizationsList: [
      { maxPermitted: 1, minPermitted: 1, title: "Curry Protein Choice", uuid: G_PROTEIN, groupId: 0, options: [option(O.none, "(No Meat)", 1495), option(O.tofu, "Tofu", 1595), option(O.chicken, "Chicken", 1595)] },
      { maxPermitted: 1, minPermitted: 0, title: "Spice Level", uuid: G_SPICE, groupId: 1, options: [option(O.mild, "(Mild)", 0), option(O.spicy, "(Spicy)", 0)] },
    ],
  },
  [COFFEE]: { itemDescription: "Iced", price: 475, sectionUuid: SECTION, subsectionUuid: "sub-drinks", title: "Thai Ice Coffee", uuid: COFFEE, isSoldOut: false, hasCustomizations: false, customizationsList: [] },
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
/** The checkout breakdown, shaped like the recorded one: fees with before/now text, and a total that includes the preselected tip. */
export function checkoutData(draftUuid: string, items: { price: number; quantity: number; customizations: Record<string, { price: number }[]> }[], opts: { wrongSum?: boolean } = {}) {
  const subtotal = items.reduce((s, i) => s + (i.price + Object.values(i.customizations).flat().reduce((a, o) => a + o.price, 0)) * i.quantity, 0);
  const other = Math.round(subtotal * 0.2);
  const otherNow = other - 25;
  const tax = Math.round(subtotal * 0.0775);
  const tip = Math.round((subtotal + 49 + other + tax) * 0.2);
  const total = subtotal + otherNow + tax + tip + (opts.wrongSum ? 111 : 0);
  const charge = (title: string, id: string, now: number, before?: number, action?: unknown) => ({
    title: { text: title },
    value: { text: money(now), accessibilityText: before !== undefined ? `before promotion: ${money(before)}, now: ${money(now)}` : money(now) },
    subCharges: null,
    fareBreakdownChargeMetadata: { fareInfoID: id },
    action,
  });
  return {
    checkoutPayloads: {
      subtotal: { subtotal: { value: { amountE5: subtotal * 1000, currencyCode: "USD" }, formattedValue: money(subtotal) } },
      total: { total: { value: { amountE5: total * 1000, currencyCode: "USD" }, formattedValue: money(total) } },
      fareBreakdown: {
        charges: [
          charge("Subtotal", "eats_fare.subtotal", subtotal),
          charge("Delivery Fee", "eats.mp.charges.bundled_delivery_fee", 0, 49, { infoBottomSheet: { paragraphs: [{ title: "Delivery", endTitle: "$0.49" }, { title: "Delivery Discount", subtitle: "Saving with Uber One", endTitle: "-$0.49" }] }, type: "infoBottomSheet" }),
          charge("Other Fees", "eats.mp.charges.other_fees", otherNow, other, { infoBottomSheet: { paragraphs: [{ title: "Service Fee" }, { title: "Service Fee Discount", subtitle: "Saving with Uber One" }] } }),
          charge("Taxes", "eats.tax.base", tax),
        ],
      },
      eta: { rangeText: "30–45 min", prefixText: "Delivery Options" },
      upfrontTipping: {
        currencyCode: "USD",
        options: [
          { amount: Math.round(tip * 0.75), displayText: "15%", isSelectedTip: false, percent: 1500 },
          { amount: tip, displayText: "20%", isSelectedTip: true, percent: 2000 },
        ],
        customTipOption: { amount: 0, isSelectedTip: false },
      },
      promotion: { promotionState: "NONE_AVAILABLE" },
      cartItems: { itemsCount: items.reduce((s, i) => s + i.quantity, 0) },
    },
    draftOrderUUID: draftUuid,
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Fake Eats</title><body><div id="app"></div><script>
const api = (name, body) => fetch("/_p/api/" + name, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "x" }, body: JSON.stringify(body || {}) }).then((r) => r.json()).then((j) => j.data);
const app = document.getElementById("app");
const el = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; };
const b64ToUuid = (s) => { const h = [...atob(s.replace(/-/g, "+").replace(/_/g, "/"))].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""); return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join("-"); };
let draft = null;
async function route() {
  const path = location.pathname, q = new URLSearchParams(location.search);
  if (path === "/feed" || path === "/search") {
    const feed = await api("getFeedV1", { userQuery: q.get("q") || "", cacheKey: "x" });
    app.innerHTML = '<input data-testid="search-input" name="searchTerm">' + JSON.stringify(feed).length;
  } else if (path.startsWith("/store/")) {
    const storeUuid = b64ToUuid(path.split("/")[3]);
    const [store, drafts] = await Promise.all([api("getStoreV1", { storeUuid, diningMode: q.get("diningMode") || "DELIVERY", time: { asap: true } }), api("getDraftOrdersByEaterUuidV1", {})]);
    const mine = drafts.draftOrders.find((d) => d.restaurantUUID === storeUuid);
    draft = mine ? mine.uuid : null;
    const items = Object.values(store.catalogSectionsMap).flat().flatMap((s) => s.payload.standardItemsPayload.catalogItems);
    app.innerHTML = '<div data-testid="store-loaded"></div>' + items.map((i) => '<a href="#" data-testid="store-item-' + i.uuid + '">' + i.title + '</a>').join("") + '<div id="cartbar"></div><div id="modal"></div>';
    if (mine && mine.shoppingCart.items.length) showCartBar();
    app.querySelectorAll('[data-testid^="store-item-"]').forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openDish(storeUuid, a.getAttribute("data-testid").slice(11)); }));
  } else if (path === "/checkout") {
    const d = await api("getCheckoutPresentationV1", { payloadTypes: ["total"], draftOrderUUID: sessionStorage.getItem("draft"), isGroupOrder: false });
    app.innerHTML = '<span data-testid="fare-breakdown-total-label">Total</span><button data-testid="place-order-btn" aria-label="Place order">Place order</button>';
    document.querySelector('[data-testid="place-order-btn"]').addEventListener("click", () => api("checkoutOrdersByDraftOrdersV1", {}));
  }
}
function showCartBar() {
  document.getElementById("cartbar").innerHTML = '<button aria-label="View cart">View cart</button><button aria-label="Go to checkout">Go to checkout</button>';
  document.querySelector('[aria-label="Go to checkout"]').addEventListener("click", () => { sessionStorage.setItem("draft", draft); history.pushState({}, "", "/checkout?mod=x"); route(); });
}
async function openDish(storeUuid, uuid) {
  const item = await api("getMenuItemV1", { itemRequestType: "ITEM", storeUuid, menuItemUuid: uuid, diningMode: "DELIVERY" });
  history.replaceState({}, "", location.pathname + "?mod=quickView");
  const modal = document.getElementById("modal");
  modal.innerHTML = '<div role="dialog">' + item.customizationsList.map((g, gi) => (item.__reverse ? [...g.options].reverse() : g.options).map((o) =>
    g.minPermitted >= 1 && g.maxPermitted === 1
      ? '<label><input type="radio" name="' + g.uuid + "+" + gi + '" data-opt="' + o.uuid + '" style="position:absolute;opacity:0;width:0;height:0">' + o.title + "</label>"
      : '<label><input type="checkbox" name="item-' + o.uuid + "-" + g.uuid + "+" + gi + '" data-opt="' + o.uuid + '" style="position:absolute;opacity:0;width:0;height:0">' + o.title + "</label>").join("")).join("") +
    '<button data-testid="add-to-cart-button" disabled>Add</button><button data-testid="baseui-modal-close" aria-label="Close">x</button></div>';
  const btn = modal.querySelector('[data-testid="add-to-cart-button"]');
  const required = item.customizationsList.filter((g) => g.minPermitted >= 1);
  const refresh = () => { btn.disabled = !required.every((g) => modal.querySelector('input[name^="' + g.uuid + '+"]:checked')); };
  modal.addEventListener("change", refresh); refresh();
  const close = () => { modal.innerHTML = ""; history.replaceState({}, "", location.pathname); };
  modal.querySelector('[data-testid="baseui-modal-close"]').addEventListener("click", close);
  btn.addEventListener("click", async () => {
    const customizations = {};
    item.customizationsList.forEach((g, gi) => {
      const picked = g.options.filter((o) => modal.querySelector('input[data-opt="' + o.uuid + '"]').checked);
      if (picked.length) customizations[g.uuid + "+" + gi] = picked.map((o) => ({ uuid: o.uuid, price: o.price, quantity: 1, title: o.title, customizationMeta: { title: g.title } }));
    });
    const line = { uuid: item.uuid, shoppingCartItemUuid: crypto.randomUUID(), storeUuid, price: item.price, title: item.title, quantity: 1, customizations };
    if (!draft) { const r = await api("createDraftOrderV2", { isMulticart: true, shoppingCartItems: [line] }); draft = r.draftOrder.uuid; }
    else await api("addItemsToDraftOrderV2", { draftOrderUUID: draft, items: [line], storeUUID: storeUuid });
    close(); showCartBar();
  });
}
route();
</script>`;

export interface FakeUberEats {
  server: Server;
  origin: string;
  state: { drafts: Map<string, { uuid: string; store: string; items: any[] }>; calls: string[]; breakRadios?: boolean; wrongSum?: boolean; emptySearch?: boolean; swapItem?: boolean };
  seedCart(items: { title: string; quantity: number }[]): void;
}

export function startFakeUberEats(): Promise<FakeUberEats> {
  const state: FakeUberEats["state"] = { drafts: new Map(), calls: [] };
  const draftFor = (store: string) => [...state.drafts.values()].find((d) => d.store === store);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (data: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "success", data }));
    if (url.pathname === "/do-login") return void res.writeHead(302, { "set-cookie": "sid=fake; Path=/", location: "/feed" }).end();
    if (url.pathname === "/login-redirect/") return void res.writeHead(200, { "content-type": "text/html" }).end('<a id="go" href="/do-login">Sign in</a>');
    if (!url.pathname.startsWith("/_p/api/")) return void res.writeHead(200, { "content-type": "text/html" }).end(PAGE);

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const name = url.pathname.slice(8);
      state.calls.push(name);
      if (name === "getFeedV1") return send(body.userQuery ? (state.emptySearch ? { feedItems: [], storesMap: {} } : FEED_SEARCH) : FEED_HOME);
      if (name === "getStoreV1" && state.swapItem) return send({ ...STORE_DATA, uuid: "00000000-0000-4000-8000-000000000000" });
      if (name === "getStoreV1") return send(body.storeUuid === STORE ? STORE_DATA : { ...STORE_DATA, uuid: body.storeUuid, title: "Burger Sample" });
      if (name === "getDraftOrdersByEaterUuidV1")
        return send({ draftOrders: [...state.drafts.values()].map((d) => ({ uuid: d.uuid, restaurantUUID: d.store, shoppingCart: { items: d.items.map((i) => ({ title: i.title, quantity: i.quantity })) } })) });
      if (name === "getMenuItemV1") return send({ ...ITEMS[body.menuItemUuid], __reverse: state.breakRadios });
      if (name === "createDraftOrderV2" || name === "addItemsToDraftOrderV2") {
        const items = body.shoppingCartItems ?? body.items;
        const store = items[0].storeUuid;
        let d = name === "createDraftOrderV2" ? undefined : state.drafts.get(body.draftOrderUUID);
        if (!d) {
          d = { uuid: `draft-${state.drafts.size + 1}`, store, items: [] };
          state.drafts.set(d.uuid, d);
        }
        d.items.push(...items);
        return send(name === "createDraftOrderV2" ? { draftOrder: { uuid: d.uuid, storeUuid: store } } : { addedItems: items, draftOrderUUID: d.uuid });
      }
      if (name === "getCheckoutPresentationV1") {
        const d = state.drafts.get(body.draftOrderUUID);
        return send(d ? checkoutData(d.uuid, d.items.map((i) => ({ price: i.price ?? 475, quantity: i.quantity, customizations: i.customizations ?? {} })), { wrongSum: state.wrongSum }) : {});
      }
      send({});
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        state,
        seedCart: (items) => void state.drafts.set("draft-old", { uuid: "draft-old", store: STORE, items: items.map((i) => ({ ...i, price: 475, customizations: {} })) }),
      }),
    ),
  );
  void draftFor;
}

export const IDS = { STORE, OTHER_STORE, CURRY, COFFEE, G_PROTEIN, G_SPICE, O };
