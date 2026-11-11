import type { Page, Response } from "playwright";
import { ToolError } from "../core/errors.js";

export interface ApiHit {
  name: string;
  at: number;
  request: any;
  /** The `data` field of the site's JSON envelope. */
  data: any;
}

interface Waiter {
  match: (h: ApiHit) => boolean;
  resolve: (h: ApiHit) => void;
}

/**
 * Reads the JSON a site's own page loads, as it loads it. This is how adapters
 * get data: they move the real page (navigate, click) and listen to what the
 * page itself requests. The tap never sends a request of its own.
 */
export class ApiTap {
  private hits: ApiHit[] = [];
  private waiters = new Set<Waiter>();

  constructor(page: Page, private site: string, private pathPrefix: string) {
    page.context().on("response", (res) => void this.onResponse(res));
  }

  private async onResponse(res: Response): Promise<void> {
    let url: URL;
    try {
      url = new URL(res.url());
    } catch {
      return;
    }
    if (!url.pathname.startsWith(this.pathPrefix)) return;
    try {
      const body = await res.json();
      if (res.status() !== 200 || body?.status !== "success") return;
      let request: unknown;
      try {
        request = res.request().postDataJSON();
      } catch {
        request = undefined;
      }
      const hit: ApiHit = { name: url.pathname.slice(this.pathPrefix.length), at: Date.now(), request, data: body.data };
      this.hits.push(hit);
      if (this.hits.length > 150) this.hits.shift();
      for (const w of [...this.waiters]) {
        if (w.match(hit)) {
          this.waiters.delete(w);
          w.resolve(hit);
        }
      }
    } catch {
      // Not JSON, or the body is gone. Nothing to read.
    }
  }

  /** A timestamp to pass as `since`, taken just before the action that triggers the load. */
  mark(): number {
    return Date.now();
  }

  /** The newest matching response at or after `since`, if one has arrived. */
  last(name: RegExp, since: number, where: (h: ApiHit) => boolean = () => true): ApiHit | undefined {
    return [...this.hits].reverse().find((h) => h.at >= since && name.test(h.name) && where(h));
  }

  /** Waits for the page to load a matching response. Fails with a clear, actionable error. */
  wait(name: RegExp, opts: { since: number; what: string; timeoutMs?: number; where?: (h: ApiHit) => boolean }): Promise<ApiHit> {
    const where = opts.where ?? (() => true);
    const have = this.last(name, opts.since, where);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { match: (h) => name.test(h.name) && where(h), resolve: (h) => (clearTimeout(timer), resolve(h)) };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(siteChanged(this.site, `${opts.what} did not load`));
      }, opts.timeoutMs ?? 20000);
      this.waiters.add(waiter);
    });
  }
}

/** The site did something the adapter didn't expect. Says so plainly instead of guessing. */
export function siteChanged(site: string, detail: string): ToolError {
  return new ToolError(
    "site_changed",
    `${site}: ${detail}. Either the page needs attention (a sign-in, verification or pop-up in the browser window), or ${site} changed its site and this adapter needs an update.`,
    "Ask the user to look at the browser window. If nothing there needs them, tell them this app can't be used right now and continue with the others.",
  );
}
