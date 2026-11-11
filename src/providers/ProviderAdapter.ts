import type { Cart, DesiredItem, MenuItem, ProviderId, ProviderSession, Restaurant, SearchCriteria } from "../core/types.js";

/** Fees exactly as the provider shows them at checkout, before the user's tip. */
export interface ProviderQuote {
  subtotal_cents: number;
  delivery_fee_cents: number;
  service_fee_cents: number;
  small_order_fee_cents: number;
  other_fees: { label: string; amount_cents: number }[];
  tax_cents: number;
  discounts: { label: string; amount_cents: number; kind: "promo" | "membership" }[];
  /** The provider's own "total before tip", if it could be read. Core cross-checks the sum against it. */
  total_before_tip_cents?: number;
  provider_suggested_tip_cents?: number;
  eta_min?: number;
  /** False if any number above was inferred instead of read from checkout. */
  verified: boolean;
  estimate_notes: string[];
}

export interface QuoteContext {
  address?: string;
  /** User says they have this provider's membership (DashPass, Uber One, Grubhub+). */
  has_membership: boolean;
}

export interface OrderReceipt {
  order_id: string;
  placed_at: string;
  total_cents: number;
}

/**
 * One delivery app. To add an app: implement this interface in
 * src/providers/<name>/ and register it in registry.ts. Core logic
 * (matching, ranking, confirmation) never needs to change.
 *
 * Rules every adapter must follow:
 *  - Never see, ask for, or store a password. connect() opens the provider's
 *    real login page and the user signs in themselves.
 *  - Never submit an order outside placeOrder(), and never change payment
 *    methods, addresses, or account settings.
 *  - Go through the shared throttle. No parallel requests to one provider.
 *  - If a number can't be read from the provider, set verified=false and say which.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly membershipName?: string;
  /** Other providers that share this one's inventory (Postmates → Uber Eats). */
  readonly overlapsWith?: ProviderId[];
  /** Shown to the user before they connect. Terms-of-service and account-risk notes. */
  readonly connectNotice?: string;

  sessionStatus(): Promise<ProviderSession>;
  /** May return status "pending" while the user is still signing in. */
  connect(): Promise<ProviderSession>;
  disconnect(): Promise<void>;

  search(criteria: SearchCriteria): Promise<Restaurant[]>;
  getRestaurant(restaurantId: string): Promise<Restaurant | undefined>;
  getMenu(restaurantId: string): Promise<MenuItem[]>;
  /** Puts the mapped cart into the user's real cart on the provider. */
  syncCart(cart: Cart): Promise<void>;
  /** Reads the checkout page. Must never submit. */
  quote(cart: Cart, ctx: QuoteContext): Promise<ProviderQuote>;
  /** Opens (or returns the URL of) the provider's own checkout page with the cart filled in. */
  openCheckout(cart: Cart): Promise<{ url: string; opened: boolean }>;
  /** Optional. Only called behind the feature flag with a verified one-time token. */
  placeOrder?(cart: Cart): Promise<OrderReceipt>;
}

export type { DesiredItem };
