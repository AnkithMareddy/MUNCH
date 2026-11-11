import type { TipInput } from "./types.js";

export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Percent of an amount, rounded half-up to a whole cent. */
export function pct(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}

export function tipCents(subtotalCents: number, tip: TipInput): number {
  return tip.type === "percent" ? pct(subtotalCents, tip.value) : tip.cents;
}

export function describeTip(tip: TipInput): string {
  return tip.type === "percent" ? `${tip.value}% of subtotal` : `${fmt(tip.cents)} flat`;
}
