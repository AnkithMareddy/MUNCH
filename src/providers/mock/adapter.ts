import { pct } from "../../core/money.js";
import { normalize } from "../../core/text.js";
import type { Cart, MenuItem, ProviderSession, Restaurant, SearchCriteria } from "../../core/types.js";
import type { SessionStore } from "../../storage/sessions.js";
import type { OrderReceipt, ProviderAdapter, ProviderQuote, QuoteContext } from "../ProviderAdapter.js";
import { APPS, RESTAURANTS, TAX_RATE_PCT, type MockAppConfig, type MockRestaurant } from "./data.js";

const round5 = (cents: number) => Math.round(cents / 5) * 5;

/**
 * A fake delivery app backed by static data. Two instances with different fee
 * rules stand in for two real apps, so the whole flow can be exercised without
 * touching any real site or account.
 */
export class MockAdapter implements ProviderAdapter {
  readonly id: "mockeats" | "mockdash";
  readonly displayName: string;
  readonly membershipName: string;
  readonly connectNotice = "Demo provider with fake data. No real account, no real orders.";
  private cfg: MockAppConfig;
  private syncedCarts = new Set<string>();

  constructor(id: "mockeats" | "mockdash", private sessions: SessionStore) {
    this.cfg = APPS[id];
    this.id = id;
    this.displayName = this.cfg.displayName;
    this.membershipName = this.cfg.membershipName;
  }

  async sessionStatus(): Promise<ProviderSession> {
    return (await this.sessions.get(this.id)) ?? { provider: this.id, status: "disconnected" };
  }

  async connect(): Promise<ProviderSession> {
    // A real adapter opens the provider's login page here and waits for the user.
    const s: ProviderSession = { provider: this.id, status: "connected", connected_at: new Date().toISOString(), note: "Demo session. No login needed." };
    await this.sessions.set(s);
    return s;
  }

  async disconnect(): Promise<void> {
    await this.sessions.delete(this.id);
  }

  private mine(): MockRestaurant[] {
    return RESTAURANTS.filter((r) => r.on.includes(this.id));
  }

  private alt(): boolean {
    return this.id === "mockdash";
  }

  private toRestaurant(r: MockRestaurant): Restaurant {
    return {
      id: `${this.id}:${r.slug}`,
      provider: this.id,
      name: this.alt() ? r.altName ?? r.name : r.name,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      phone: r.phone,
      cuisines: r.cuisines,
      description: r.description,
      rating: this.alt() ? Math.round((r.rating - 0.1) * 10) / 10 : r.rating,
      rating_count: r.ratingCount,
      eta_min: r.eta + this.cfg.etaOffset,
      delivery_fee_cents: this.cfg.deliveryFee,
      supports_pickup: r.pickup,
    };
  }

  private find(restaurantId: string): MockRestaurant {
    const r = this.mine().find((x) => `${this.id}:${x.slug}` === restaurantId);
    if (!r) throw new Error(`Unknown restaurant "${restaurantId}" on ${this.displayName}`);
    return r;
  }

  async search(c: SearchCriteria): Promise<Restaurant[]> {
    const q = normalize(c.query ?? "");
    const terms = q.split(" ").filter(Boolean);
    return this.mine()
      .filter((r) => {
        if (c.mode === "pickup" && !r.pickup) return false;
        if (terms.length === 0) return true;
        const hay = normalize([r.name, r.altName ?? "", ...r.cuisines, ...r.items.flatMap((i) => [i.name, i.altName ?? ""])].join(" "));
        return terms.every((t) => hay.includes(t)) || terms.some((t) => r.cuisines.includes(t));
      })
      .map((r) => this.toRestaurant(r));
  }

  async getRestaurant(restaurantId: string): Promise<Restaurant | undefined> {
    const r = this.mine().find((x) => `${this.id}:${x.slug}` === restaurantId);
    return r && this.toRestaurant(r);
  }

