import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { mapOrderToMenu } from "../core/cartMapper.js";
import { detectGhostKitchens } from "../core/compare/ghostKitchen.js";
import { assignMatchGroups } from "../core/compare/matching.js";
import { PROVIDER_NAMES, rankQuotes } from "../core/compare/ranking.js";
import { fmt } from "../core/money.js";
import { assembleQuote, itemizedText } from "../core/quote.js";
import { DesiredItem, ProviderId, RankWeights, SearchCriteria, TipInput, type MenuItem, type Quote, type Restaurant } from "../core/types.js";
import type { ProviderAdapter } from "../providers/ProviderAdapter.js";
import { handler, ok, quoteView, requireConnected, ToolError } from "./shared.js";

function providerOf(restaurantId: string): ProviderId {
  const parsed = ProviderId.safeParse(restaurantId.split(":")[0]);
  if (!parsed.success) throw new ToolError("bad_restaurant_id", `"${restaurantId}" is not a restaurant id from search.`, "Use the id field of a search result.");
  return parsed.data;
}

async function cachedMenu(ctx: AppContext, a: ProviderAdapter, restaurantId: string): Promise<MenuItem[]> {
  const hit = ctx.menuCache.get(restaurantId);
  if (hit) return hit;
  const menu = await ctx.throttle.run(a.id, () => a.getMenu(restaurantId));
  ctx.menuCache.set(restaurantId, menu);
  return menu;
}

async function cachedSearch(ctx: AppContext, a: ProviderAdapter, c: SearchCriteria): Promise<Restaurant[]> {
  const key = JSON.stringify([a.id, c.query ?? "", c.address ?? "", c.mode ?? ""]);
  const hit = ctx.searchCache.get(key);
  if (hit) return hit;
  const res = await ctx.throttle.run(a.id, () => a.search(c));
  ctx.searchCache.set(key, res);
  return res;
}

