import { fmt } from "../money.js";
import { DEFAULT_WEIGHTS, type ProviderId, type Quote, type RankWeights } from "../types.js";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  ubereats: "Uber Eats",
  doordash: "DoorDash",
  grubhub: "Grubhub",
  postmates: "Postmates",
  mockeats: "MockEats (demo)",
  mockdash: "MockDash (demo)",
};

export interface RankedQuote {
  rank: number;
  quote: Quote;
  score: number;
  reason: string;
  over_budget: boolean;
}

export interface Comparison {
  ranked: RankedQuote[];
  weights: RankWeights;
  recommendation: string;
  warnings: string[];
  table_markdown: string;
}

/** Min-max scale to 0..1 where 0 is best. Missing values score as the worst seen. */
function scaled(values: (number | undefined)[], lowerIsBetter: boolean): number[] {
  const known = values.filter((v): v is number => v != null);
  if (known.length === 0) return values.map(() => 0);
  const min = Math.min(...known);
  const max = Math.max(...known);
  return values.map((v) => {
    if (v == null) return 1;
    if (max === min) return 0;
    const t = (v - min) / (max - min);
    return lowerIsBetter ? t : 1 - t;
  });
}

export function normalizeWeights(w: Partial<RankWeights> | undefined): RankWeights {
  const merged = { ...DEFAULT_WEIGHTS, ...(w ?? {}) };
  const sum = merged.total + merged.eta + merged.rating + merged.fit;
  if (sum <= 0) return DEFAULT_WEIGHTS;
  return { total: merged.total / sum, eta: merged.eta / sum, rating: merged.rating / sum, fit: merged.fit / sum };
}

const money = (q: Quote, cents = q.total_cents) => (q.verified ? fmt(cents) : `~${fmt(cents)} (estimate)`);

