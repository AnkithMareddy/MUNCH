import { createHash, randomUUID } from "node:crypto";
import type { ProviderQuote } from "../providers/ProviderAdapter.js";
import { cartFit } from "./cartMapper.js";
import { describeTip, fmt, tipCents } from "./money.js";
import type { Cart, GhostKitchenFlag, Quote, TipInput } from "./types.js";

/** Everything the user is agreeing to when they confirm. Any change gives a new hash. */
export function quoteHash(cart: Cart, totalCents: number, tipCentsValue: number): string {
  const payload = {
    provider: cart.provider,
    restaurant: cart.restaurant_id,
    mode: cart.mode,
    lines: cart.lines.map((l) => [l.item_id, l.quantity, l.unit_price_cents, l.selected_options.map((o) => `${o.modifier}=${o.option}`)]),
    total: totalCents,
    tip: tipCentsValue,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

/** Turns a provider's fee readout into a normalized Quote and applies the user's tip. */
export function assembleQuote(args: {
  cart: Cart;
  pq: ProviderQuote;
  tip?: TipInput;
  rating?: number;
  ghost?: GhostKitchenFlag;
  matchGroup?: string;
}): Quote {
  const { cart, pq, tip } = args;
  const fees = pq.delivery_fee_cents + pq.service_fee_cents + pq.small_order_fee_cents + pq.other_fees.reduce((s, f) => s + f.amount_cents, 0);
  const discount = pq.discounts.reduce((s, d) => s + d.amount_cents, 0);
  const beforeTip = pq.subtotal_cents + fees + pq.tax_cents - discount;

  let verified = pq.verified;
  const notes = [...pq.estimate_notes];
  // If the provider shows its own total and our line items don't add up to it, we missed a fee.
  if (pq.total_before_tip_cents != null && pq.total_before_tip_cents !== beforeTip) {
    verified = false;
    notes.push(`Line items add up to ${fmt(beforeTip)} but the app shows ${fmt(pq.total_before_tip_cents)}. Using the app's figure; the breakdown is incomplete.`);
  }
  if (pq.total_before_tip_cents == null && verified) {
    verified = false;
    notes.push("The app's own total could not be read, so this total is our sum of the visible line items.");
  }
  const base = pq.total_before_tip_cents ?? beforeTip;
  const tipValue = tip ? tipCents(pq.subtotal_cents, tip) : 0;
  const total = base + tipValue;

  return {
    id: `quote_${randomUUID().slice(0, 8)}`,
    cart_id: cart.id,
    provider: cart.provider,
    restaurant_id: cart.restaurant_id,
    restaurant_name: cart.restaurant_name,
    currency: "USD",
    subtotal_cents: pq.subtotal_cents,
    delivery_fee_cents: pq.delivery_fee_cents,
    service_fee_cents: pq.service_fee_cents,
    small_order_fee_cents: pq.small_order_fee_cents,
    other_fees: pq.other_fees,
    tax_cents: pq.tax_cents,
    discounts: pq.discounts,
    tip_cents: tipValue,
    tip_status: tip ? "set" : "needs_user_input",
    provider_suggested_tip_cents: pq.provider_suggested_tip_cents,
    total_cents: total,
    eta_min: pq.eta_min,
    verified,
    estimate_notes: notes,
    fit: cartFit(cart),
    rating: args.rating,
    ghost_kitchen: args.ghost,
    match_group: args.matchGroup,
    quote_hash: quoteHash(cart, total, tipValue),
    quoted_at: new Date().toISOString(),
  };
}

/** Plain-text itemized total. This exact text is what the user confirms. */
export function itemizedText(cart: Cart, q: Quote, tip?: TipInput): string {
  const rows: [string, string][] = [];
  for (const l of cart.lines) {
    const opts = l.selected_options.map((o) => o.option).join(", ");
    rows.push([`${l.quantity} × ${l.name}${opts ? ` (${opts})` : ""}`, fmt(l.line_total_cents)]);
  }
  rows.push(["Subtotal", fmt(q.subtotal_cents)]);
  if (cart.mode === "delivery") rows.push(["Delivery fee", fmt(q.delivery_fee_cents)]);
  if (q.service_fee_cents) rows.push(["Service fee", fmt(q.service_fee_cents)]);
  if (q.small_order_fee_cents) rows.push(["Small order fee", fmt(q.small_order_fee_cents)]);
  for (const f of q.other_fees) rows.push([f.label, fmt(f.amount_cents)]);
  rows.push([q.verified ? "Tax" : "Tax (estimate)", fmt(q.tax_cents)]);
  for (const d of q.discounts) rows.push([d.label, `-${fmt(d.amount_cents)}`]);
  rows.push([q.tip_status === "set" ? `Tip${tip ? ` (${describeTip(tip)})` : ""}` : "Tip (not set yet)", fmt(q.tip_cents)]);
  rows.push([q.verified ? "TOTAL" : "ESTIMATED TOTAL (not verified)", fmt(q.total_cents)]);
  const width = Math.max(...rows.map(([a]) => a.length));
  return rows.map(([a, b]) => `${a.padEnd(width)}  ${b.padStart(8)}`).join("\n");
}
