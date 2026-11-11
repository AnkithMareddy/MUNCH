import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { PROVIDER_NAMES } from "../core/compare/ranking.js";
import { fmt } from "../core/money.js";
import { assembleQuote, itemizedText } from "../core/quote.js";
import { handler, ok, quoteView, requireConnected, ToolError } from "./shared.js";

export function registerCheckoutTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "open_checkout",
    {
      title: "Hand off to the app's checkout",
      description:
        "Opens the delivery app's own checkout page with the cart already filled in, so the user can review it and tap 'Place order' themselves. This does not place an order. Only call it after the user has seen the itemized total for this cart and said they want to go ahead.",
      inputSchema: { cart_id: z.string() },
    },
    handler(ctx, "open_checkout", async ({ cart_id }: { cart_id: string }) => {
      const rec = ctx.carts.get(cart_id);
      if (!rec) throw new ToolError("cart_not_found", `No cart ${cart_id}.`, "Call build_cart again.");
      if (!rec.lastQuote) throw new ToolError("not_quoted", "This cart has not been priced yet, so the user has not seen a total.", "Call quote_cart, show the itemized total, and ask the user before checkout.");
      const a = await requireConnected(ctx, rec.cart.provider);
      const res = await ctx.throttle.run(a.id, () => a.openCheckout(rec.cart));
      return ok({
        provider: a.id,
        app: a.displayName,
        checkout_url: res.url,
        opened_in_browser: res.opened,
        last_quoted_total: quoteView(rec.lastQuote).display.total,
        tell_user: `${res.opened ? "The checkout page is open" : "Open this link"} on ${a.displayName}. Review the cart and total there, then tap "Place order" yourself. Nothing has been ordered. The app's own total is the final one.${res.note ? " " + res.note : ""}`,
      });
    }),
  );

  server.registerTool(
    "request_confirmation",
    {
      title: "Ask the user to confirm the final total",
      description:
        "Shows the user the final itemized total for one quote and asks them directly for a yes or no, in a prompt the assistant cannot answer on their behalf. On yes, returns a one-time confirmation_token (5 minutes, bound to this exact cart and total) for place_order. If it returns status 'awaiting_user', give the user the confirm_url, wait for them to click, then call this again with the same quote_id.",
      inputSchema: { quote_id: z.string() },
    },
    handler(ctx, "request_confirmation", async ({ quote_id }: { quote_id: string }) => {
      const quote = ctx.quotes.get(quote_id);
      const rec = quote && ctx.carts.get(quote.cart_id);
      if (!quote || !rec) throw new ToolError("quote_not_found", `No quote ${quote_id}.`, "Call quote_cart again.");
      if (rec.lastQuote?.id !== quote.id) throw new ToolError("quote_stale", "A newer quote exists for this cart.", "Confirm the newest quote instead.");
      if (quote.tip_status !== "set") throw new ToolError("tip_not_set", "The tip has not been chosen, so there is no final total to confirm.", "Ask the user for a tip and call quote_cart again.");

      const title = `Confirm order: ${quote.restaurant_name} on ${PROVIDER_NAMES[quote.provider]}`;
      const body = itemizedText(rec.cart, quote, rec.lastTip) + (quote.verified ? "" : "\n\nNote: this total is an estimate. The app's checkout shows the final amount.");
      const mint = () => ({ status: "confirmed", cart_id: quote.cart_id, confirmation_token: ctx.confirm.mintToken(quote.cart_id, quote.quote_hash), note: "One-time token. Valid 5 minutes, for this exact cart and total only." });

      // A confirmation the user already answered on the local page.
      const pending = ctx.confirm.findPending(quote.id);
      if (pending) {
        if (pending.status === "waiting") return ok({ status: "awaiting_user", confirm_url: ctx.confirm.pendingUrl(pending), tell_user: "Open the link, check the total, and click Yes or No. Then tell me." });
        ctx.confirm.clearPending(pending.id);
        return ok(pending.status === "confirmed" ? mint() : { status: "declined", note: "The user said no. Do not order." });
      }

      // Preferred: the client's own dialog. The answer never passes through the model.
      if (server.server.getClientCapabilities()?.elicitation) {
        const res = await server.server.elicitInput({
          message: `${title}\n\n${body}\n\nPlace this order for ${fmt(quote.total_cents)}?`,
          requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: `Yes, place this order for ${fmt(quote.total_cents)}` } }, required: ["confirm"] },
        });
        if (res.action === "accept" && res.content?.confirm === true) return ok(mint());
        return ok({ status: "declined", note: "The user did not confirm. Do not order." });
      }

      // Fallback: a page on this machine that only the user can click.
      const local = await ctx.confirm.createLocalConfirmation({ cartId: quote.cart_id, quoteId: quote.id, quoteHash: quote.quote_hash, title, body });
      return ok({ status: "awaiting_user", confirm_url: local.url, tell_user: "Open the link, check the total, and click Yes or No. Then tell me.", next_step: "After the user says they clicked, call request_confirmation again with the same quote_id." });
    }),
  );

  server.registerTool(
    "place_order",
    {
      title: "Place the order (off by default)",
      description:
        "Places the order on the delivery app. Disabled unless the user turned it on (MUNCH_ENABLE_PLACE_ORDER=1). Requires a one-time confirmation_token from request_confirmation, which only exists after the user approved the final itemized total. The price is re-checked first: if anything changed, the order is refused and the user must confirm again. The default path is open_checkout instead.",
      inputSchema: { cart_id: z.string(), confirmation_token: z.string() },
      annotations: { destructiveHint: true },
    },
    handler(ctx, "place_order", async ({ cart_id, confirmation_token }: { cart_id: string; confirmation_token: string }) => {
      if (!ctx.config.enablePlaceOrder)
        throw new ToolError("place_order_disabled", "Direct ordering is turned off (the default).", "Use open_checkout so the user can tap 'Place order' themselves. To enable direct ordering the user must set MUNCH_ENABLE_PLACE_ORDER=1 and restart.");
      const rec = ctx.carts.get(cart_id);
      if (!rec?.lastQuote) throw new ToolError("cart_not_found", `No priced cart ${cart_id}.`, "Build and quote the cart, then get the user's confirmation.");
      const a = await requireConnected(ctx, rec.cart.provider);
      if (!a.placeOrder) throw new ToolError("not_supported", `${a.displayName} only supports checkout handoff.`, "Use open_checkout.");

      // Re-read the price right now. The token only matches if nothing moved since the user said yes.
      const prefs = await ctx.prefs.get();
      const pq = await ctx.throttle.run(a.id, () => a.quote(rec.cart, { address: prefs.default_address, has_membership: prefs.memberships?.[a.id] === true }));
      const fresh = assembleQuote({ cart: rec.cart, pq, tip: rec.lastTip, rating: rec.restaurant?.rating, ghost: rec.restaurant?.ghost_kitchen, matchGroup: rec.restaurant?.match_group });
      const check = ctx.confirm.consumeToken(confirmation_token, cart_id, fresh.quote_hash);
      if (!check.ok) {
        // Keep the quote the user already saw unless the price really moved.
        let current = rec.lastQuote;
        if (fresh.quote_hash !== current.quote_hash) {
          current = rec.lastQuote = fresh;
          ctx.quotes.set(fresh.id, fresh);
        }
        throw new ToolError("confirmation_invalid", check.reason, `Nothing was ordered. Show the user the current total (quote ${current.id}: ${quoteView(current).display.total}) and call request_confirmation again.`);
      }
      const receipt = await ctx.throttle.run(a.id, () => a.placeOrder!(rec.cart));
      ctx.carts.delete(cart_id);
      return ok({ status: "placed", app: a.displayName, order_id: receipt.order_id, placed_at: receipt.placed_at, total: fmt(fresh.total_cents), demo: a.id.startsWith("mock") ? "Demo provider: no real order exists." : undefined });
    }),
  );
}
