import type { BrowserContext } from "playwright";
import type { SiteLogin } from "../../browser/login.js";

/**
 * What we assume about ubereats.com. Everything marked UNVERIFIED was written
 * without access to the live site and must be confirmed with a recording
 * (npm run record -- ubereats) before the rest of the adapter is built on it.
 */
export const UBEREATS = {
  homeUrl: "https://www.ubereats.com/",
  /** UNVERIFIED: expected to redirect to Uber's sign-in. Falls back to the home page if it doesn't load. */
  loginUrl: "https://www.ubereats.com/login-redirect/",
  /** UNVERIFIED: the web app's own JSON calls. The recorder captures anything matching this. */
  apiPattern: /^https:\/\/([a-z0-9-]+\.)?ubereats\.com\/(_p\/)?api\//,
  cookieDomains: ["https://www.ubereats.com", "https://auth.uber.com"],
  /** UNVERIFIED: a cookie that exists only while signed in. */
  loginCookies: ["sid"],
};

export function ubereatsLogin(site = UBEREATS): SiteLogin {
  return {
    provider: "ubereats",
    homeUrl: site.homeUrl,
    loginUrl: site.loginUrl,
    async isLoggedIn(context: BrowserContext): Promise<boolean> {
      const cookies = await context.cookies(site.cookieDomains);
      return cookies.some((c) => site.loginCookies.includes(c.name) && c.value !== "");
    },
  };
}
