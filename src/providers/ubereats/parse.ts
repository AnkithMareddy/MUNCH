import type { MenuItem, Modifier, Restaurant } from "../../core/types.js";
import type { ProviderQuote } from "../ProviderAdapter.js";

/**
 * Pure functions that turn Uber Eats' own JSON into our normalized types.
 * Field names here were confirmed against a real recording (Nov 2026).
 * Every function throws ParseError rather than guess when a field is missing.
 */
export class ParseError extends Error {}

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new ParseError(`missing ${what}`);
  return v;
};

/** "$1,234.50" → 123450. Returns undefined when there is no dollar amount. */
export function dollars(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  if (/^\s*free\s*$/i.test(text)) return 0;
  const m = /(-)?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(text);
  if (!m) return undefined;
  const cents = Math.round(parseFloat(m[2]!.replace(/,/g, "")) * 100);
  return m[1] ? -cents : cents;
}

/** Uber's amountE5 is dollars × 100,000, as a number or a {high, low} 64-bit pair. */
export function e5ToCents(v: unknown): number | undefined {
  if (typeof v === "number") return Math.round(v / 1000);
  if (v && typeof v === "object" && "low" in v) {
    const { high = 0, low } = v as { high?: number; low: number };
    return Math.round((high * 2 ** 32 + (low >>> 0)) / 1000);
  }
  return undefined;
}

/** The slower end of a time range: "27–45 Min" → 45, "Delivered in 12 to 24 min" → 24, "12 min" → 12. */
export function etaUpper(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const nums = [...text.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10));
  return nums.length ? Math.max(...nums.slice(0, 2)) : undefined;
}

const textOf = (v: unknown): string | undefined => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).text === "string" ? (v as any).text : undefined);

/** Store URL id: the store uuid's 16 bytes, base64url-encoded. */
export function storeUrlId(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}

export interface FeedStore {
  restaurant: Restaurant;
  actionUrl?: string;
}

/**
 * Stores from a home or search feed (getFeedV1). Feed items come in several
 * layouts (carousels, single stores, grids), so this collects every object
 * that looks like a store card, wherever it sits.
 */