export function rankQuotes(quotes: Quote[], opts: { weights?: Partial<RankWeights>; budget_cents?: number } = {}): Comparison {
  const weights = normalizeWeights(opts.weights);
  const warnings: string[] = [];
  if (quotes.length === 0) {
    return { ranked: [], weights, recommendation: "Nothing to compare yet.", warnings, table_markdown: "" };
  }

  const sTotal = scaled(quotes.map((q) => q.total_cents), true);
  const sEta = scaled(quotes.map((q) => q.eta_min), true);
  const sRating = scaled(quotes.map((q) => q.rating), false);
  const sFit = scaled(quotes.map((q) => q.fit), false);

  const scored = quotes.map((quote, i) => ({
    quote,
    score: weights.total * sTotal[i]! + weights.eta * sEta[i]! + weights.rating * sRating[i]! + weights.fit * sFit[i]!,
  }));
  // Ties fall back to the spec's fixed order: total, then ETA, then rating.
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.quote.total_cents - b.quote.total_cents ||
      (a.quote.eta_min ?? 1e9) - (b.quote.eta_min ?? 1e9) ||
      (b.quote.rating ?? 0) - (a.quote.rating ?? 0),
  );

  const cheapest = Math.min(...quotes.map((q) => q.total_cents));
  const fastest = Math.min(...quotes.map((q) => q.eta_min ?? Infinity));
  const topRated = Math.max(...quotes.map((q) => q.rating ?? 0));

  const ranked: RankedQuote[] = scored.map(({ quote: q, score }, i) => {
    const bits: string[] = [];
    if (q.total_cents === cheapest) bits.push("lowest all-in total");
    else bits.push(`${fmt(q.total_cents - cheapest)} more than the cheapest`);
    if (q.eta_min != null && q.eta_min === fastest) bits.push("fastest");
    if (q.rating != null && q.rating === topRated && quotes.length > 1) bits.push(`top rated (${q.rating})`);
    const savings = q.discounts.reduce((s, d) => s + d.amount_cents, 0);
    if (savings > 0) bits.push(`${fmt(savings)} in discounts applied`);
    if (q.fit < 1) bits.push(`only ${Math.round(q.fit * 100)}% of the order is available here`);
    if (!q.verified) bits.push("total is an estimate");
    if (q.tip_status === "needs_user_input") bits.push("tip not included yet");
    if (q.ghost_kitchen?.flagged) bits.push("likely ghost kitchen");
    const over = opts.budget_cents != null && q.total_cents > opts.budget_cents;
    if (over) bits.push(`over budget by ${fmt(q.total_cents - opts.budget_cents!)}`);
    const reason = bits.join("; ");
    return { rank: i + 1, quote: q, score: Number(score.toFixed(3)), reason: reason.charAt(0).toUpperCase() + reason.slice(1) + ".", over_budget: over };
  });

  // Warnings that change how much the comparison can be trusted.
  if (new Set(quotes.map((q) => `${q.tip_status}:${q.tip_cents}`)).size > 1 && new Set(quotes.map((q) => q.tip_status)).size > 1)
    warnings.push("Some quotes include a tip and some don't. Re-quote with the same tip before trusting the ranking.");
  if (quotes.some((q) => q.tip_status === "needs_user_input"))
    warnings.push("Tip has not been set by the user. Totals shown are before tip. Ask the user what tip they want, then re-quote.");
  if (quotes.some((q) => !q.verified)) warnings.push("At least one total is an estimate, not a verified checkout total. It is labeled.");
  if (new Set(quotes.map((q) => q.match_group ?? q.restaurant_id)).size > 1)
    warnings.push("These quotes are from different restaurants, so this is not a same-order price comparison.");
  if (quotes.some((q) => q.fit < 1)) warnings.push("Not every app has the full order. Compare totals with that in mind.");
  if (opts.budget_cents != null && ranked.every((r) => r.over_budget)) warnings.push(`Every option is over the ${fmt(opts.budget_cents)} budget.`);

  const best = ranked[0]!;
  const next = ranked[1];
  const b = best.quote;
  const items = b.restaurant_name;
  let rec = `Order from ${items} on ${PROVIDER_NAMES[b.provider]}: ${money(b)} all-in${b.tip_status === "needs_user_input" ? " before tip" : ""}${b.eta_min != null ? `, ~${b.eta_min} min` : ""}.`;
  if (next) {
    const diff = next.quote.total_cents - b.total_cents;
    const approx = b.verified && next.quote.verified ? "" : "about ";
    if (diff > 0) rec += ` That's ${approx}${fmt(diff)} cheaper than the next best (${PROVIDER_NAMES[next.quote.provider]}).`;
    else if (diff < 0) rec += ` It costs ${approx}${fmt(-diff)} more than ${PROVIDER_NAMES[next.quote.provider]}, but ranks higher on your other priorities (${best.reason.toLowerCase().replace(/\.$/, "")}).`;
    else rec += ` Same price as ${PROVIDER_NAMES[next.quote.provider]}.`;
  }
  if (b.ghost_kitchen?.flagged) rec += ` Note: this looks like a ghost kitchen (${b.ghost_kitchen.reasons[0]})`;

  return { ranked, weights, recommendation: rec, warnings, table_markdown: renderTable(ranked) };
}

export function renderTable(ranked: RankedQuote[]): string {
  const head = "| # | App | Restaurant | Subtotal | Fees | Tax | Discounts | Tip | **All-in total** | ETA | Rating | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = ranked.map(({ rank, quote: q, reason }) => {
    const fees = q.delivery_fee_cents + q.service_fee_cents + q.small_order_fee_cents + q.other_fees.reduce((s, f) => s + f.amount_cents, 0);
    const disc = q.discounts.reduce((s, d) => s + d.amount_cents, 0);
    const name = q.restaurant_name + (q.ghost_kitchen?.flagged ? " 👻" : "");
    return `| ${rank} | ${PROVIDER_NAMES[q.provider]} | ${name} | ${fmt(q.subtotal_cents)} | ${fmt(fees)} | ${fmt(q.tax_cents)} | ${disc ? "-" + fmt(disc) : "—"} | ${q.tip_status === "set" ? fmt(q.tip_cents) : "not set"} | **${money(q)}** | ${q.eta_min != null ? `~${q.eta_min} min` : "?"} | ${q.rating ?? "?"} | ${reason} |`;
  });
  const legend = ranked.some((r) => r.quote.ghost_kitchen?.flagged) ? "\n\n👻 = likely ghost kitchen / virtual brand" : "";
  return [head, ...rows].join("\n") + legend;
}
