/**
 * Records what a delivery site's pages and data look like, so an adapter can
 * be written and tested against the real thing.
 *
 *   npm run record -- ubereats
 *
 * A browser window opens. YOU do every click: sign in, search, open a
 * restaurant, add an item, open checkout. The script only listens.
 * Do NOT place an order.
 */
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BrowserSessions } from "../src/browser/sessions.js";
import { Recorder } from "../src/browser/recorder.js";
import { defaultDataDir } from "../src/context.js";
import { UBEREATS, ubereatsLogin } from "../src/providers/ubereats/site.js";

const SITES = {
  ubereats: { ...UBEREATS, login: ubereatsLogin() },
};

const name = process.argv[2] as keyof typeof SITES;
const site = SITES[name];
if (!site) {
  console.error(`Usage: npm run record -- <${Object.keys(SITES).join("|")}>`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const enter = (msg: string) => rl.question(`\n${msg}\n→ Press Enter when done. `);

// Same profile folder the server uses, so signing in here also connects the app in MUNCH.
const browsers = new BrowserSessions(join(defaultDataDir(), "profiles"));
const context = await browsers.context(name);
const recorder = new Recorder(context, site.apiPattern);
const page = await browsers.page(name);
const current = () => context.pages().filter((p) => !p.isClosed()).at(-1) ?? page;

console.log(`\nRecording ${name}. A browser window is open.\nYou do all the clicking; this script only listens.\n*** Do NOT place an order. Stop at the checkout page. ***`);

const cookiesBefore = await recorder.cookieNames(site.cookieDomains);
recorder.setStep("1-login");
await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" }).catch(() => page.goto(site.homeUrl));
await enter("STEP 1 of 5: Sign in to your account in the browser window (skip if you're already signed in). End on the home page showing restaurants.");
const cookiesAfter = await recorder.cookieNames(site.cookieDomains);
const loggedIn = await site.login.isLoggedIn(context);
await recorder.snapshot(current());

recorder.setStep("2-search");
await enter('STEP 2 of 5: Make sure a delivery address is set. Then use the search box to search for a cuisine, for example "thai". Wait for results.');
await recorder.snapshot(current());

recorder.setStep("3-store");
await enter("STEP 3 of 5: Click a restaurant to open it. Scroll through its menu a little.");
await recorder.snapshot(current());

recorder.setStep("4-add-item");
await enter("STEP 4 of 5: Click an item that has choices (size, protein, sides). Pick the choices and add it to your cart.");
await recorder.snapshot(current());

recorder.setStep("5-checkout");
await enter("STEP 5 of 5: Open your cart and click through to the checkout page, where the fees, tax and total are listed. Expand any \"fees & taxes\" details. DO NOT place the order.");
await recorder.snapshot(current());

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(process.cwd(), ".munch-recordings", name, stamp);
const report = await recorder.save(dir, {
  site: name,
  recorded_at: stamp,
  responses_captured: recorder.count,
  login_check_passed: loggedIn,
  cookie_names_before_login: cookiesBefore,
  cookie_names_added_by_login: cookiesAfter.filter((c) => !cookiesBefore.includes(c)),
  cookie_names_after_login: cookiesAfter,
});
rl.close();
await browsers.closeAll();

console.log(`
Done. ${recorder.count} responses captured.

  ${dir}/
    report.md                   structure only (field names, page hooks). Share this.
    scrubbed/                   responses with personal data removed. Check before sharing.
    raw-PRIVATE-do-not-share/   untouched copies. Keep on this machine.

Next: open report.md, skim it for anything personal, then send it to Claude.
You can empty your cart in the browser any time. Nothing was ordered.`);