export function parseFeed(data: any): FeedStore[] {
  const out = new Map<string, FeedStore>();
  const visit = (node: any, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    const uuid = node.storeUuid ?? (node.uuid && node.actionUrl && node.title && node.rating !== undefined ? node.uuid : undefined);
    const title = textOf(node.title);
    if (typeof uuid === "string" && title && !out.has(uuid)) {
      const meta: any[] = [node.meta, node.meta2, node.meta4].flat().filter(Boolean);
      const eta = meta.find((m) => m.badgeType === "ETD");
      const member = meta.find((m) => m.badgeType === "MembershipBenefit");
      const feeText = meta.map((m) => textOf(m)).find((t) => t && /delivery fee/i.test(t) && dollars(t) !== undefined);
      const rating = parseFloat(textOf(node.rating) ?? "");
      out.set(uuid, {
        actionUrl: typeof node.actionUrl === "string" && node.actionUrl.startsWith("/store/") ? node.actionUrl : undefined,
        restaurant: {
          id: `ubereats:${uuid}`,
          provider: "ubereats",
          name: title,
          cuisines: [],
          rating: Number.isFinite(rating) ? rating : undefined,
          eta_min: etaUpper(eta?.accessibilityText ?? eta?.text),
          delivery_fee_cents: dollars(member?.badgeDataWithFallback?.membership?.originalDeliveryFee) ?? dollars(feeText),
          supports_pickup: false,
        },
      });
      return;
    }
    for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(need(data?.feedItems, "feedItems"), 0);
  return [...out.values()];
}

export interface ParsedStore {
  restaurant: Restaurant;
  items: MenuItem[];
}

/** A restaurant page (getStoreV1): details plus the menu listing. Dish options load separately. */
export function parseStore(data: any): ParsedStore {
  const uuid: string = need(data?.uuid, "store uuid");
  const id = `ubereats:${uuid}`;
  const loc = data.location ?? {};
  const count = parseInt(String(data.storeInfoMetadata?.rawRatingStats?.ratingCount ?? "").replace(/\D/g, ""), 10);
  const restaurant: Restaurant = {
    id,
    provider: "ubereats",
    name: need(data.title, "store title"),
    address: typeof loc.address === "string" ? loc.address : undefined,
    lat: typeof loc.latitude === "number" ? loc.latitude : undefined,
    lng: typeof loc.longitude === "number" ? loc.longitude : undefined,
    phone: typeof data.phoneNumber === "string" ? data.phoneNumber : undefined,
    cuisines: (data.cuisineList ?? []).filter((c: unknown) => typeof c === "string"),
    description: data.parentChain?.name ? `Part of ${data.parentChain.name}` : undefined,
    rating: typeof data.rating?.ratingValue === "number" ? data.rating.ratingValue : undefined,
    rating_count: Number.isFinite(count) ? count : undefined,
    eta_min: etaUpper(data.etaRange?.accessibilityText ?? data.etaRange?.text),
    supports_pickup: (data.supportedDiningModes ?? []).some((m: any) => m.mode === "PICKUP" && m.isAvailable),
  };

  const items = new Map<string, MenuItem>();
  for (const sections of Object.values(need(data.catalogSectionsMap, "catalogSectionsMap")) as any[][]) {
    for (const section of sections ?? []) {
      const payload = section?.payload?.standardItemsPayload;
      const category = textOf(payload?.title);
      for (const it of payload?.catalogItems ?? []) {
        if (typeof it?.uuid !== "string" || typeof it.title !== "string") continue;
        const featured = /featured|picked for you|popular/i.test(category ?? "");
        // The same dish is listed under "Featured items" and its real section. Keep the real one.
        if (items.has(it.uuid) && featured) continue;
        items.set(it.uuid, {
          id: `${id}:${it.uuid}`,
          name: it.title,
          description: typeof it.itemDescription === "string" ? it.itemDescription : undefined,
          category,
          price_cents: typeof it.price === "number" ? it.price : 0,
          price_note: textOf(it.priceTagline),
          has_options: it.hasCustomizations === true,
          dietary_tags: [],
          modifiers: [],
          available: it.isSoldOut !== true && it.isAvailable !== false,
        });
      }
    }
  }
  return { restaurant, items: [...items.values()] };
}

/** One dish with its options (getMenuItemV1). */
export function parseMenuItem(data: any, restaurantId: string): MenuItem {
  const uuid: string = need(data?.uuid, "item uuid");
  const modifiers: Modifier[] = (data.customizationsList ?? []).map((g: any) => ({
    id: need(g.uuid, "option group uuid"),
    name: need(g.title, "option group title"),
    required: (g.minPermitted ?? 0) >= 1,
    min_select: g.minPermitted ?? 0,
    max_select: g.maxPermitted ?? 1,
    options: (g.options ?? []).map((o: any) => ({
      id: need(o.uuid, "option uuid"),
      name: need(o.title, "option title"),
      price_delta_cents: typeof o.price === "number" ? o.price : 0,
      is_default: (o.defaultQuantity ?? 0) > 0,
      // Sold-out options stay listed so the user hears why they can't have one.
      ...(o.isSoldOut ? { sold_out: true } : {}),
    })),
  }));
  return {
    id: `${restaurantId}:${uuid}`,
    name: need(data.title, "item title"),
    description: typeof data.itemDescription === "string" ? data.itemDescription : undefined,
    price_cents: typeof data.price === "number" ? data.price : 0,
    has_options: modifiers.length > 0,
    dietary_tags: [],
    modifiers,
    available: data.isSoldOut !== true,
  };
}

/** Option uuids the site put in an add-to-cart request, to check against what we meant to add. */
export function addedOptionIds(requestItem: any): string[] {
  return Object.values(requestItem?.customizations ?? {})
    .flat()
    .map((o: any) => o?.uuid)
    .filter((u): u is string => typeof u === "string")
    .sort();
}

export interface ParsedCheckout extends ProviderQuote {
  item_count?: number;
  /** The tip Uber has preselected. It is part of Uber's displayed total, not of ours. */
  selected_tip_cents: number;
}

/**
 * The checkout breakdown (getCheckoutPresentationV1).
 * Uber's displayed total includes whichever tip is preselected, so the
 * before-tip total is total − selected tip.
 */
export function parseCheckout(data: any): ParsedCheckout {
  const p = need(data?.checkoutPayloads, "checkoutPayloads");
  const charges: any[] = need(p.fareBreakdown?.charges, "fare breakdown");
  const total = need(e5ToCents(p.total?.total?.value?.amountE5), "total");
  const notes: string[] = [];
  const q: ParsedCheckout = {
    subtotal_cents: 0,
    delivery_fee_cents: 0,
    service_fee_cents: 0,
    small_order_fee_cents: 0,
    other_fees: [],
    tax_cents: 0,
    discounts: [],
    verified: true,
    estimate_notes: notes,
    selected_tip_cents: 0,
  };
  let sawSubtotal = false;

  for (const c of charges) {
    const title = textOf(c.title) ?? "Fee";
    const id: string = c.fareBreakdownChargeMetadata?.fareInfoID ?? "";
    const spoken: string = c.value?.accessibilityText ?? "";
    const pair = /before[^$]*(\$[\d.,]+)[^$]*now[^$]*(\$[\d.,]+|free)/i.exec(spoken);
    const before = pair ? dollars(pair[1]) : undefined;
    const now = pair ? dollars(pair[2]) : dollars(textOf(c.value)) ?? dollars(spoken);
    if (now === undefined) {
      q.verified = false;
      notes.push(`Could not read the amount for "${title}".`);
      continue;
    }
    const full = before ?? now;
    if (/tip/i.test(title) || /tip/i.test(id)) continue;

    if (/subtotal/i.test(id) || /^subtotal$/i.test(title)) {
      q.subtotal_cents = full;
      sawSubtotal = true;
    } else if (now < 0 || /promo|discount|offer|saving|credit/i.test(title)) {
      q.discounts.push({ label: title, amount_cents: Math.abs(now), kind: /uber one|member/i.test(title) ? "membership" : "promo" });
      continue;
    } else if (/delivery/i.test(title) || /delivery_fee/i.test(id)) q.delivery_fee_cents += full;
    else if (/tax/i.test(title) || /tax/i.test(id)) q.tax_cents += full;
    else if (/small order/i.test(title)) q.small_order_fee_cents += full;
    else if (/^service fee$/i.test(title)) q.service_fee_cents += full;
    else q.other_fees.push({ label: title, amount_cents: full });

    if (before !== undefined && before > now) {
      // The fee was reduced. Show the full fee and the saving as separate lines.
      const why = JSON.stringify(c.action ?? "");
      const member = /uber one|membership/i.test(why);
      q.discounts.push({ label: member ? `Uber One: lower ${title.toLowerCase()}` : `${title} discount`, amount_cents: before - now, kind: member ? "membership" : "promo" });
    }
  }

  if (!sawSubtotal) {
    const sub = e5ToCents(p.subtotal?.subtotal?.value?.amountE5);
    if (sub === undefined) throw new ParseError("missing subtotal");
    q.subtotal_cents = sub;
  }

  const tipping = p.upfrontTipping;
  const picked = (tipping?.options ?? []).find((o: any) => o.isSelectedTip) ?? (tipping?.customTipOption?.isSelectedTip ? tipping.customTipOption : undefined);
  q.selected_tip_cents = typeof picked?.amount === "number" ? picked.amount : 0;
  q.provider_suggested_tip_cents = q.selected_tip_cents || undefined;
  q.total_before_tip_cents = total - q.selected_tip_cents;
  q.eta_min = etaUpper(p.eta?.rangeText);
  q.item_count = typeof p.cartItems?.itemsCount === "number" ? p.cartItems.itemsCount : undefined;
  return q;
}
