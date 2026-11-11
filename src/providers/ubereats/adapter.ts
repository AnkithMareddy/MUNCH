import { LoginFlow } from "../../browser/login.js";
import type { BrowserSessions } from "../../browser/sessions.js";
import { ToolError } from "../../core/errors.js";
import type { MenuItem, ProviderSession, Restaurant } from "../../core/types.js";
import type { SessionStore } from "../../storage/sessions.js";
import type { ProviderAdapter, ProviderQuote } from "../ProviderAdapter.js";
import { UBEREATS, ubereatsLogin } from "./site.js";

const notBuilt = (what: string) =>
  new ToolError("not_built_yet", `Uber Eats ${what} is not built yet. Sign-in works; search, menus, carts and quotes are next.`, "Use the demo providers for now, or tell the user this part is still in development.");

/**
 * Uber Eats, driven through the user's own signed-in browser.
 * Phase 2a: sign-in, sign-out and session checks only.
 */
export class UberEatsAdapter implements ProviderAdapter {
  readonly id = "ubereats" as const;
  readonly displayName = "Uber Eats";
  readonly membershipName = "Uber One";
  readonly connectNotice =
    "This controls your own signed-in Uber Eats session in a browser window on your computer. Uber's terms generally prohibit automated access, so your account could be flagged or suspended. You sign in yourself; your password is never seen or stored.";
  private login: LoginFlow;

  constructor(browsers: BrowserSessions, sessions: SessionStore, site = UBEREATS) {
    this.login = new LoginFlow(ubereatsLogin(site), browsers, sessions);
  }

  sessionStatus(): Promise<ProviderSession> {
    return this.login.status();
  }
  connect(): Promise<ProviderSession> {
    return this.login.start();
  }
  disconnect(): Promise<void> {
    return this.login.signOut();
  }

  async search(): Promise<Restaurant[]> {
    throw notBuilt("search");
  }
  async getRestaurant(): Promise<Restaurant | undefined> {
    throw notBuilt("restaurant lookup");
  }
  async getMenu(): Promise<MenuItem[]> {
    throw notBuilt("menu reading");
  }
  async syncCart(): Promise<void> {
    throw notBuilt("cart building");
  }
  async quote(): Promise<ProviderQuote> {
    throw notBuilt("price quoting");
  }
  async openCheckout(): Promise<{ url: string; opened: boolean }> {
    throw notBuilt("checkout handoff");
  }
}
