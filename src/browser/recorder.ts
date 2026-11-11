import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Response } from "playwright";
import { scrubAll, shape } from "./scrub.js";

export interface Capture {
  step: string;
  /** Pattern of the page that made the call, e.g. https://site/store/:slug/:id */
  page: string;
  endpoint: string;
  method: string;
  status: number;
  request?: unknown;
  response: unknown;
}

export interface PageSnapshot {
  step: string;
  /** URL with ids replaced and query values removed. */
  url_pattern: string;
  title: string;
  /** data-testid values on the page: the stable hooks an adapter can use. */
  test_ids: string[];
  /** Text of elements that look like price or fee rows. */
  price_rows: string[];
  buttons: string[];
  inputs: string[];
}

/** Which parts of which responses may be shown with example values in the report. */
export interface SampleSpec {
  endpoint: RegExp;
  part: "request" | "response";
  /** Dotted paths of subtrees to include. Omit for the whole body. */
  paths?: string[];
}

export interface ReportOptions {
  samples?: SampleSpec[];
  /** Keys left out of samples: bulky or irrelevant (images, tracking, SEO text). */
  dropKeys?: RegExp;
}

export function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":uuid")
      .replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/:id")
      .replace(/\/store\/[^/]+/, "/store/:slug");
    const query = [...new Set([...u.searchParams.keys()])].map((k) => `${k}=…`).join("&");
    return u.origin + path + (query ? `?${query}` : "");
  } catch {
    return "(unknown)";
  }
}

// Passed to the page as a string. A compiled function can pick up build-tool helpers
// that don't exist inside the page, which makes the whole snapshot fail silently.
const SNAPSHOT_SCRIPT = `(() => {
  const text = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160);
  const uniq = (a) => [...new Set(a)];
  const ids = uniq([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid"))).slice(0, 500);
  const rows = uniq([...document.querySelectorAll("li, tr, div, span")].filter((e) => e.children.length <= 4).map(text)
    .filter((t) => /\\$\\s?\\d/.test(t) && /fee|tax|total|subtotal|tip|delivery|service|promo|discount|small order/i.test(t) && t.length < 120)).slice(0, 60);
  const buttons = uniq([...document.querySelectorAll("button, a[role=button], [role=button]")].map((e) => {
    const t = text(e); const id = e.getAttribute("data-testid"); const aria = e.getAttribute("aria-label");
    return [t && t.length < 40 && !/\\d/.test(t) ? t : "", id ? "testid=" + id : "", aria && aria.length < 40 && !/\\d/.test(aria) ? "aria=" + aria : ""].filter(Boolean).join(" | ");
  }).filter(Boolean)).slice(0, 120);
  const inputs = uniq([...document.querySelectorAll("input, textarea, select")].map((e) =>
    [e.tagName.toLowerCase(), e.getAttribute("type"), e.getAttribute("name") && "name=" + e.getAttribute("name"), e.getAttribute("data-testid") && "testid=" + e.getAttribute("data-testid"), e.getAttribute("placeholder") && "placeholder=" + e.getAttribute("placeholder"), e.getAttribute("role") && "role=" + e.getAttribute("role")].filter(Boolean).join(" "))).slice(0, 60);
  return { title: document.title, ids, rows, buttons, inputs };
})()`;

/**
 * Listens to the JSON a delivery site's own page loads while the user clicks
 * around, and writes raw captures (private, stay on this machine), scrubbed
 * fixtures, and a report that is safe to review and share.
 * It only listens. It never clicks, types, or sends requests of its own.
 */
export class Recorder {
  private captures: Capture[] = [];
  private snapshots = new Map<string, PageSnapshot>();
  private step = "start";
  private pending = new Set<Promise<void>>();
  private timers = new Map<Page, NodeJS.Timeout>();

  constructor(private context: BrowserContext, private apiPattern: RegExp, private settleMs = 2500) {
    context.on("response", (res) => this.track(this.onResponse(res)));
    context.on("page", (page) => this.watchPage(page));
    for (const page of context.pages()) this.watchPage(page);
  }

  private track(p: Promise<void>): void {
    const wrapped = p.catch(() => undefined).finally(() => this.pending.delete(wrapped));
    this.pending.add(wrapped);
  }

