import type { Page } from "playwright";
import { ApiTap, siteChanged, type ApiHit } from "../../browser/apiTap.js";
import { LoginFlow } from "../../browser/login.js";
import type { BrowserSessions } from "../../browser/sessions.js";
import { ToolError } from "../../core/errors.js";
import type { Cart, CartLine, MenuItem, ProviderSession, Restaurant, SearchCriteria } from "../../core/types.js";
import type { SessionStore } from "../../storage/sessions.js";
import type { ProviderAdapter, ProviderQuote } from "../ProviderAdapter.js";
import { addedOptionIds, parseCheckout, parseFeed, parseMenuItem, ParseError, parseStore, storeUrlId, type ParsedStore } from "./parse.js";
import { UBEREATS, ubereatsLogin } from "./site.js";

const SITE = "Uber Eats";
const pause = (min: number, max = min * 1.8) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const uuidOf = (id: string) => id.split(":").at(-1)!;

interface OpenStore {
  restaurantId: string;
  mode: "delivery" | "pickup";
  parsed: ParsedStore;
  /** Items already in the user's cart at this store when the page loaded. */
  existingItems: string[];
}

/**
 * Uber Eats, through the user's own signed-in browser.
 *
 * How it reads: it moves the real page (opens the search page, a store, a dish)
 * and listens to the data the page itself loads. It sends no requests of its own.
 * How it writes: it clicks the site's own buttons to add dishes, then checks the
 * request the site sent against what it meant to add.
 * What it never does: click "Place order", or touch address, payment or tip.
 */
export class UberEatsAdapter implements ProviderAdapter {
  readonly id = "ubereats" as const;
  readonly displayName = SITE;
  readonly membershipName = "Uber One";
  readonly connectNotice =
    "This controls your own signed-in Uber Eats session in a browser window on your computer. Uber's terms generally prohibit automated access, so your account could be flagged or suspended. You sign in yourself; your password is never seen or stored.";
  readonly searchNote = "Results and prices are for the delivery address currently selected in the user's Uber Eats account. To change it, the user edits it in the Uber Eats window themselves.";

  private login: LoginFlow;
  private tap?: ApiTap;
  private tapPage?: Page;
  private actionUrls = new Map<string, string>();
  private stores = new Map<string, ParsedStore>();
  private items = new Map<string, MenuItem>();
  private open?: OpenStore;
  /** Our cart id → the draft order the site created for it. */
  private drafts = new Map<string, { draftUuid: string; restaurantId: string }>();

  constructor(private browsers: BrowserSessions, sessions: SessionStore, private site = UBEREATS) {
    this.login = new LoginFlow(ubereatsLogin(site), browsers, sessions);
  }

  sessionStatus(): Promise<ProviderSession> {
    return this.login.status();
  }
  connect(): Promise<ProviderSession> {
    return this.login.start();
  }
  async disconnect(): Promise<void> {
    this.tap = this.tapPage = this.open = undefined;
    await this.login.signOut();
  }

  /** The working tab, signed in, with the data tap attached. */
  private async ready(): Promise<{ page: Page; tap: ApiTap }> {
    const session = await this.login.verify();
    if (session.status !== "connected") throw new ToolError("session_expired", "Uber Eats has signed you out.", 'Ask the user, then call connect_provider("ubereats") so they can sign in again.');
    const page = await this.browsers.page(this.id);
    if (!this.tap || this.tapPage !== page) {
      this.tap = new ApiTap(page, SITE, this.site.apiPrefix);
      this.tapPage = page;
      this.open = undefined;
    }
    return { page, tap: this.tap };
  }

