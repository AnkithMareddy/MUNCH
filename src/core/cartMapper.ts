import { randomUUID } from "node:crypto";
import { normalize, similarity } from "./text.js";
import type { Cart, CartLine, DesiredItem, MenuItem, ProviderId } from "./types.js";

const ACCEPT = 0.55;
const CONFIDENT = 0.8;

export function bestMenuMatch(wanted: string, menu: MenuItem[]): { item: MenuItem; score: number } | undefined {
  let best: { item: MenuItem; score: number } | undefined;
  for (const item of menu) {
    if (!item.available) continue;
    const score = similarity(wanted, item.name);
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= ACCEPT ? best : undefined;
}

/**
 * Maps what the user asked for onto one app's menu. Apps name dishes and options
 * differently, so matching is fuzzy and every guess is reported as a warning.
 */
export function mapOrderToMenu(args: {
  provider: ProviderId;
  restaurantId: string;
  restaurantName: string;
  mode: "delivery" | "pickup";
  desired: DesiredItem[];
  menu: MenuItem[];
}): Cart {
  const lines: CartLine[] = [];
  const unmapped: string[] = [];
  const warnings: string[] = [];

  for (const want of args.desired) {
    const exact = want.item_id ? args.menu.find((m) => m.id === want.item_id && m.available) : undefined;
    const match = exact ? { item: exact, score: 1 } : bestMenuMatch(want.name, args.menu);
    if (!match) {
      unmapped.push(want.name);
      continue;
    }
    const { item, score } = match;
    if (score < CONFIDENT) warnings.push(`"${want.name}" matched "${item.name}" approximately. Check it's the right dish.`);

    const selected: CartLine["selected_options"] = [];
    const chosenGroups = new Set<string>();
    for (const wantedOpt of want.modifiers ?? []) {
      let best: { group: string; groupId: string; name: string; delta: number; score: number } | undefined;
      for (const group of item.modifiers) {
        for (const opt of group.options) {
          const s = Math.max(similarity(wantedOpt, opt.name), similarity(wantedOpt, `${group.name} ${opt.name}`));
          if (!best || s > best.score) best = { group: group.name, groupId: group.id, name: opt.name, delta: opt.price_delta_cents, score: s };
        }
      }
      if (best && best.score >= ACCEPT) {
        selected.push({ modifier: best.group, option: best.name, price_delta_cents: best.delta });
        chosenGroups.add(best.groupId);
      } else {
        warnings.push(`${item.name}: no option like "${wantedOpt}" on this app. Left out.`);
      }
    }
    // Required groups the user didn't speak to get the app's default, and we say so.
    for (const group of item.modifiers) {
      if (!group.required || chosenGroups.has(group.id)) continue;
      const def = group.options.find((o) => o.is_default) ?? group.options[0];
      if (!def) continue;
      selected.push({ modifier: group.name, option: def.name, price_delta_cents: def.price_delta_cents });
      warnings.push(`${item.name}: "${group.name}" is required. Defaulted to "${def.name}".`);
    }

    const unit = item.price_cents + selected.reduce((s, o) => s + o.price_delta_cents, 0);
    lines.push({
      item_id: item.id,
      name: item.name,
      quantity: want.quantity,
      unit_price_cents: unit,
      selected_options: selected,
      line_total_cents: unit * want.quantity,
      requested_as: want.name,
      match_score: Number(score.toFixed(2)),
    });
  }

  return {
    id: `cart_${randomUUID().slice(0, 8)}`,
    provider: args.provider,
    restaurant_id: args.restaurantId,
    restaurant_name: args.restaurantName,
    mode: args.mode,
    lines,
    unmapped,
    warnings,
    subtotal_cents: lines.reduce((s, l) => s + l.line_total_cents, 0),
    created_at: new Date().toISOString(),
  };
}

/** Share of requested items that made it into the cart. */
export function cartFit(cart: Cart): number {
  const asked = cart.lines.length + cart.unmapped.length;
  return asked === 0 ? 0 : cart.lines.length / asked;
}

export { normalize };