export function registerShoppingTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "search",
    {
      title: "Search restaurants across apps",
      description:
        "Searches every connected delivery app and returns normalized restaurants. Listings with the same match_group are the same restaurant on different apps. Each result carries a ghost_kitchen flag with reasons: always tell the user when a place is flagged.",
      inputSchema: SearchCriteria.shape,
      annotations: { readOnlyHint: true },
    },
    handler(ctx, "search", async (input: SearchCriteria) => {
      const prefs = await ctx.prefs.get();
      const criteria: SearchCriteria = {
        ...input,
        address: input.address ?? prefs.default_address,
        mode: input.mode ?? prefs.default_mode ?? "delivery",
        min_rating: input.min_rating ?? prefs.min_rating,
        max_eta_min: input.max_eta_min ?? prefs.max_eta_min,
        dietary: input.dietary ?? prefs.dietary,
      };
      const excludeGhost = input.exclude_ghost_kitchens ?? prefs.exclude_ghost_kitchens;
      const wanted = input.providers ?? prefs.preferred_providers;

      const searched: string[] = [];
      const skipped: { provider: string; reason: string }[] = [];
      let found: Restaurant[] = [];
      let nearby: Restaurant[] = [];
      // One provider at a time, on purpose. No parallel load on anyone's site.
      for (const a of ctx.registry.all()) {
        if (wanted && !wanted.includes(a.id)) continue;
        const s = await a.sessionStatus();
        if (s.status !== "connected") {
          skipped.push({ provider: a.id, reason: s.status === "expired" ? "session expired: reconnect" : "not connected" });
          continue;
        }
        found = found.concat(await cachedSearch(ctx, a, criteria));
        // The unfiltered nearby list lets the ghost-kitchen check see every brand at an address.
        nearby = nearby.concat(await cachedSearch(ctx, a, { address: criteria.address, mode: criteria.mode }));
        searched.push(a.id);
      }
      if (searched.length === 0)
        throw new ToolError("no_connected_providers", "No delivery app is connected, so there is nothing to search.", "Ask the user which apps they use, then call connect_provider for each.");

      const flags = detectGhostKitchens(found, nearby);
      let results = assignMatchGroups(found).map((r) => ({ ...r, ghost_kitchen: flags.get(r.id) }));
      for (const r of results) ctx.seen.set(r.id, r);

      const total = results.length;
      const hidden = { ghost_kitchens: 0, rating: 0, eta: 0 };
      results = results.filter((r) => {
        if (excludeGhost && r.ghost_kitchen?.flagged) {
          hidden.ghost_kitchens++;
          return false;
        }
        if (criteria.min_rating != null && (r.rating ?? 0) < criteria.min_rating) {
          hidden.rating++;
          return false;
        }
        if (criteria.max_eta_min != null && (r.eta_min ?? Infinity) > criteria.max_eta_min) {
          hidden.eta++;
          return false;
        }
        return true;
      });
      results.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

      const groups = new Map<string, string[]>();
      for (const r of results) groups.set(r.match_group!, [...(groups.get(r.match_group!) ?? []), r.provider]);

      const notes: string[] = [];
      if (excludeGhost === undefined) notes.push("The user has never said whether to hide ghost kitchens. Ask once, then save it with save_preferences. Flagged places are shown and labeled for now.");
      if (hidden.ghost_kitchens) notes.push(`${hidden.ghost_kitchens} likely ghost kitchen listing(s) hidden because the user wants real restaurants only.`);
      if (results.some((r) => r.ghost_kitchen?.flagged)) notes.push("Some results are flagged as likely ghost kitchens. Say so, with the reasons, whenever you mention them.");
      if (criteria.dietary?.length) notes.push(`Dietary needs (${criteria.dietary.join(", ")}) are not filtered at restaurant level. Check dietary_tags on menu items with get_menu.`);

      return ok({
        searched,
        skipped,
        count: results.length,
        hidden_by_filters: total - results.length ? hidden : undefined,
        same_restaurant_on_multiple_apps: [...groups.entries()].filter(([, v]) => v.length > 1).map(([match_group, providers]) => ({ match_group, providers })),
        notes,
        results: results.map((r) => ({ ...r, app: PROVIDER_NAMES[r.provider], lat: undefined, lng: undefined, delivery_fee: r.delivery_fee_cents != null ? fmt(r.delivery_fee_cents) : undefined })),
      });
    }),
  );

  server.registerTool(
    "get_menu",
    { title: "Get a restaurant's menu", description: "The menu for one restaurant on one app, with prices (cents), modifiers and dietary tags. Prices can differ between apps for the same restaurant.", inputSchema: { provider: ProviderId, restaurant_id: z.string() }, annotations: { readOnlyHint: true } },
    handler(ctx, "get_menu", async ({ provider, restaurant_id }: { provider: ProviderId; restaurant_id: string }) => {
      if (providerOf(restaurant_id) !== provider) throw new ToolError("provider_mismatch", `${restaurant_id} does not belong to ${provider}.`, "Restaurant ids are per app. Use the id from that app's search result.");
      const a = await requireConnected(ctx, provider);
      const menu = await cachedMenu(ctx, a, restaurant_id);
      return ok({ provider, restaurant_id, items: menu.map((m) => ({ ...m, price: fmt(m.price_cents) })) });
    }),
  );

  server.registerTool(
    "build_cart",
    {
      title: "Build a cart on one app",
      description:
        "Maps the order the user wants onto one app's menu and puts it in their cart there. Dish and option names differ between apps, so matching is fuzzy: read `warnings` and `unmapped` and tell the user about anything approximate, defaulted or missing. Call once per app with the same items to compare apps.",
      inputSchema: { provider: ProviderId, restaurant_id: z.string(), items: z.array(DesiredItem).min(1), mode: z.enum(["delivery", "pickup"]).optional() },
    },
    handler(ctx, "build_cart", async (args: { provider: ProviderId; restaurant_id: string; items: DesiredItem[]; mode?: "delivery" | "pickup" }) => {
      if (providerOf(args.restaurant_id) !== args.provider) throw new ToolError("provider_mismatch", `${args.restaurant_id} does not belong to ${args.provider}.`, "Use the id from that app's search result.");
      const a = await requireConnected(ctx, args.provider);
      const prefs = await ctx.prefs.get();
      const restaurant = ctx.seen.get(args.restaurant_id) ?? (await ctx.throttle.run(a.id, () => a.getRestaurant(args.restaurant_id)));
      if (!restaurant) throw new ToolError("restaurant_not_found", `No restaurant ${args.restaurant_id} on ${a.displayName}.`, "Search again and use an id from the results.");
      const menu = await cachedMenu(ctx, a, args.restaurant_id);
      const cart = mapOrderToMenu({ provider: a.id, restaurantId: restaurant.id, restaurantName: restaurant.name, mode: args.mode ?? prefs.default_mode ?? "delivery", desired: args.items, menu });
      if (cart.lines.length === 0)
        throw new ToolError("nothing_matched", `None of the requested items were found on ${restaurant.name}'s menu on ${a.displayName}.`, "Call get_menu and use exact item names or item_id.");
      await ctx.throttle.run(a.id, () => a.syncCart(cart));
      ctx.carts.set(cart.id, { cart, restaurant });
      return ok({ cart: { ...cart, subtotal: fmt(cart.subtotal_cents) }, ghost_kitchen: restaurant.ghost_kitchen?.flagged ? restaurant.ghost_kitchen : undefined, next_step: "Call quote_cart with this cart_id and the user's tip." });
    }),
  );

  server.registerTool(
    "quote_cart",
    {
      title: "Get the all-in price for a cart",
      description:
        "Reads the itemized landed cost from the app's checkout (without ordering): subtotal, delivery fee, service fee, small-order fee, tax, promos and membership discounts, tip, final total and ETA. `verified: false` means the total is an ESTIMATE and must be presented as one. Tip comes from the user: pass what they said, or omit it to use their saved tip. If no tip is known the total is before tip and tip_status is 'needs_user_input'.",
      inputSchema: { cart_id: z.string(), tip: TipInput.optional().describe("The tip the user chose: {type:'percent', value:15} or {type:'flat', cents:500}. Never invent one.") },
    },
    handler(ctx, "quote_cart", async ({ cart_id, tip }: { cart_id: string; tip?: TipInput }) => {
      const rec = ctx.carts.get(cart_id);
      if (!rec) throw new ToolError("cart_not_found", `No cart ${cart_id}. Carts don't survive a server restart.`, "Call build_cart again.");
      const a = await requireConnected(ctx, rec.cart.provider);
      const prefs = await ctx.prefs.get();
      const useTip = tip ?? prefs.tip;
      const pq = await ctx.throttle.run(a.id, () => a.quote(rec.cart, { address: prefs.default_address, has_membership: prefs.memberships?.[a.id] === true }));
      const quote = assembleQuote({ cart: rec.cart, pq, tip: useTip, rating: rec.restaurant?.rating, ghost: rec.restaurant?.ghost_kitchen, matchGroup: rec.restaurant?.match_group });
      rec.lastQuote = quote;
      rec.lastTip = useTip;
      ctx.quotes.set(quote.id, quote);
      const notes: string[] = [];
      if (!quote.verified) notes.push("This total is an ESTIMATE. Say so and say why (estimate_notes).");
      if (quote.tip_status === "needs_user_input") notes.push("No tip set. Ask the user what tip they want, then call quote_cart again with it. The total shown is before tip.");
      else if (!tip && prefs.tip) notes.push("Used the user's saved tip.");
      if (quote.ghost_kitchen?.flagged) notes.push("This restaurant is flagged as a likely ghost kitchen. Tell the user.");
      if (prefs.memberships?.[a.id] === undefined && a.membershipName) notes.push(`Not known whether the user has ${a.membershipName}. It can lower fees: ask, then save_preferences.`);
      return ok({ quote: quoteView(quote), notes }, itemizedText(rec.cart, quote, useTip));
    }),
  );

  server.registerTool(
    "compare",
    {
      title: "Compare quotes",
      description:
        "Ranks quotes from quote_cart: all-in total first, then ETA, rating and how completely each app covers the order. Returns a ready-to-show markdown table, a one-line reason per option, and one clear recommendation. Pass `weights` if the user cares more about speed or rating.",
      inputSchema: {
        quote_ids: z.array(z.string()).min(1),
        weights: RankWeights.partial().optional().describe("Relative importance, e.g. {total: 0.3, eta: 0.6} for 'I care more about speed'."),
        budget_cents: z.number().int().optional().describe("The user's all-in budget, in cents."),
      },
      annotations: { readOnlyHint: true },
    },
    handler(ctx, "compare", async (args: { quote_ids: string[]; weights?: Partial<RankWeights>; budget_cents?: number }) => {
      const prefs = await ctx.prefs.get();
      const quotes: Quote[] = args.quote_ids.map((id) => {
        const q = ctx.quotes.get(id);
        if (!q) throw new ToolError("quote_not_found", `No quote ${id}.`, "Call quote_cart again and use the new quote id.");
        return q;
      });
      const cmp = rankQuotes(quotes, { weights: args.weights ?? prefs.weights, budget_cents: args.budget_cents ?? prefs.budget_cents });
      return ok(
        {
          recommendation: cmp.recommendation,
          warnings: cmp.warnings,
          weights_used: cmp.weights,
          ranked: cmp.ranked.map((r) => ({ rank: r.rank, quote_id: r.quote.id, cart_id: r.quote.cart_id, app: PROVIDER_NAMES[r.quote.provider], restaurant: r.quote.restaurant_name, total: quoteView(r.quote).display.total, verified: r.quote.verified, eta_min: r.quote.eta_min, rating: r.quote.rating, likely_ghost_kitchen: r.quote.ghost_kitchen?.flagged ?? false, over_budget: r.over_budget, reason: r.reason })),
        },
        `${cmp.table_markdown}\n\n**Recommendation:** ${cmp.recommendation}${cmp.warnings.length ? "\n\n" + cmp.warnings.map((w) => `⚠ ${w}`).join("\n") : ""}`,
      );
    }),
  );
}
