import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, similarity } from "../text.js";
import type { GhostKitchenFlag, Restaurant } from "../types.js";
import { normalizeAddress, normalizeRestaurantName } from "./matching.js";

export interface VirtualBrand {
  name: string;
  operator: string;
}

/** Reads data/virtual-brands.json, looking upward from this file so it works from src/ and from the built dist/. */
export function loadVirtualBrands(): VirtualBrand[] {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const file = join(dir, "data", "virtual-brands.json");
    if (existsSync(file)) {
      try {
        return (JSON.parse(readFileSync(file, "utf8")) as { brands: VirtualBrand[] }).brands;
      } catch {
        return [];
      }
    }
    dir = dirname(dir);
  }
  return [];
}

const NAME_PATTERNS: [RegExp, string][] = [
  [/\bdelivery[- ]only\b/i, 'listing says "delivery only"'],
  [/\bvirtual (brand|kitchen|restaurant)\b/i, "listing describes itself as a virtual brand"],
  [/\bghost kitchen\b/i, 'listing mentions "ghost kitchen"'],
  [/\b(cloud|dark) kitchen\b/i, "listing mentions a cloud/dark kitchen"],
];

/** How many different brands at one street address before we call it a shared kitchen. */
export const ADDRESS_BRAND_THRESHOLD = 3;

/**
 * Flags likely ghost kitchens / virtual brands and says why.
 *
 * `context` should include every nearby listing we know about, not only the ones
 * being shown, so the shared-address check sees all the brands at an address.
 * These are heuristics: a flag means "likely", and the reasons are always shown.
 */
export function detectGhostKitchens(
  targets: Restaurant[],
  context: Restaurant[] = targets,
  brands: VirtualBrand[] = loadVirtualBrands(),
): Map<string, GhostKitchenFlag> {
  const brandsAtAddress = new Map<string, Map<string, string>>();
  for (const r of [...context, ...targets]) {
    const addr = normalizeAddress(r.address);
    if (!addr) continue;
    const key = normalizeRestaurantName(r.name);
    if (!brandsAtAddress.has(addr)) brandsAtAddress.set(addr, new Map());
    const names = brandsAtAddress.get(addr)!;
    // The same restaurant listed on two apps with slightly different names is one brand.
    const dup = [...names.keys()].some((k) => similarity(k, key) >= 0.8);
    if (!dup) names.set(key, r.name);
  }

  const out = new Map<string, GhostKitchenFlag>();
  for (const r of targets) {
    const reasons: string[] = [];
    let confidence = 0;

    const known = brands.find((b) => similarity(normalizeRestaurantName(b.name), normalizeRestaurantName(r.name)) >= 0.85);
    if (known) {
      reasons.push(`"${known.name}" is a known virtual brand, usually cooked by ${known.operator}.`);
      confidence = Math.max(confidence, 0.9);
    }

    if (r.provider_says_virtual) {
      reasons.push("The app itself labels this as a virtual / delivery-only store.");
      confidence = Math.max(confidence, 0.95);
    }

    const here = brandsAtAddress.get(normalizeAddress(r.address));
    if (here && here.size >= ADDRESS_BRAND_THRESHOLD) {
      const self = normalizeRestaurantName(r.name);
      const others = [...here.entries()].filter(([k]) => similarity(k, self) < 0.8).map(([, v]) => v);
      reasons.push(`${here.size} different brands deliver from the same address (${r.address?.split(",")[0]}): also ${others.slice(0, 4).join(", ")}.`);
      confidence = Math.max(confidence, here.size >= 4 ? 0.8 : 0.7);
    }

    const text = `${r.name} ${r.description ?? ""}`;
    for (const [re, why] of NAME_PATTERNS) {
      if (re.test(text)) {
        reasons.push(`The ${why}.`);
        confidence = Math.max(confidence, 0.75);
      }
    }

    if (reasons.length > 1) confidence = Math.min(0.98, confidence + 0.05 * (reasons.length - 1));
    out.set(r.id, { flagged: reasons.length > 0, confidence: Number(confidence.toFixed(2)), reasons });
  }
  return out;
}

export { normalize };
