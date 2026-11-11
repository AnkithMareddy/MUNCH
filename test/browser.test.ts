import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoginFlow, type SiteLogin } from "../src/browser/login.js";
import { loadRecording, prune, Recorder, urlPattern, writeRecording } from "../src/browser/recorder.js";
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

describe("scrubbing shapes seen on the real site", () => {
  const doc = {
    data: {
      shoppingCart: { creatorName: "Jane D.", groupedItems: [{ name: "Jane D.", consumerUuid: "c-1", items: [{ title: "Pad Thai", price: 1500 }] }] },
      selectedInstruction: { notes: "Gate code 4411", businessName: "Acme Tower", waypoint: { latitude: 40.111111, longitude: -73.222222 }, displayString: "Leave at door" },
      checkoutPayloads: { locationInfo: { address: { title: "42 Wallaby Way", subtitle: { text: "Brooklyn, NY 11201" } } }, fareBreakdown: { charges: [{ title: { text: "Delivery Fee" }, value: { text: "$0.49" } }] } },
      deliveryAddress: { reference: "ChIJplaceid12345", address: { eaterFormattedAddress: "42 Wallaby Way, Brooklyn" } },
      customerInfos: [{ firstName: "Jane", nickName: "JD-nick" }],
      searchHistory: [{ title: "late night ramen" }],
    },
  };
  const [clean] = scrubAll([doc]) as [typeof doc];
  const text = JSON.stringify(clean);

  it("removes names, door notes, exact location and place references", () => {
    expect(text).not.toMatch(/Jane|Gate code|Acme|40\.111111|73\.222222|Wallaby|ChIJ|JD-nick|c-1|late night ramen|Leave at door|11201/);
  });

  it("keeps cart items and fee lines", () => {
    expect(clean.data.shoppingCart.groupedItems[0]!.items[0]).toEqual({ title: "Pad Thai", price: 1500 });
    expect(clean.data.checkoutPayloads.fareBreakdown.charges[0]).toEqual({ title: { text: "Delivery Fee" }, value: { text: "$0.49" } });
  });
});

describe("scrubbing does not damage unrelated data", () => {
  const doc = {
    request: { cacheKey: "JTdCJTIyYWRkcmVzcyUyMiUzQSUyMjIxMTUlMjBCYXN0aWElMjIlMkMlMjJyZWZlcmVuY2UlMjI", link: "/search?carid=eyJhbmFseXRpY3NMYWJlbCI6InJlc3RhdXJhbnRfYWRfY2Fyb3VzZWwiLCJmZWVk" },
    data: {
      creditBalances: [{ amountString: "$0.00", type: "REGULAR" }],
      user: { firstName: "Jane" },
      feed: [{ type: "REGULAR_CAROUSEL", store: { title: "Subway" } }],
      fees: [{ title: { text: "Delivery Fee" }, value: { text: "$0.00", accessibilityText: "before promotion: $0.49, now: $0.00" } }],
      banner: "Hi Jane, welcome back",
    },
  };
  const [clean] = scrubAll([doc]) as [typeof doc];

  it("removes encoded blobs that can carry an address", () => {
    expect(JSON.stringify(clean)).not.toMatch(/JTdC|eyJhbmF/);
  });

  it("keeps amounts and ordinary words that merely also appear in personal sections", () => {
    expect(clean.data.fees[0]!.value).toEqual({ text: "$0.00", accessibilityText: "before promotion: $0.49, now: $0.00" });
    expect(clean.data.feed[0]).toEqual({ type: "REGULAR_CAROUSEL", store: { title: "Subway" } });
    expect(clean.data.banner).toBe("Hi [redacted], welcome back");
  });
});

describe("report helpers", () => {
  it("urlPattern hides ids, store names and query values", () => {
    expect(urlPattern("https://www.ubereats.com/store/thai-orchid-smith-st/AbCdEfGhIjKlMnOpQrStUv?diningMode=DELIVERY&pl=xyz")).toBe("https://www.ubereats.com/store/:slug/:id?diningMode=…&pl=…");
    expect(urlPattern("https://www.ubereats.com/search?q=thai")).toBe("https://www.ubereats.com/search?q=…");
  });

  it("prune shortens arrays, long strings and id-keyed maps, and drops unwanted keys", () => {
    const out = prune({ a: [1, 2, 3, 4], s: "x".repeat(200), imageUrl: "u", map: { "11111111-2222-3": 1, "22222222-3333-4": 2, "33333333-4444-5": 3, "44444444-5555-6": 4 } }, /image/i) as any;
    expect(out.a).toEqual([1, 2, "…(4 total)"]);
    expect(out.s.length).toBe(141);
    expect(out.imageUrl).toBeUndefined();
    expect(Object.keys(out.map)).toHaveLength(4);
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

  it("records the page's own JSON and page structure, even if the user never marks a step", async (t) => {
    if (!available) return t.skip();
    const ctx = await browsers.context("ubereats");
    const rec = new Recorder(ctx, new RegExp(`^${origin}/_p/api/`), 100);
    rec.setStep("2-search");
    const page = await browsers.page("ubereats");
    await page.goto(origin + "/?q=thai");
    await page.waitForSelector("body[data-loaded]");
    await new Promise((r) => setTimeout(r, 400)); // the automatic snapshot fires after the page settles
    await rec.settle();
    expect(rec.count).toBe(1);

    const out = join(dir, "rec");
    const opts = { samples: [{ endpoint: /getFeedV1$/, part: "response" as const, paths: ["data.feedItems"] }], dropKeys: /rating/ };
    const report = readFileSync(await rec.save(out, { site: "fake" }, opts), "utf8");
    expect(report).toContain("POST /_p/api/getFeedV1");
    expect(report).toContain(`| POST /_p/api/getFeedV1 | 1 | ${origin}/?q=… |`);
    expect(report).toContain("`store-card`");
    expect(report).toContain("Service Fee $6.45");
    expect(report).toContain("`Checkout`");
    expect(report).toContain('"firstName": "string"');
    // Example values: only the allowed part, scrubbed, without dropped keys.
    expect(report).toContain('"title": "Thai Orchid"');
    expect(report).not.toMatch(/Jane|jane@example|4\.7/);

    const file = readdirSync(join(out, "scrubbed")).find((f) => f.startsWith("2-search"))!;
    const clean = readFileSync(join(out, "scrubbed", file), "utf8");
    expect(clean).toContain("Thai Orchid");
    expect(clean).not.toMatch(/Jane|jane@example/);
    expect(readFileSync(join(out, "scrubbed", "_pages.json"), "utf8")).not.toContain("Jane");
    expect(readFileSync(join(out, "raw-PRIVATE-do-not-share", file), "utf8")).toContain("Jane");

    // The report can be rebuilt later from the saved recording.
    const again = await loadRecording(out);
    expect(again.captures).toHaveLength(1);
    expect(readFileSync(await writeRecording(out, again.captures, again.snapshots, { rebuilt: true }, opts), "utf8")).toContain('"title": "Thai Orchid"');
  }, 30_000);

  it("disconnecting deletes the browser profile", async (t) => {
    if (!available) return t.skip();
    const flow = new LoginFlow(site, browsers, sessions, 100);
    await flow.signOut();
    expect(browsers.hasProfile("ubereats")).toBe(false);
    expect((await flow.status()).status).toBe("disconnected");
  }, 30_000);
});
