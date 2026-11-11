/** Text normalization and fuzzy similarity shared by cart mapping and restaurant matching. */

export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  // Bigrams stay inside words, so word order and word boundaries don't create false overlap.
  for (const t of s.split(" ")) {
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
  }
  return m;
}

/** Sørensen–Dice on character bigrams. Tolerates typos and spelling variants ("phad" / "pad"). */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let sizeA = 0;
  let sizeB = 0;
  let overlap = 0;
  for (const n of A.values()) sizeA += n;
  for (const [g, n] of B) {
    sizeB += n;
    overlap += Math.min(n, A.get(g) ?? 0);
  }
  return sizeA + sizeB === 0 ? 0 : (2 * overlap) / (sizeA + sizeB);
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Word-level similarity that forgives a typo or spelling variant ("pad" / "phad"), but not a different word. */
function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  const s = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return s >= 0.7 ? s : 0;
}

/** How much of the shorter name's words appear in the longer one. Handles "pad thai" inside "phad thai noodles". */
export function tokenContainment(a: string, b: string): number {
  const ta = [...new Set(a.split(" ").filter(Boolean))];
  const tb = [...new Set(b.split(" ").filter(Boolean))];
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (small.length === 0) return 0;
  let hit = 0;
  for (const t of small) hit += Math.max(...large.map((u) => wordSim(t, u)));
  return hit / small.length;
}

/** 0..1 similarity of two free-text names. */
export function similarity(rawA: string, rawB: string): number {
  const a = normalize(rawA);
  const b = normalize(rawB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const d = dice(a, b);
  // Containment alone over-matches short names ("pizza" vs "pepperoni pizza"), so cap its pull.
  const c = tokenContainment(a, b) * 0.9;
  return Math.max(d, 0.5 * d + 0.5 * c);
}
