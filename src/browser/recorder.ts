import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Response } from "playwright";
import { scrubAll, shape } from "./scrub.js";

export interface Capture {
  step: string;
  endpoint: string;
  method: string;
  status: number;
  request?: unknown;
  response: unknown;
}

export interface StepSnapshot {
  step: string;
  /** URL with ids replaced, no query string. */
  url_pattern: string;
  title: string;
  /** data-testid values on the page: the stable hooks an adapter can use. */
  test_ids: string[];
  /** Text of elements that look like price or fee rows. Scrubbed before saving. */
  price_rows: string[];
  buttons: string[];
}

const urlPattern = (url: string) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":uuid").replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/:id");
  } catch {
    return "(unknown)";
  }
};

/**
 * Listens to the JSON a delivery site's own page loads while the user clicks
 * around, and writes two things: raw captures (private, stay on this machine)
 * and scrubbed fixtures plus a structure report (safe to review and share).
 * It only listens. It never clicks, types, or sends requests of its own.
 */
export class Recorder {
  private captures: Capture[] = [];
  private snapshots: StepSnapshot[] = [];
  private step = "start";
  private pending = new Set<Promise<void>>();

  constructor(private context: BrowserContext, private apiPattern: RegExp) {
    context.on("response", (res) => {
      const p = this.onResponse(res).finally(() => this.pending.delete(p));
      this.pending.add(p);
    });
  }

  setStep(step: string): void {
    this.step = step;
  }

  /** Waits for response bodies still being read. */
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
    try {
      const response = await res.json();
      let request: unknown;
      try {
        request = res.request().postDataJSON();
      } catch {
        request = undefined;
      }
      // Headers and cookies are never recorded.
      this.captures.push({ step: this.step, endpoint: new URL(url).pathname, method: res.request().method(), status: res.status(), request, response });
    } catch {
      // Body unavailable (redirect, aborted): nothing to record.
    }
  }

  /** Records what the current page looks like structurally. */
  async snapshot(page: Page): Promise<void> {
    const dom = await page
      .evaluate(() => {
        const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        const ids = [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")!))].slice(0, 400);
        const rows = [...document.querySelectorAll("li, tr, div, span")]
          .filter((e) => e.children.length <= 4)
          .map(text)
          .filter((t) => /\$\s?\d/.test(t) && /fee|tax|total|subtotal|tip|delivery|service|promo|discount|small order/i.test(t) && t.length < 120);
        const buttons = [...new Set([...document.querySelectorAll("button, a[role=button], [role=button]")].map(text).filter((t) => t && t.length < 40 && !/\d/.test(t)))].slice(0, 80); // no digits: keeps addresses out
        return { title: document.title, ids, rows: [...new Set(rows)].slice(0, 60), buttons };
      })
      .catch(() => ({ title: "", ids: [] as string[], rows: [] as string[], buttons: [] as string[] }));
    this.snapshots.push({ step: this.step, url_pattern: urlPattern(page.url()), title: dom.title, test_ids: dom.ids, price_rows: dom.rows, buttons: dom.buttons });
  }

  async cookieNames(urls: string[]): Promise<string[]> {
    return [...new Set((await this.context.cookies(urls)).map((c) => c.name))].sort();
  }

  /** Writes everything to `dir`. Returns the path of the report. */
  async save(dir: string, meta: Record<string, unknown>): Promise<string> {
    await this.settle();
    const rawDir = join(dir, "raw-PRIVATE-do-not-share");
    const cleanDir = join(dir, "scrubbed");
    await mkdir(rawDir, { recursive: true, mode: 0o700 });
    await mkdir(cleanDir, { recursive: true, mode: 0o700 });

    // Scrub captures and page snapshots together, so a name found in one is removed from all.
    const [cleanCaptures, cleanSnapshots] = scrubAll([this.captures, this.snapshots] as unknown[]) as [Capture[], StepSnapshot[]];

    const seen = new Map<string, number>();
    const index: string[] = [];
    for (let i = 0; i < this.captures.length; i++) {
      const c = this.captures[i]!;
      const base = `${c.step}__${c.endpoint.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const file = `${base}${n > 1 ? `__${n}` : ""}.json`;
      await writeFile(join(rawDir, file), JSON.stringify(c, null, 2), { mode: 0o600 });
      await writeFile(join(cleanDir, file), JSON.stringify(cleanCaptures[i], null, 2), { mode: 0o600 });
      index.push(file);
    }
    await writeFile(join(cleanDir, "_pages.json"), JSON.stringify(cleanSnapshots, null, 2), { mode: 0o600 });

    // The report has structure only: endpoint names, key names and types, page hooks. No values from responses.
    // Shapes come from the untouched captures so field names under redacted sections still show.
    // shape() emits key names and types only, never a value.
    const byEndpoint = new Map<string, Capture[]>();
    for (const c of this.captures) byEndpoint.set(`${c.method} ${c.endpoint}`, [...(byEndpoint.get(`${c.method} ${c.endpoint}`) ?? []), c]);
    const lines: string[] = ["# Recording report", "", "Endpoint names, field names and types, button labels, fee-row text and page hooks. No response values. Skim it for anything personal before sharing.", "", "```json", JSON.stringify(meta, null, 2), "```", "", "## Pages"];
    for (const s of cleanSnapshots) {
      lines.push("", `### Step: ${s.step}`, `- URL: \`${s.url_pattern}\``, `- Buttons: ${s.buttons.map((b) => `\`${b}\``).join(", ") || "(none)"}`, `- Price rows: ${s.price_rows.map((b) => `\`${b}\``).join(" | ") || "(none)"}`, `- data-testid (${s.test_ids.length}): ${s.test_ids.map((t) => `\`${t}\``).join(", ") || "(none)"}`);
    }
    lines.push("", "## Endpoints");
    for (const [key, list] of byEndpoint) {
      const steps = [...new Set(list.map((c) => c.step))].join(", ");
      const biggest = list.reduce((a, b) => (JSON.stringify(b.response).length > JSON.stringify(a.response).length ? b : a));
      lines.push("", `### ${key}`, `- Seen ${list.length}× during: ${steps}. Status: ${[...new Set(list.map((c) => c.status))].join(", ")}`, "", "Request shape:", "```json", JSON.stringify(shape(biggest.request ?? null, 5), null, 1), "```", "Response shape:", "```json", JSON.stringify(shape(biggest.response), null, 1), "```");
    }
    const report = join(dir, "report.md");
    await writeFile(report, lines.join("\n"), { mode: 0o600 });
    return report;
  }
}
