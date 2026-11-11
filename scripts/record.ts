/**
 * Records what a delivery site's pages and data look like, so an adapter can
 * be written and tested against the real thing.
 *
 *   npm run record -- ubereats           record a new session
 *   npm run record -- ubereats --report  rebuild the report from the last recording
 *
 * A browser window opens. YOU do every click. The script only listens.
 * Do NOT place an order.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadRecording, Recorder, writeRecording } from "../src/browser/recorder.js";
import { BrowserSessions } from "../src/browser/sessions.js";
import { defaultDataDir } from "../src/context.js";
import { UBEREATS, UBEREATS_REPORT, ubereatsLogin } from "../src/providers/ubereats/site.js";

const SITES = {
  ubereats: { ...UBEREATS, login: ubereatsLogin(), report: UBEREATS_REPORT },
};

const name = process.argv[2] as keyof typeof SITES;
const site = SITES[name];
if (!site) {
  console.error(`Usage: npm run record -- <${Object.keys(SITES).join("|")}> [--report]`);
  process.exit(1);
}
const root = join(process.cwd(), ".munch-recordings", name);

/** Puts the report on the clipboard and shows the folder, so sharing it is one paste. */
function handOver(dir: string, report: string): void {
  let copied = false;
  if (process.platform === "darwin") {
    try {
      execSync("pbcopy", { input: readFileSync(report) });
      copied = true;
      execSync(`open "${dir}"`);
    } catch {
      // Clipboard or Finder not available: the file path below is enough.
    }
  }
  console.log(`
Report: ${report}
${copied ? "\n*** The report is now on your clipboard. Click into the Claude CHAT (not this Terminal) and press Cmd+V. ***\n*** Don't copy anything else first. If the paste is too big, drag report.md from the Finder window into the chat. ***" : "\nOpen report.md and send its contents to Claude."}

Only share report.md. The folder "raw-PRIVATE-do-not-share" stays on this machine.`);
}

if (process.argv.includes("--report")) {
  const last = existsSync(root) ? readdirSync(root).sort().at(-1) : undefined;
  if (!last) {
    console.error("No recording found. Run without --report first.");
    process.exit(1);
  }
  const dir = join(root, last);
  const { captures, snapshots } = await loadRecording(dir);
  const report = await writeRecording(dir, captures, snapshots, { site: name, recorded_at: last, responses_captured: captures.length, rebuilt: true }, site.report);
  handOver(dir, report);
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const enter = (msg: string) => rl.question(`\n${msg}\n→ Do it in the browser window FIRST. Then come back here and press Enter. `);

// Same profile folder the server uses, so signing in here also connects the app in MUNCH.
const browsers = new BrowserSessions(join(defaultDataDir(), "profiles"));
const context = await browsers.context(name);
const cookiesBefore = await new Recorder(context, /^$/).cookieNames(site.cookieDomains);
const recorder = new Recorder(context, site.apiPattern);
const page = await browsers.page(name);
const current = () => context.pages().filter((p) => !p.isClosed()).at(-1) ?? page;
const mark = async (step: string) => {
  await recorder.snapshot(current());
  recorder.setStep(step);
};

console.log(`\nRecording ${name}. A browser window is open.\nYou do all the clicking; this script only listens.\n*** Do NOT place an order. Stop at the checkout page. ***\nDo ONE step at a time: browser first, then Enter here.`);

recorder.setStep("1-login");
await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" }).catch(() => page.goto(site.homeUrl));
await enter("STEP 1 of 5: Sign in if asked (skip if already signed in). Go to the home page that lists restaurants.");
const cookiesAfter = await recorder.cookieNames(site.cookieDomains);
const loggedIn = await site.login.isLoggedIn(context);

await mark("2-search");
await enter('STEP 2 of 5: Type a cuisine in the search box at the top, for example "thai", and press Return. Wait for the results.');

await mark("3-store");
await enter("STEP 3 of 5: Click one restaurant from the results. Scroll its menu a little.");

await mark("4-add-item");
await enter("STEP 4 of 5: Click a dish that has choices (size, protein, sides). Pick the choices and click the add-to-cart button.");

await mark("5-checkout");
await enter('STEP 5 of 5: Open the cart and continue to the checkout page that lists fees, tax and total. DO NOT place the order.');
await recorder.snapshot(current());

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(root, stamp);
const report = await recorder.save(
  dir,
  {
    site: name,
    recorded_at: stamp,
    responses_captured: recorder.count,
    login_check_passed: loggedIn,
    cookie_names_added_by_login: cookiesAfter.filter((c) => !cookiesBefore.includes(c)),
    cookie_count_after_login: cookiesAfter.length,
  },
  site.report,
);
rl.close();
await browsers.closeAll();
console.log(`\nDone. ${recorder.count} responses captured. Nothing was ordered. You can empty your cart any time.`);
handOver(dir, report);