  /** Every time the page's address changes, let it settle and note what the page looks like. */
  private watchPage(page: Page): void {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      clearTimeout(this.timers.get(page));
      this.timers.set(page, setTimeout(() => this.track(this.snapshot(page)), this.settleMs));
    });
  }

  setStep(step: string): void {
    this.step = step;
  }

  /** Waits for response bodies and snapshots still in progress. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  get count(): number {
    return this.captures.length;
  }

  private async onResponse(res: Response): Promise<void> {
    const url = res.url();
    if (!this.apiPattern.test(url)) return;
    if (!(res.headers()["content-type"] ?? "").includes("json")) return;
    const step = this.step;
    let page = "(unknown)";
    try {
      page = urlPattern(res.frame().page().url());
    } catch {
      // Requests from workers have no page.
    }
    const response = await res.json();
    let request: unknown;
    try {
      request = res.request().postDataJSON();
    } catch {
      request = undefined;
    }
    // Headers and cookies are never recorded.
    this.captures.push({ step, page, endpoint: new URL(url).pathname, method: res.request().method(), status: res.status(), request, response });
  }

  /** Records what a page looks like structurally. One entry per kind of page; the latest wins. */
  async snapshot(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const url_pattern = urlPattern(page.url());
    const dom = (await page.evaluate(SNAPSHOT_SCRIPT).catch((e) => ({ title: `(snapshot failed: ${String(e).slice(0, 80)})`, ids: [], rows: [], buttons: [], inputs: [] }))) as {
      title: string;
      ids: string[];
      rows: string[];
      buttons: string[];
      inputs: string[];
    };
    this.snapshots.set(url_pattern, { step: this.step, url_pattern, title: dom.title, test_ids: dom.ids, price_rows: dom.rows, buttons: dom.buttons, inputs: dom.inputs });
  }

  async cookieNames(urls: string[]): Promise<string[]> {
    return [...new Set((await this.context.cookies(urls)).map((c) => c.name))].sort();
  }

  /** Writes everything to `dir`. Returns the path of the report. */
  async save(dir: string, meta: Record<string, unknown>, opts: ReportOptions = {}): Promise<string> {
    for (const t of this.timers.values()) clearTimeout(t);
    await this.settle();
    return writeRecording(dir, this.captures, [...this.snapshots.values()], meta, opts);
  }
}

/** Reads back the untouched captures of an earlier recording, to rebuild its report. */
export async function loadRecording(dir: string): Promise<{ captures: Capture[]; snapshots: PageSnapshot[] }> {
  const rawDir = join(dir, "raw-PRIVATE-do-not-share");
  const files = (await readdir(rawDir)).filter((f) => f.endsWith(".json")).sort();
  const captures = await Promise.all(files.map(async (f) => ({ page: "(unknown)", ...JSON.parse(await readFile(join(rawDir, f), "utf8")) }) as Capture));
  const snapshots = await readFile(join(dir, "scrubbed", "_pages.json"), "utf8").then((s) => JSON.parse(s) as PageSnapshot[], () => []);
  return { captures, snapshots };
}

function pick(value: unknown, path: string[]): unknown {
  if (path.length === 0) return value;
  if (value === null || typeof value !== "object") return undefined;
  return pick((value as Record<string, unknown>)[path[0]!], path.slice(1));
}

/** Cuts a value down to something readable: a few array elements, short strings, no dropped keys. */
export function prune(value: unknown, dropKeys: RegExp | undefined, depth = 14): unknown {
  if (typeof value === "string") return value.length > 140 ? value.slice(0, 140) + "…" : value;
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0) return "…";
  if (Array.isArray(value)) {
    const head = value.slice(0, 2).map((v) => prune(v, dropKeys, depth - 1));
    return value.length > 2 ? [...head, `…(${value.length} total)`] : head;
  }
  const entries = Object.entries(value).filter(([k]) => !dropKeys?.test(k));
  // Maps keyed by an id: a few entries are enough.
  const idKeyed = entries.length > 3 && entries.every(([k]) => /[0-9a-f]{8}-[0-9a-f]{4}-|^\d+$/.test(k));
  const kept = (idKeyed ? entries.slice(0, 3) : entries).map(([k, v]) => [k, prune(v, dropKeys, depth - 1)] as const);
  if (idKeyed) kept.push([`…(${entries.length} keys total)`, ""]);
  return Object.fromEntries(kept);
}

