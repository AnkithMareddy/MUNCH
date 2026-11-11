import type { BrowserContext } from "playwright";
import type { ProviderId, ProviderSession } from "../core/types.js";
import type { SessionStore } from "../storage/sessions.js";
import type { BrowserSessions } from "./sessions.js";

/** What we need to know about a delivery site to let the user sign in. */
export interface SiteLogin {
  provider: ProviderId;
  homeUrl: string;
  /** The site's own sign-in page. If it fails to load we fall back to homeUrl. */
  loginUrl: string;
  /** True once the user is signed in. Must only look, never type or click. */
  isLoggedIn(context: BrowserContext): Promise<boolean>;
}

const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60 * 1000;

/**
 * Sign-in without ever touching credentials: open the site's real login page in
 * a visible window, then just watch for the signed-in state. Everything typed
 * (password, 2FA code) goes from the user straight to the site.
 */
export class LoginFlow {
  private watching = false;

  constructor(private site: SiteLogin, private browsers: BrowserSessions, private sessions: SessionStore, private pollMs = POLL_MS) {}

  async status(): Promise<ProviderSession> {
    const stored = (await this.sessions.get(this.site.provider)) ?? { provider: this.site.provider, status: "disconnected" as const };
    // Only look at cookies if the browser is already open. Checking status must not pop a window.
    if (stored.status === "connected" && this.browsers.isOpen(this.site.provider)) return this.verify();
    if (stored.status === "connected" && !this.browsers.hasProfile(this.site.provider)) return this.save({ provider: this.site.provider, status: "disconnected" });
    if (stored.status === "pending" && !this.watching) return this.save({ provider: this.site.provider, status: "disconnected", note: "Sign-in was not finished." });
    return stored;
  }

  /** Opens the browser if needed and checks the session is really still valid. */
  async verify(): Promise<ProviderSession> {
    const ctx = await this.browsers.context(this.site.provider);
    const now = new Date().toISOString();
    if (await this.site.isLoggedIn(ctx)) {
      const prev = await this.sessions.get(this.site.provider);
      return this.save({ provider: this.site.provider, status: "connected", connected_at: prev?.connected_at ?? now, last_checked_at: now });
    }
    const prev = await this.sessions.get(this.site.provider);
    return this.save({ provider: this.site.provider, status: prev?.status === "connected" ? "expired" : "disconnected", last_checked_at: now, note: prev?.status === "connected" ? "The app signed you out. Connect again." : undefined });
  }

  /** Returns right away. "pending" means the window is open and waiting for the user. */
  async start(): Promise<ProviderSession> {
    const ctx = await this.browsers.context(this.site.provider);
    if (await this.site.isLoggedIn(ctx)) return this.verify();

    const page = await this.browsers.page(this.site.provider);
    const res = await page.goto(this.site.loginUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
    if (!res || res.status() >= 400) await page.goto(this.site.homeUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);

    const pending = await this.save({ provider: this.site.provider, status: "pending", note: "A browser window is open. Sign in there yourself (including any verification code). Never share your password in chat." });
    if (!this.watching) void this.watch(ctx);
    return pending;
  }

  private async watch(ctx: BrowserContext): Promise<void> {
    this.watching = true;
    const deadline = Date.now() + GIVE_UP_MS;
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, this.pollMs));
        if (!this.browsers.isOpen(this.site.provider)) {
          await this.save({ provider: this.site.provider, status: "disconnected", note: "The browser window was closed before sign-in finished." });
          return;
        }
        if (await this.site.isLoggedIn(ctx).catch(() => false)) {
          const now = new Date().toISOString();
          await this.save({ provider: this.site.provider, status: "connected", connected_at: now, last_checked_at: now });
          return;
        }
      }
      await this.save({ provider: this.site.provider, status: "disconnected", note: "Sign-in timed out after 10 minutes." });
    } finally {
      this.watching = false;
    }
  }

  async signOut(): Promise<void> {
    await this.browsers.wipe(this.site.provider);
    await this.sessions.delete(this.site.provider);
  }

  private async save(s: ProviderSession): Promise<ProviderSession> {
    await this.sessions.set(s);
    return s;
  }
}
