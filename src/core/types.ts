import { z } from "zod";

/** All money is integer cents (USD in v1). */
export const Cents = z.number().int();

export const ProviderId = z.enum(["ubereats", "doordash", "grubhub", "postmates", "mockeats", "mockdash"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const GhostKitchenFlag = z.object({
  flagged: z.boolean(),
  /** 0..1. How sure we are. */
  confidence: z.number(),
  /** Human-readable reasons. Always shown to the user when flagged. */
  reasons: z.array(z.string()),
});
export type GhostKitchenFlag = z.infer<typeof GhostKitchenFlag>;

export const Restaurant = z.object({
  /** Globally unique: "<provider>:<provider's own id>". */
  id: z.string(),
  provider: ProviderId,
  name: z.string(),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  phone: z.string().optional(),
  cuisines: z.array(z.string()).default([]),
  description: z.string().optional(),
  rating: z.number().optional(),
  rating_count: z.number().optional(),
  eta_min: z.number().optional(),
  delivery_fee_cents: Cents.optional(),
  supports_pickup: z.boolean().default(false),
  /** True when the provider itself labels the store as virtual / delivery-only. */
  provider_says_virtual: z.boolean().optional(),
  /** Filled in by core, not by adapters. */
  ghost_kitchen: GhostKitchenFlag.optional(),
  /** Same value on every app's listing of the same physical restaurant. Filled in by core. */
  match_group: z.string().optional(),
  match_confidence: z.number().optional(),
});
export type Restaurant = z.infer<typeof Restaurant>;

export const ModifierOption = z.object({
  id: z.string(),
  name: z.string(),
  price_delta_cents: Cents.default(0),
  is_default: z.boolean().optional(),
});
export type ModifierOption = z.infer<typeof ModifierOption>;

export const Modifier = z.object({
  id: z.string(),
  name: z.string(),
  required: z.boolean().default(false),
  min_select: z.number().int().default(0),
  max_select: z.number().int().default(1),
  options: z.array(ModifierOption),
});
export type Modifier = z.infer<typeof Modifier>;

export const MenuItem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  price_cents: Cents,
  dietary_tags: z.array(z.string()).default([]),
  modifiers: z.array(Modifier).default([]),
  available: z.boolean().default(true),
});
export type MenuItem = z.infer<typeof MenuItem>;

/** What the user wants, before it is mapped onto one app's menu. */
export const DesiredItem = z.object({
  name: z.string().describe("Dish name as the user said it, e.g. 'pad thai'"),
  quantity: z.number().int().min(1).default(1),
  modifiers: z.array(z.string()).optional().describe("Options in plain words, e.g. ['shrimp', 'medium spice']"),
  item_id: z.string().optional().describe("Exact menu item id from get_menu, if known. Skips fuzzy matching."),
});
export type DesiredItem = z.infer<typeof DesiredItem>;

export const CartLine = z.object({
  item_id: z.string(),
  name: z.string(),
  quantity: z.number().int(),
  unit_price_cents: Cents,
  selected_options: z.array(z.object({ modifier: z.string(), option: z.string(), price_delta_cents: Cents })),
  line_total_cents: Cents,
  /** What the user asked for, and how well this line matches it (0..1). */
  requested_as: z.string(),
  match_score: z.number(),
});
export type CartLine = z.infer<typeof CartLine>;

export const Cart = z.object({
  id: z.string(),
  provider: ProviderId,
  restaurant_id: z.string(),
  restaurant_name: z.string(),
  mode: z.enum(["delivery", "pickup"]),
  lines: z.array(CartLine),
  /** Requested items we could not find on this app's menu. */
  unmapped: z.array(z.string()),
  warnings: z.array(z.string()),
  subtotal_cents: Cents,
  created_at: z.string(),
});
export type Cart = z.infer<typeof Cart>;