  private async go(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {
      throw siteChanged(SITE, "a page failed to open");
    });
    if (new URL(page.url()).hostname.includes("auth.uber.com")) throw new ToolError("session_expired", "Uber Eats asked for a sign-in.", 'Call connect_provider("ubereats") so the user can sign in again.');
  }

  private parse<T>(what: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ParseError) throw siteChanged(SITE, `${what} came back in an unexpected format (${e.message})`);
      throw e;
    }
  }

  async search(c: SearchCriteria): Promise<Restaurant[]> {
    const { page, tap } = await this.ready();
    const pickup = c.mode === "pickup";
    const query = (c.query ?? "").trim();
    const since = tap.mark();
    this.open = undefined;
    await this.go(page, query ? this.site.searchUrl(query, pickup) : this.site.feedUrl(pickup));
    // With a query, only accept the feed the page loaded for that query, not the home feed.
    const hit = await tap.wait(/^(getFeedV1|getSearchFeedV1)$/, {
      since,
      what: query ? `search results for "${query}"` : "the restaurant list",
      where: (h) => !query || String(h.request?.userQuery ?? "").toLowerCase() === query.toLowerCase(),
    });
    const stores = this.parse("the restaurant list", () => parseFeed(hit.data));
    for (const s of stores) if (s.actionUrl) this.actionUrls.set(s.restaurant.id, s.actionUrl);
    return stores.map((s) => ({ ...s.restaurant, supports_pickup: pickup || s.restaurant.supports_pickup }));
  }

  private storeUrl(restaurantId: string, mode: "delivery" | "pickup"): string {
    const path = this.actionUrls.get(restaurantId) ?? `/store/restaurant/${storeUrlId(uuidOf(restaurantId))}`;
    const url = new URL(path, this.site.homeUrl);
    if (mode === "pickup") url.searchParams.set("diningMode", "PICKUP");
    return url.toString();
  }

  /** Opens a restaurant's page (or reuses it if already there) and reads its data. */
  private async openStore(restaurantId: string, mode: "delivery" | "pickup" = "delivery", fresh = false): Promise<OpenStore & { page: Page; tap: ApiTap }> {
    const { page, tap } = await this.ready();
    const onStore = /\/store\//.test(page.url()) && !/[?&]mod=/.test(page.url());
    if (!fresh && this.open?.restaurantId === restaurantId && this.open.mode === mode && onStore) return { ...this.open, page, tap };

    const since = tap.mark();
    await this.go(page, this.storeUrl(restaurantId, mode));
    const hit = await tap.wait(/^getStoreV1$/, { since, what: "the restaurant page" });
    const parsed = this.parse("the restaurant page", () => parseStore(hit.data));
    if (parsed.restaurant.id !== restaurantId) throw siteChanged(SITE, "a different restaurant opened than the one asked for");
    this.stores.set(restaurantId, parsed);

    // The page also loads the user's saved carts. We only look at the one for this restaurant.
    const drafts = await tap.wait(/^getDraftOrdersByEaterUuidV1$/, { since, what: "saved carts", timeoutMs: 6000 }).catch(() => undefined);
    const mine = (drafts?.data?.draftOrders ?? []).find((d: any) => d.restaurantUUID === uuidOf(restaurantId));
    const existingItems: string[] = (mine?.shoppingCart?.items ?? []).map((i: any) => `${i.quantity ?? 1} × ${i.title ?? "item"}`);

    this.open = { restaurantId, mode, parsed, existingItems };
    await page.waitForSelector(this.site.sel.storeLoaded, { timeout: 15000 }).catch(() => undefined);
    return { ...this.open, page, tap };
  }

  async getRestaurant(restaurantId: string): Promise<Restaurant | undefined> {
    return (this.stores.get(restaurantId) ?? (await this.openStore(restaurantId)).parsed).restaurant;
  }

  async getMenu(restaurantId: string): Promise<MenuItem[]> {
    return (await this.openStore(restaurantId)).parsed.items;
  }

  /** Clicks a dish so the site opens its dialog and loads its options. Leaves the dialog open. */
  private async openDish(page: Page, tap: ApiTap, restaurantId: string, itemId: string): Promise<MenuItem> {
    const uuid = uuidOf(itemId);
    const card = page.locator(this.site.sel.storeItem(uuid)).first();
    if ((await card.count()) === 0) throw siteChanged(SITE, "a dish from the menu could not be found on the page");
    const since = tap.mark();
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    await pause(300);
    await card.click();
    const hit = await tap.wait(/^getMenuItemV1$/, { since, what: "the dish's options", where: (h) => h.request?.menuItemUuid === uuid });
    await page.waitForSelector(this.site.sel.addToCart, { timeout: 15000 }).catch(() => {
      throw siteChanged(SITE, "the dish dialog did not open");
    });
    const item = this.parse("the dish's options", () => parseMenuItem(hit.data, restaurantId));
    this.items.set(itemId, item);
    return item;
  }

  private async closeDish(page: Page): Promise<void> {
    await page.locator(this.site.sel.dialogClose).first().click({ timeout: 3000 }).catch(() => page.keyboard.press("Escape"));
    await page.waitForSelector(this.site.sel.addToCart, { state: "detached", timeout: 5000 }).catch(() => undefined);
  }

  async getMenuItem(restaurantId: string, itemId: string): Promise<MenuItem> {
    const cached = this.items.get(itemId);
    if (cached) return cached;
    const { page, tap } = await this.openStore(restaurantId);
    const item = await this.openDish(page, tap, restaurantId, itemId);
    await this.closeDish(page);
    return item;
  }

  /** Ticks one option in the open dish dialog. */
  private async chooseOption(page: Page, item: MenuItem, choice: CartLine["selected_options"][number]): Promise<string> {
    const group = item.modifiers.find((m) => m.name === choice.modifier);
    const option = group?.options.find((o) => o.name === choice.option);
    if (!group || !option) throw siteChanged(SITE, `the option "${choice.option}" is no longer offered for ${item.name}`);

    const box = page.locator(this.site.sel.optionCheckbox(option.id)).first();
    if ((await box.count()) > 0) {
      if (!(await box.isChecked())) await box.evaluate((el) => (el as HTMLElement).click());
      return option.id;
    }
    const radios = page.locator(this.site.sel.groupRadios(group.id));
    const n = await radios.count();
    if (n === 0) throw siteChanged(SITE, `the choices for "${group.name}" could not be found in the dish dialog`);
    // Prefer a radio that names the option; otherwise rely on the site listing them in menu order.
    let target = radios.locator(`xpath=self::*[@value="${option.id}" or contains(@id, "${option.id}")]`).first();
    if ((await target.count()) === 0) {
      if (n !== group.options.length) throw siteChanged(SITE, `the choices for "${group.name}" don't line up with the menu`);
      target = radios.nth(group.options.indexOf(option));
    }
    await target.evaluate((el) => (el as HTMLElement).click());
    return option.id;
  }

  /** Adds one unit of one cart line using the site's own dialog, then checks what the site actually added. */
  private async addOne(page: Page, tap: ApiTap, cart: Cart, line: CartLine): Promise<string> {
    const item = await this.openDish(page, tap, cart.restaurant_id, line.item_id);
    const wanted: string[] = [];
    for (const choice of line.selected_options) {
      wanted.push(await this.chooseOption(page, item, choice));
      await pause(250);
    }
    const button = page.locator(this.site.sel.addToCart).first();
    await pause(400);
    if (!(await button.isEnabled())) {
      await this.closeDish(page);
      throw new ToolError("options_incomplete", `Uber Eats won't add "${item.name}" yet: a required choice is still missing.`, "Call get_menu / build_cart again with a choice for every required option group.");
    }
    const since = tap.mark();
    await button.click();
    const hit: ApiHit = await tap.wait(/^(createDraftOrderV2|addItemsToDraftOrderV2)$/, { since, what: "the cart update" });
    const sent = (hit.request?.shoppingCartItems ?? hit.request?.items ?? [])[0];
    const got = addedOptionIds(sent);
    if (sent?.uuid !== uuidOf(line.item_id) || got.join() !== [...wanted].sort().join()) {
      throw new ToolError(
        "cart_mismatch",
        `Uber Eats added "${sent?.title ?? "an item"}" with different choices than requested for "${line.name}". The cart on Uber Eats is not what was asked for.`,
        "Tell the user. They should fix or empty that cart in the Uber Eats window before continuing. Do not quote or check out this cart.",
      );
    }
    const draftUuid = hit.data?.draftOrder?.uuid ?? hit.data?.draftOrderUUID ?? hit.request?.draftOrderUUID;
    if (typeof draftUuid !== "string") throw siteChanged(SITE, "the cart update did not say which cart it changed");
    await page.waitForSelector(this.site.sel.addToCart, { state: "detached", timeout: 8000 }).catch(() => this.closeDish(page));
    return draftUuid;
  }

  async syncCart(cart: Cart, opts: { existingCart: "ask" | "keep" }): Promise<string[]> {
    // Always reload: the saved-cart check must reflect right now.
    const { page, tap, existingItems } = await this.openStore(cart.restaurant_id, cart.mode, true);
    if (existingItems.length > 0 && opts.existingCart !== "keep") {
      throw new ToolError(
        "existing_cart",
        `The user already has a cart at ${cart.restaurant_name} on Uber Eats with: ${existingItems.join(", ")}.`,
        "Ask the user: add this order on top of those items (call build_cart again with existing_cart: 'keep'), or empty that cart themselves in the Uber Eats window first and then retry.",
      );
    }
    let draftUuid: string | undefined;
    for (const line of cart.lines) {
      for (let i = 0; i < line.quantity; i++) {
        draftUuid = await this.addOne(page, tap, cart, line);
        await pause(700);
      }
    }
    if (!draftUuid) throw new ToolError("empty_cart", "There was nothing to add.", "Build the cart with at least one item.");
    this.drafts.set(cart.id, { draftUuid, restaurantId: cart.restaurant_id });
    return existingItems.length ? [`This cart also contains what was already in the user's Uber Eats cart at this restaurant: ${existingItems.join(", ")}. The quote will include those.`] : [];
  }

  /** Brings the page to this cart's checkout and returns the breakdown the page loaded. */
  private async openCheckoutPage(cart: Cart): Promise<{ page: Page; hit: ApiHit }> {
    const draft = this.drafts.get(cart.id);
    if (!draft) throw new ToolError("cart_not_synced", "This cart is not in the user's Uber Eats account (the server may have restarted).", "Call build_cart again.");
    const isMine = (h: ApiHit) => h.request?.draftOrderUUID === draft.draftUuid && !!h.data?.checkoutPayloads?.fareBreakdown?.charges && !!h.data.checkoutPayloads.total;
    const { page, tap } = await this.ready();
    const since = tap.mark();
    if (/\/checkout/.test(page.url())) {
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      const s = await this.openStore(cart.restaurant_id, cart.mode);
      const button = s.page.locator(this.site.sel.goToCheckout).first();
      await button.waitFor({ state: "visible", timeout: 10000 }).catch(() => {
        throw siteChanged(SITE, 'the "Go to checkout" button did not appear');
      });
      await button.click();
    }
    this.open = undefined;
    await page.waitForURL(/\/checkout/, { timeout: 20000 }).catch(() => {
      throw siteChanged(SITE, "the checkout page did not open");
    });
    await tap.wait(/^getCheckoutPresentationV1$/, { since, what: "the checkout breakdown", where: isMine });
    // The page refreshes the breakdown more than once while it settles. Use the last one.
    await page.waitForSelector(this.site.sel.checkoutTotal, { timeout: 15000 }).catch(() => undefined);
    await pause(1200);
    return { page, hit: tap.last(/^getCheckoutPresentationV1$/, since, isMine)! };
  }

  async quote(cart: Cart): Promise<ProviderQuote> {
    const { hit } = await this.openCheckoutPage(cart);
    const q = this.parse("the checkout breakdown", () => parseCheckout(hit.data));
    const expected = cart.lines.reduce((s, l) => s + l.quantity, 0);
    const { item_count, selected_tip_cents, ...quote } = q;
    if (item_count !== undefined && item_count !== expected) quote.estimate_notes.push(`The Uber Eats cart holds ${item_count} items, not the ${expected} in this order. The total covers everything in the cart.`);
    if (quote.subtotal_cents !== cart.subtotal_cents) quote.estimate_notes.push("Uber Eats' subtotal differs from the menu prices added up. Uber Eats' figure is used.");
    void selected_tip_cents;
    return quote;
  }

  async openCheckout(cart: Cart): Promise<{ url: string; opened: boolean; note?: string }> {
    const { page, hit } = await this.openCheckoutPage(cart);
    await page.bringToFront().catch(() => undefined);
    const tip = this.parse("the checkout breakdown", () => parseCheckout(hit.data)).selected_tip_cents;
    return {
      url: "https://www.ubereats.com/checkout",
      opened: true,
      note: `Uber Eats has its own tip preselected ($${(tip / 100).toFixed(2)}), which may differ from the tip used in the quote. Set the tip you want on that page. The delivery address and payment method shown there are the ones saved in your account; check them before placing the order.`,
    };
  }
}
