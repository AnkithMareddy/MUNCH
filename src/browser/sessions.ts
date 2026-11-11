import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";

/**
 * One real, visible browser per delivery app, each with its own profile folder
 * on this machine. The profile is what keeps the user signed in between runs;
 * Chrome encrypts its cookie values with the OS keychain.
 *
 * Deliberately plain: no stealth plugins, no fingerprint changes, no CAPTCHA
 * handling. If a site shows a verification step, the user handles it in the window.
 */
export class BrowserSessions {
  private contexts = new Map<string, Promise<BrowserContext>>();

  constructor(private profilesDir: string, private opts: { headless?: boolean; channel?: string } = {}) {}

  profileDir(provider: string): string {
    return join(this.profilesDir, provider);
  }

  hasProfile(provider: string): boolean {
    return existsSync(this.profileDir(provider));
  }

  isOpen(provider: string): boolean {
    return this.contexts.has(provider);
  }

  context(provider: string): Promise<BrowserContext> {
    let ctx = this.contexts.get(provider);
    if (!ctx) {
      ctx = this.launch(provider);
      this.contexts.set(provider, ctx);
      ctx.then((c) => c.on("close", () => this.contexts.delete(provider))).catch(() => this.contexts.delete(provider));
    }
    return ctx;
  }

  private async launch(provider: string): Promise<BrowserContext> {
    const { chromium } = await import("playwright");
    const dir = this.profileDir(provider);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Headless is for automated tests only. Real use is always a visible window.
    const headless = this.opts.headless ?? process.env.MUNCH_HEADLESS === "1";
    const base = { headless, viewport: headless ? { width: 1280, height: 900 } : null } as const;
    const channel = this.opts.channel ?? process.env.MUNCH_BROWSER_CHANNEL ?? "chrome";
    if (channel !== "chromium") {
      try {
        // The user's installed Chrome: the most ordinary browser we can offer the site.
        return await chromium.launchPersistentContext(dir, { ...base, channel });
      } catch {
        // Chrome isn't installed; fall through to Playwright's own Chromium.
      }
    }
    try {
      return await chromium.launchPersistentContext(dir, base);
    } catch (e) {
      throw new Error(`Could not open a browser. Install Google Chrome, or run "npx playwright install chromium". (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
  }

  /** The provider's working tab. Reuses an open one so we don't pile up tabs. */
  async page(provider: string): Promise<Page> {
    const ctx = await this.context(provider);
    return ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());
  }

  async close(provider: string): Promise<void> {
    const ctx = this.contexts.get(provider);
    this.contexts.delete(provider);
    if (ctx) await (await ctx).close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.contexts.keys()].map((p) => this.close(p)));
  }

  /** Signs out for good: closes the browser and deletes the profile folder. */
  async wipe(provider: string): Promise<void> {
    await this.close(provider);
    await rm(this.profileDir(provider), { recursive: true, force: true });
  }
}
