import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppContext } from "../context.js";
import { ToolError } from "../core/errors.js";
import { fmt } from "../core/money.js";
import type { ProviderId, Quote } from "../core/types.js";
import type { ProviderAdapter } from "../providers/ProviderAdapter.js";
import { PLANNED } from "../providers/registry.js";

export function ok(data: unknown, text?: string): CallToolResult {
  return { content: [{ type: "text", text: (text ? text + "\n\n" : "") + JSON.stringify(data, null, 2) }] };
}

export { ToolError };

export function fail(e: unknown): CallToolResult {
  const body =
    e instanceof ToolError
      ? { error: e.code, message: e.message, next_step: e.next_step }
      : { error: "internal_error", message: e instanceof Error ? e.message : String(e) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

/** Wraps a tool handler: uniform errors, and a log line with no arguments or results in it. */
export function handler<A>(ctx: AppContext, tool: string, fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      const res = await fn(args);
      ctx.log.info("tool", { tool, ms: Date.now() - started, ok: true });
      return res;
    } catch (e) {
      ctx.log.warn("tool", { tool, ms: Date.now() - started, ok: false, code: e instanceof ToolError ? e.code : "internal_error" });
      return fail(e);
    }
  };
}

export function requireAdapter(ctx: AppContext, id: ProviderId): ProviderAdapter {
  const a = ctx.registry.get(id);
  if (a) return a;
  const planned = PLANNED.find((p) => p.id === id);
  throw new ToolError("provider_not_available", planned ? `${planned.displayName} is not built yet. ${planned.note}` : `Unknown provider "${id}".`, "Call list_providers to see what can be used right now.");
}

export async function requireConnected(ctx: AppContext, id: ProviderId): Promise<ProviderAdapter> {
  const a = requireAdapter(ctx, id);
  const s = await a.sessionStatus();
  if (s.status !== "connected")
    throw new ToolError(s.status === "expired" ? "session_expired" : "not_connected", `${a.displayName} is ${s.status === "expired" ? "signed out (session expired)" : "not connected"}.`, `Ask the user, then call connect_provider("${id}").`);
  return a;
}

/** Adds ready-to-show dollar strings so the model never has to convert cents. */
export function quoteView(q: Quote) {
  return {
    ...q,
    display: {
      total: q.verified ? fmt(q.total_cents) : `~${fmt(q.total_cents)} (estimate)`,
      label: q.verified ? "verified total" : "ESTIMATE, not a final total",
      subtotal: fmt(q.subtotal_cents),
      fees: fmt(q.delivery_fee_cents + q.service_fee_cents + q.small_order_fee_cents + q.other_fees.reduce((s, f) => s + f.amount_cents, 0)),
      tax: fmt(q.tax_cents),
      discounts: fmt(q.discounts.reduce((s, d) => s + d.amount_cents, 0)),
      tip: q.tip_status === "set" ? fmt(q.tip_cents) : "not set: ask the user",
    },
  };
}
