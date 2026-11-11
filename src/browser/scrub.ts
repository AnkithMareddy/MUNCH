/**
 * Removes personal data from captured site responses, so a recording can be
 * used as a test fixture or shared. Restaurant names, menus and prices are
 * public and are kept. Anything about the signed-in person is not.
 */
const PERSONAL_KEY =
  /^(first|last|full|display|given|family)?_?name$|email|phone|mobile|password|token|jwt|csrf|cookie|session|secret|signature|authorization|address|street|apt|suite|zip|postal|birth|card|payment|billing|wallet|credit|avatar|picture|photo|^(user|eater|customer|client|consumer|rider|account|person|profile|device|tenancy)(_?(uu)?id)?$|(user|eater|customer|consumer|rider|account|device)_?(uu)?id$|instructions|^note(s)?$|referral|invite|^ip$/i;
/** Under these, "name" and "address" belong to a restaurant, which is public. */
const PUBLIC_CONTEXT = /store|restaurant|merchant|vendor|item|menu|catalog|section|category|product|brand|cuisine|option|modifier|customization|feed|carousel|promo|badge|fee|fare|charge/i;
/** Under these, coordinates point at the user. */
const PERSONAL_CONTEXT = /deliver|eater|user|customer|consumer|dropoff|drop_off|target|destination|current|home|work|profile|account|saved|recent|shipping|billing/i;
const COORD_KEY = /^(lat|lng|lon|long|latitude|longitude)$/i;
const NAMEISH = /^(title|subtitle|label|text|name|address|street|formatted_?address|address1|address_?line_?\d?)$/i;

const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[jwt]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
];

export interface ScrubResult {
  value: unknown;
  /** Personal strings that were found, so they can be removed elsewhere too. Never written to disk. */
  found: Set<string>;
}

function collect(value: unknown, found: Set<string>): void {
  if (typeof value === "string" && value.trim().length >= 4) found.add(value.trim());
  else if (Array.isArray(value)) value.forEach((v) => collect(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collect(v, found));
}

function walk(value: unknown, path: string[], found: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, path, found));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const context = path.join(".");
    const personalHere = PERSONAL_CONTEXT.test(context) && !PUBLIC_CONTEXT.test(path[path.length - 1] ?? "");
    for (const [k, v] of Object.entries(value)) {
      const publicHere = PUBLIC_CONTEXT.test(context) && !personalHere;
      const personalKey = PERSONAL_KEY.test(k) && !(publicHere && NAMEISH.test(k));
      const personalCoord = COORD_KEY.test(k) && personalHere;
      const personalText = personalHere && NAMEISH.test(k);
      if (personalKey || personalCoord || personalText) {
        collect(v, found);
        out[k] = "[redacted]";
      } else {
        out[k] = walk(v, [...path, k], found);
      }
    }
    return out;
  }
  if (typeof value === "string") return PATTERNS.reduce((s, [re, rep]) => s.replace(re, rep), value);
  return value;
}

function replaceKnown(value: unknown, known: string[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const k of known) if (s.includes(k)) s = s.split(k).join("[redacted]");
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => replaceKnown(v, known));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceKnown(v, known)]));
  return value;
}

/** First pass: redact by key, context and pattern, and remember what the personal values were. */
export function scrub(value: unknown, found = new Set<string>()): ScrubResult {
  return { value: walk(value, [], found), found };
}

/** Second pass: the same personal values often reappear in free text ("Deliver to Jane at 5 Elm St"). */
export function scrubKnown(value: unknown, found: Set<string>): unknown {
  return replaceKnown(value, [...found].sort((a, b) => b.length - a.length));
}

/** Scrubs a batch together so a value found in one response is removed from all of them. */
export function scrubAll<T>(docs: T[]): T[] {
  const found = new Set<string>();
  const first = docs.map((d) => scrub(d, found).value);
  return first.map((d) => scrubKnown(d, found)) as T[];
}

/** The structure of a JSON value with no values in it: safe to share, enough to write a parser from. */
export function shape(value: unknown, depth = 7): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : depth <= 0 ? "[…]" : [shape(mergeSample(value), depth - 1), `×${value.length}`];
  if (typeof value === "object") {
    if (depth <= 0) return "{…}";
    // Some maps are keyed by an id or an email. Those keys are data, so they are masked too.
    const safeKey = (k: string) => (/[0-9a-f]{8}-[0-9a-f]{4}-|@|^\d{5,}$|^[A-Za-z0-9_-]{24,}$/.test(k) ? ":id" : k);
    return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [safeKey(k), shape(v, depth - 1)]));
  }
  return typeof value;
}

/** Arrays of objects often have optional keys; merge a few elements so the shape shows all of them. */
function mergeSample(arr: unknown[]): unknown {
  const objs = arr.slice(0, 8).filter((v) => v && typeof v === "object" && !Array.isArray(v)) as Record<string, unknown>[];
  if (objs.length === 0) return arr[0];
  const out: Record<string, unknown> = {};
  for (const o of objs) for (const [k, v] of Object.entries(o)) if (out[k] === undefined || out[k] === null) out[k] = v;
  return out;
}
