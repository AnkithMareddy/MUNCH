import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { ProviderId, RankWeights, TipInput } from "../core/types.js";
import { intakeGuide } from "../prompts/guide.js";
import { PLANNED } from "../providers/registry.js";
import { handler, ok, requireAdapter } from "./shared.js";

export function registerProviderTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "list_providers",
    { title: "List delivery apps", description: "Which delivery apps are supported, which are connected, and whether each session is still valid.", inputSchema: {}, annotations: { readOnlyHint: true } },
    handler(ctx, "list_providers", async () => {
      const prefs = await ctx.prefs.get();
      const available = [];
      for (const a of ctx.registry.all()) {
        const s = await a.sessionStatus();
        available.push({
          provider: a.id,
          name: a.displayName,
          status: s.status,
          session_valid: s.status === "connected",
          connected_at: s.connected_at,
          membership: a.membershipName ? { name: a.membershipName, user_has_it: prefs.memberships?.[a.id] ?? null } : undefined,
          shares_inventory_with: a.overlapsWith,
          notice: a.connectNotice,
        });
      }
      return ok({
        available,
        not_yet_supported: PLANNED.filter((p) => !ctx.registry.get(p.id)).map((p) => ({ provider: p.id, name: p.displayName, note: p.note })),
        storage: (await ctx.store.persistent()) ? "Sessions and preferences are saved encrypted on this machine." : "No OS keychain found, so nothing is saved to disk. Sessions and preferences last only until this server restarts.",
      });
    }),
  );

  server.registerTool(
    "connect_provider",
    {
      title: "Connect a delivery app",
      description:
        "Starts sign-in for one delivery app. Opens the app's real login page in a visible browser window; the user signs in there themselves (including 2FA). Passwords are never seen or stored. May return status 'pending' while the user is still signing in: call again (or list_providers) to check.",
      inputSchema: { provider: ProviderId },
    },
    handler(ctx, "connect_provider", async ({ provider }: { provider: ProviderId }) => {
      const a = requireAdapter(ctx, provider);
      const s = await ctx.throttle.run(provider, () => a.connect());
      return ok({ provider, name: a.displayName, status: s.status, note: s.note, notice: a.connectNotice });
    }),
  );

  server.registerTool(
    "disconnect_provider",
    { title: "Disconnect a delivery app", description: "Signs out of one delivery app on this machine and deletes its saved session.", inputSchema: { provider: ProviderId } },
    handler(ctx, "disconnect_provider", async ({ provider }: { provider: ProviderId }) => {
      const a = requireAdapter(ctx, provider);
      await a.disconnect();
      return ok({ provider, status: "disconnected" });
    }),
  );

  server.registerTool(
    "get_preferences",
    { title: "Get saved preferences", description: "The user's saved defaults (address, dietary needs, ghost-kitchen choice, memberships, tip, filters). Anything missing has never been asked.", inputSchema: {}, annotations: { readOnlyHint: true } },
    handler(ctx, "get_preferences", async () => {
      const p = await ctx.prefs.get();
      const never_asked = (["exclude_ghost_kitchens", "default_address", "dietary", "tip", "memberships"] as const).filter((k) => p[k] === undefined);
      return ok({ preferences: p, never_asked, saved_to_disk: await ctx.store.persistent() });
    }),
  );

  server.registerTool(
    "save_preferences",
    {
      title: "Save preferences",
      description: "Saves stable preferences for next time (merged with what is already saved). Only save what the user actually said. Pass null to clear a value. Stored encrypted on this machine only.",
      inputSchema: {
        exclude_ghost_kitchens: z.boolean().nullable().optional().describe("true = real restaurants only. false = show ghost kitchens, labeled."),
        default_address: z.string().nullable().optional(),
        default_mode: z.enum(["delivery", "pickup"]).nullable().optional(),
        dietary: z.array(z.string()).nullable().optional(),
        min_rating: z.number().min(0).max(5).nullable().optional(),
        max_eta_min: z.number().min(1).nullable().optional(),
        budget_cents: z.number().int().min(0).nullable().optional().describe("Usual all-in budget, in cents."),
        tip: TipInput.nullable().optional().describe("The user's usual tip. Only save if they asked to remember it."),
        memberships: z.record(z.string(), z.boolean()).nullable().optional().describe("Provider id → has membership, e.g. { doordash: true }"),
        preferred_providers: z.array(ProviderId).nullable().optional(),
        weights: RankWeights.nullable().optional().describe("Ranking priorities. Default: total 0.6, eta 0.2, rating 0.15, fit 0.05."),
      },
    },
    handler(ctx, "save_preferences", async (patch: Record<string, unknown>) => {
      const preferences = await ctx.prefs.update(patch);
      return ok({ preferences, saved_to_disk: await ctx.store.persistent() });
    }),
  );

  server.registerTool(
    "get_intake_guide",
    { title: "How to run the concierge conversation", description: "Returns the step-by-step guide for the concierge conversation: what to ask, how to compare, and the rules for checkout. Read this before the first search.", inputSchema: {}, annotations: { readOnlyHint: true } },
    handler(ctx, "get_intake_guide", async () => ({ content: [{ type: "text", text: intakeGuide() }] })),
  );
}
