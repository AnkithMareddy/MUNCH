import { normalize, similarity } from "../text.js";
import type { Restaurant } from "../types.js";

const NOISE = new Set(["the", "restaurant", "kitchen", "delivery", "pickup", "and", "co", "inc"]);

/** "Luigi's Pizzeria - Court St (Delivery)" → "luigis pizzeria" */
export function normalizeRestaurantName(name: string): string {
  const head = name.replace(/\(.*?\)/g, " ").split(/\s[-–—|@]\s/)[0] ?? name;
  return normalize(head)
    .split(" ")
    .filter((t) => t && !NOISE.has(t))
    .join(" ");
}

const STREET_ABBR: Record<string, string> = {
  street: "st", avenue: "ave", boulevard: "blvd", road: "rd", drive: "dr", place: "pl", lane: "ln", way: "way",
  north: "n", south: "s", east: "e", west: "w", suite: "ste",
};

/** Street number + street name only, abbreviations unified. Unit numbers and city are dropped. */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return "";
  const street = (address.split(",")[0] ?? "").replace(/\b(ste|suite|unit|apt|#)\s*\w+$/i, "");
  return normalize(street)
    .split(" ")
    .map((t) => STREET_ABBR[t] ?? t)
    .join(" ");
}

export function distanceMeters(a: { lat?: number; lng?: number }, b: { lat?: number; lng?: number }): number | undefined {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return undefined;
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 0..1 confidence that two listings are the same physical restaurant. */
export function sameRestaurantConfidence(a: Restaurant, b: Restaurant): number {
  const nameSim = similarity(normalizeRestaurantName(a.name), normalizeRestaurantName(b.name));
  if (nameSim < 0.6) return 0;
  const addrA = normalizeAddress(a.address);
  const addrB = normalizeAddress(b.address);
  const sameAddr = addrA !== "" && addrA === addrB;
  const dist = distanceMeters(a, b);
  const phoneMatch = !!a.phone && !!b.phone && a.phone.replace(/\D/g, "") === b.phone.replace(/\D/g, "");
  const near = dist != null && dist <= 150;
  // A name alone is never enough: chains have many branches.
  if (!sameAddr && !near && !phoneMatch) return 0;
  if (dist != null && dist > 400 && !phoneMatch) return 0;
  let conf = nameSim * 0.7;
  if (sameAddr) conf += 0.2;
  if (near) conf += 0.1;
  if (phoneMatch) conf += 0.1;
  return Math.min(1, Number(conf.toFixed(2)));
}

export const MATCH_THRESHOLD = 0.6;

/**
 * Groups listings of the same restaurant across apps. Returns the input with
 * match_group and match_confidence set. Listings on the same app are never merged.
 */
export function assignMatchGroups(restaurants: Restaurant[]): Restaurant[] {
  const parent = restaurants.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const conf = restaurants.map(() => 1);

  for (let i = 0; i < restaurants.length; i++) {
    for (let j = i + 1; j < restaurants.length; j++) {
      const a = restaurants[i]!;
      const b = restaurants[j]!;
      if (a.provider === b.provider) continue;
      const c = sameRestaurantConfidence(a, b);
      if (c >= MATCH_THRESHOLD) {
        parent[find(j)] = find(i);
        conf[i] = Math.min(conf[i]!, c);
        conf[j] = Math.min(conf[j]!, c);
      }
    }
  }
  return restaurants.map((r, i) => {
    const root = restaurants[find(i)]!;
    return { ...r, match_group: `m_${normalizeRestaurantName(root.name).replace(/ /g, "_")}_${normalizeAddress(root.address).replace(/ /g, "_") || find(i)}`, match_confidence: conf[i] };
  });
}