  async getMenu(restaurantId: string): Promise<MenuItem[]> {
    const r = this.find(restaurantId);
    return r.items.map((i) => ({
      id: `${restaurantId}:${i.slug}`,
      name: this.alt() ? i.altName ?? i.name : i.name,
      category: i.category,
      price_cents: round5(i.price * this.cfg.markup),
      dietary_tags: i.tags ?? [],
      available: true,
      modifiers: (i.modifiers ?? []).map((m, mi) => ({
        id: `${i.slug}:m${mi}`,
        name: m.name,
        required: m.required ?? false,
        min_select: m.required ? 1 : 0,
        max_select: 1,
        options: m.options.map(([name, delta], oi) => ({ id: `${i.slug}:m${mi}:o${oi}`, name, price_delta_cents: round5(delta * this.cfg.markup), is_default: oi === 0 })),
      })),
    }));
  }

  async syncCart(cart: Cart): Promise<void> {
    // A real adapter checks for an existing cart here.
    this.syncedCarts.add(cart.id);
  }

  async quote(cart: Cart, ctx: QuoteContext): Promise<ProviderQuote> {
    const r = this.find(cart.restaurant_id);
    const sub = cart.subtotal_cents;
    const delivery = cart.mode === "delivery";
    const member = ctx.has_membership;
    const discounts: ProviderQuote["discounts"] = [];

    let deliveryFee = delivery ? this.cfg.deliveryFee : 0;
    if (member && delivery && sub >= this.cfg.membership.freeDeliveryOver && deliveryFee > 0) {
      discounts.push({ label: `${this.cfg.membershipName}: $0 delivery fee`, amount_cents: deliveryFee, kind: "membership" });
    }
    const fullService = delivery ? Math.max(this.cfg.serviceMin, pct(sub, this.cfg.servicePct)) : 0;
    if (member && delivery) {
      const reduced = pct(sub, this.cfg.membership.servicePct);
      if (reduced < fullService) discounts.push({ label: `${this.cfg.membershipName}: reduced service fee`, amount_cents: fullService - reduced, kind: "membership" });
    }
    const smallOrder = delivery && sub < this.cfg.smallOrderUnder ? this.cfg.smallOrderFee : 0;
    if (this.cfg.promo && sub >= this.cfg.promo.minSubtotal) discounts.push({ label: this.cfg.promo.label, amount_cents: this.cfg.promo.amount, kind: "promo" });

    const tax = pct(sub, TAX_RATE_PCT);
    const taxHidden = r.taxHiddenOn === this.id;
    const totalDiscount = discounts.reduce((s, d) => s + d.amount_cents, 0);

    return {
      subtotal_cents: sub,
      delivery_fee_cents: deliveryFee,
      service_fee_cents: fullService,
      small_order_fee_cents: smallOrder,
      other_fees: [],
      tax_cents: tax,
      discounts,
      total_before_tip_cents: taxHidden ? undefined : sub + deliveryFee + fullService + smallOrder + tax - totalDiscount,
      provider_suggested_tip_cents: delivery ? Math.max(300, pct(sub, 18)) : 0,
      eta_min: (cart.mode === "pickup" ? Math.max(10, r.eta - 15) : r.eta) + this.cfg.etaOffset,
      verified: !taxHidden,
      estimate_notes: taxHidden ? [`Tax is not shown by ${this.displayName} until the final step for this store. Estimated at ${TAX_RATE_PCT}% of the subtotal.`] : [],
    };
  }

  async openCheckout(cart: Cart): Promise<{ url: string; opened: boolean }> {
    return { url: `https://${this.id}.example/checkout?cart=${cart.id}`, opened: false };
  }

  async placeOrder(cart: Cart): Promise<OrderReceipt> {
    return { order_id: `demo_${cart.id}`, placed_at: new Date().toISOString(), total_cents: 0 };
  }
}
