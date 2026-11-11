import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoginFlow, type SiteLogin } from "../src/browser/login.js";
import { Recorder } from "../src/browser/recorder.js";
import { scrubAll, shape } from "../src/browser/scrub.js";
import { BrowserSessions } from "../src/browser/sessions.js";
import { EncryptedStore } from "../src/storage/encryptedStore.js";
import { StaticKeyProvider } from "../src/storage/keys.js";
import { SessionStore } from "../src/storage/sessions.js";

describe("scrubbing personal data from recordings", () => {
  const doc = {
    data: {
      user: { firstName: "Jane", lastName: "Doering", email: "jane@example.com", uuid: "u-123", phone: "+1 718 555 0101" },
      deliveryLocation: { address: { title: "42 Wallaby Way", subtitle: "Brooklyn, NY" }, latitude: 40.123456, longitude: -73.987654 },
      store: { uuid: "s-1", title: "Thai Orchid", name: "Thai Orchid", location: { address: "88 Smith St", latitude: 40.6878, longitude: -73.9903 }, phone: "(718) 555-0102" },
      menu: { items: [{ title: "Pad Thai", price: 1500 }] },
      checkout: { banner: "Deliver to Jane at 42 Wallaby Way", fees: [{ label: "Service Fee", amount: 645 }], paymentProfile: { cardLast4: "4242" } },
      csrfToken: "abc123secret",
    },
  };
  const [clean] = scrubAll([doc]) as [typeof doc];
  const text = JSON.stringify(clean);

  it("removes everything about the person, including repeats in free text", () => {
    expect(text).not.toMatch(/Jane|Doering|jane@|u-123|Wallaby|40\.123456|73\.987654|4242|abc123secret|718 555 0101/);
    expect(clean.data.checkout.banner).toBe("Deliver to [redacted] at [redacted]");
  });

  it("keeps public restaurant, menu and fee data", () => {
    expect(clean.data.store.title).toBe("Thai Orchid");
    expect(clean.data.store.location).toMatchObject({ address: "88 Smith St", latitude: 40.6878 });
    expect(clean.data.menu.items[0]).toEqual({ title: "Pad Thai", price: 1500 });
    expect(clean.data.checkout.fees[0]).toEqual({ label: "Service Fee", amount: 645 });
  });

  it("shape() exposes structure with no values", () => {
    const s = JSON.stringify(shape(doc));
    expect(s).not.toMatch(/Jane|Thai|1500|Wallaby/);
    expect(shape({ a: [{ x: 1 }, { y: "s" }], b: null })).toEqual({ a: [{ x: "number", y: "string" }, "×2"], b: "null" });
  });
});

/** A tiny stand-in for a delivery site: a login that sets a cookie, and a page that loads JSON. */
function fakeSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/do-login") return void res.writeHead(302, { "set-cookie": "sid=abc; Path=/", location: "/" }).end();
    if (req.url === "/login") return void res.writeHead(200, { "content-type": "text/html" }).end('<a id="go" href="/do-login">Sign in</a>');
    if (req.url === "/_p/api/getFeedV1")
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "success", data: { user: { firstName: "Jane", email: "jane@example.com" }, feedItems: [{ store: { title: "Thai Orchid", rating: 4.7 } }] } }));
    res.writeHead(200, { "content-type": "text/html" }).end(`<title>Feed</title><div data-testid="store-card">Thai Orchid</div><ul><li>Service Fee $6.45</li><li>Total $62.71</li></ul><button>Hi Jane</button><button>Checkout</button>
<script>fetch("/_p/api/getFeedV1",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:"thai"})}).then(()=>document.body.setAttribute("data-loaded","1"))</script>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

describe("browser sign-in and recording (headless, against a fake site)", () => {
  let server: Server;
  let origin: string;
  let browsers: BrowserSessions;
  let sessions: SessionStore;
  let site: SiteLogin;
  let dir: string;
  let available = true;

  beforeAll(async () => {
    ({ server, origin } = await fakeSite());
    dir = mkdtempSync(join(tmpdir(), "munch-browser-"));
    browsers = new BrowserSessions(join(dir, "profiles"), { headless: true, channel: "chromium" });
    sessions = new SessionStore(new EncryptedStore(join(dir, "data"), new StaticKeyProvider()));
    site = {
      provider: "ubereats",
      homeUrl: origin + "/",
      loginUrl: origin + "/login",
      isLoggedIn: async (ctx) => (await ctx.cookies(origin)).some((c) => c.name === "sid"),
    };
    try {
      await browsers.context("ubereats");
    } catch {
      available = false; // no browser on this machine: skip
    }
  }, 60_000);

  afterAll(async () => {
    await browsers.closeAll();
    server.close();
  });

  it("opens the login page, waits for the user, and never types anything", async (t) => {
    if (!available) return t.skip();
    const flow = new LoginFlow(site, browsers, sessions, 100);
    const first = await flow.start();
    expect(first.status).toBe("pending");
    expect(first.note).toMatch(/Sign in there yourself/);
    const page = await browsers.page("ubereats");
    expect(page.url()).toBe(origin + "/login");
    expect((await flow.status()).status).toBe("pending");

    await page.click("#go"); // the "user" signs in
    await expect.poll(async () => (await flow.status()).status, { timeout: 5000 }).toBe("connected");
    expect((await flow.start()).status).toBe("connected"); // already signed in: no new login
  }, 30_000);

  it("notices when the site has signed the user out", async (t) => {
    if (!available) return t.skip();
    const flow = new LoginFlow(site, browsers, sessions, 100);
    await (await browsers.context("ubereats")).clearCookies();
    expect((await flow.status()).status).toBe("expired");
  }, 30_000);

  it("records the page's own JSON, and saves scrubbed copies and a values-free report", async (t) => {
    if (!available) return t.skip();
    const ctx = await browsers.context("ubereats");
    const rec = new Recorder(ctx, new RegExp(`^${origin}/_p/api/`));
    rec.setStep("2-search");
    const page = await browsers.page("ubereats");
    await page.goto(origin + "/");
    await page.waitForSelector("body[data-loaded]");
    await rec.snapshot(page);
    await rec.settle();
    expect(rec.count).toBe(1);

    const out = join(dir, "rec");
    const report = readFileSync(await rec.save(out, { site: "fake" }), "utf8");
    expect(report).toContain("POST /_p/api/getFeedV1");
    expect(report).toContain("`store-card`");
    expect(report).toContain("Service Fee $6.45");
    expect(report).toContain('"firstName": "string"');
    expect(report).not.toMatch(/Jane|jane@example|Thai Orchid/);

    const file = readdirSync(join(out, "scrubbed")).find((f) => f.startsWith("2-search"))!;
    const clean = readFileSync(join(out, "scrubbed", file), "utf8");
    expect(clean).toContain("Thai Orchid");
    expect(clean).not.toMatch(/Jane|jane@example/);
    expect(readFileSync(join(out, "scrubbed", "_pages.json"), "utf8")).not.toContain("Jane");
    expect(readFileSync(join(out, "raw-PRIVATE-do-not-share", file), "utf8")).toContain("Jane");
  }, 30_000);

  it("disconnecting deletes the browser profile", async (t) => {
    if (!available) return t.skip();
    const flow = new LoginFlow(site, browsers, sessions, 100);
    await flow.signOut();
    expect(browsers.hasProfile("ubereats")).toBe(false);
    expect((await flow.status()).status).toBe("disconnected");
  }, 30_000);
});