export const TipInput = z.union([
  z.object({ type: z.literal("percent"), value: z.number().min(0).max(100) }),
  z.object({ type: z.literal("flat"), cents: Cents.min(0) }),
]);
export type TipInput = z.infer<typeof TipInput>;

export const Discount = z.object({
  label: z.string(),
  amount_cents: Cents,
  kind: z.enum(["promo", "membership"]),
});

export const Quote = z.object({
  id: z.string(),
  cart_id: z.string(),
  provider: ProviderId,
  restaurant_id: z.string(),
  restaurant_name: z.string(),
  currency: z.literal("USD"),
  subtotal_cents: Cents,
  delivery_fee_cents: Cents,
  service_fee_cents: Cents,
  small_order_fee_cents: Cents,
  other_fees: z.array(z.object({ label: z.string(), amount_cents: Cents })),
  tax_cents: Cents,
  discounts: z.array(Discount),
  tip_cents: Cents,
  /** "set": the user chose the tip. "needs_user_input": tip is 0 until the user is asked. */
  tip_status: z.enum(["set", "needs_user_input"]),
  /** What the provider itself suggests, shown for reference only. */
  provider_suggested_tip_cents: Cents.optional(),
  total_cents: Cents,
  eta_min: z.number().optional(),
  /** False when any line of the total could not be read from the provider's checkout. */
  verified: z.boolean(),
  /** Which fields are estimates, and why. Empty when verified. */
  estimate_notes: z.array(z.string()),
  /** Share of requested items found on this app (0..1). */
  fit: z.number(),
  rating: z.number().optional(),
  ghost_kitchen: GhostKitchenFlag.optional(),
  match_group: z.string().optional(),
  /** Hash of everything the user is agreeing to. Confirmation tokens are bound to it. */
  quote_hash: z.string(),
  quoted_at: z.string(),
});
export type Quote = z.infer<typeof Quote>;

export const ProviderSession = z.object({
  provider: ProviderId,
  status: z.enum(["connected", "pending", "expired", "disconnected"]),
  connected_at: z.string().optional(),
  last_checked_at: z.string().optional(),
  note: z.string().optional(),
});
export type ProviderSession = z.infer<typeof ProviderSession>;

export const RankWeights = z.object({
  total: z.number().min(0),
  eta: z.number().min(0),
  rating: z.number().min(0),
  fit: z.number().min(0),
});
export type RankWeights = z.infer<typeof RankWeights>;
export const DEFAULT_WEIGHTS: RankWeights = { total: 0.6, eta: 0.2, rating: 0.15, fit: 0.05 };

export const UserPreferences = z.object({
  /** undefined = never asked. The intake asks once, then this is the saved default. */
  exclude_ghost_kitchens: z.boolean().optional(),
  default_address: z.string().optional(),
  default_mode: z.enum(["delivery", "pickup"]).optional(),
  dietary: z.array(z.string()).optional(),
  min_rating: z.number().optional(),
  max_eta_min: z.number().optional(),
  budget_cents: Cents.optional(),
  tip: TipInput.optional(),
  memberships: z.record(z.string(), z.boolean()).optional(),
  preferred_providers: z.array(ProviderId).optional(),
  weights: RankWeights.optional(),
});
export type UserPreferences = z.infer<typeof UserPreferences>;

export const SearchCriteria = z.object({
  query: z.string().optional().describe("Cuisine or dish, e.g. 'thai' or 'margherita pizza'. Omit for 'surprise me'."),
  address: z.string().optional().describe("Delivery address or area. Falls back to the saved default address."),
  mode: z.enum(["delivery", "pickup"]).optional(),
  min_rating: z.number().optional(),
  max_eta_min: z.number().optional(),
  dietary: z.array(z.string()).optional(),
  exclude_ghost_kitchens: z.boolean().optional().describe("Real restaurants only. Falls back to the saved preference."),
  providers: z.array(ProviderId).optional().describe("Limit to these apps. Default: every connected app."),
});
export type SearchCriteria = z.infer<typeof SearchCriteria>;