export async function writeRecording(dir: string, captures: Capture[], snapshots: PageSnapshot[], meta: Record<string, unknown>, opts: ReportOptions = {}): Promise<string> {
  const rawDir = join(dir, "raw-PRIVATE-do-not-share");
  const cleanDir = join(dir, "scrubbed");
  await mkdir(rawDir, { recursive: true, mode: 0o700 });
  await mkdir(cleanDir, { recursive: true, mode: 0o700 });

  // Scrub captures and page snapshots together, so a name found in one is removed from all.
  const [cleanCaptures, cleanSnapshots] = scrubAll([captures, snapshots] as unknown[]) as [Capture[], PageSnapshot[]];

  const seen = new Map<string, number>();
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i]!;
    const base = `${c.step}__${c.endpoint.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const file = `${base}${n > 1 ? `__${String(n).padStart(2, "0")}` : ""}.json`;
    await writeFile(join(rawDir, file), JSON.stringify(c, null, 2), { mode: 0o600 });
    await writeFile(join(cleanDir, file), JSON.stringify(cleanCaptures[i], null, 2), { mode: 0o600 });
  }
  await writeFile(join(cleanDir, "_pages.json"), JSON.stringify(cleanSnapshots, null, 2), { mode: 0o600 });

  const L: string[] = [
    "# Recording report",
    "",
    "What is in here: endpoint names, field names and types, page hooks, button labels, fee-row text, and a few example values from restaurant, menu and fee data (personal data scrubbed). Skim it for anything personal before sharing.",
    "",
    "```json",
    JSON.stringify(meta, null, 2),
    "```",
    "",
    "## Pages",
  ];
  const list = (xs: string[]) => xs.map((b) => `\`${b}\``).join(", ") || "(none)";
  for (const s of cleanSnapshots) {
    L.push("", `### ${s.url_pattern}`, `- Seen during: ${s.step}. Title: ${s.title}`, `- Inputs: ${list(s.inputs ?? [])}`, `- Buttons: ${list(s.buttons)}`, `- Price rows: ${s.price_rows.map((b) => `\`${b}\``).join(" | ") || "(none)"}`, `- data-testid (${s.test_ids.length}): ${list(s.test_ids)}`);
  }

  const key = (c: Capture) => `${c.method} ${c.endpoint}`;
  const groups = new Map<string, number[]>();
  captures.forEach((c, i) => groups.set(key(c), [...(groups.get(key(c)) ?? []), i]));

  L.push("", "## Endpoint summary", "", "| Endpoint | Count | Called from pages |", "|---|---|---|");
  for (const [k, idx] of groups) L.push(`| ${k} | ${idx.length} | ${[...new Set(idx.map((i) => captures[i]!.page))].join("<br>")} |`);

  L.push("", "## Endpoints");
  for (const [k, idx] of groups) {
    const size = (i: number) => JSON.stringify(captures[i]!.response).length;
    const big = idx.reduce((a, b) => (size(b) > size(a) ? b : a));
    // Shapes come from the untouched capture so field names under redacted sections still show.
    // shape() emits key names and types only, never a value.
    L.push("", `### ${k}`, `- Seen ${idx.length}×. Status: ${[...new Set(idx.map((i) => captures[i]!.status))].join(", ")}. Steps: ${[...new Set(idx.map((i) => captures[i]!.step))].join(", ")}`);
    const specs = (opts.samples ?? []).filter((s) => s.endpoint.test(captures[big]!.endpoint));
    const depth = specs.length ? 12 : 5;
    L.push("", "Request shape:", "```json", JSON.stringify(shape(captures[big]!.request ?? null, depth), null, 1), "```", "Response shape:", "```json", JSON.stringify(shape(captures[big]!.response, depth), null, 1), "```");
    for (const spec of specs) {
      // Example values come from the scrubbed copy only, and only from the allowed parts.
      const body = cleanCaptures[big]![spec.part];
      const parts = spec.paths ? Object.fromEntries(spec.paths.map((p) => [p, pick(body, p.split("."))]).filter(([, v]) => v !== undefined)) : body;
      L.push(`Example ${spec.part} (scrubbed, shortened):`, "```json", JSON.stringify(prune(parts, opts.dropKeys), null, 1), "```");
    }
  }
  const report = join(dir, "report.md");
  await writeFile(report, L.join("\n"), { mode: 0o600 });
  return report;
}
