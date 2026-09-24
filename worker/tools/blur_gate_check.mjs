// Manual verification harness. NOT part of the test suite - it needs Playwright and a browser.
//
//   node worker/tools/blur_gate_check.mjs [dir-with-images]
//
// WHY THIS EXISTS. The blur gate was the last thing in this product that had never been seen
// working. Its measurement was calibrated on real photos, but the gate itself - the toast, the
// confirm dialog, the hand-back - only runs when a file is picked through the page, so it was
// listed for days as "shipped, not production-proven" and the only way to see it was to stand
// in front of an antique with a phone.
//
// That was wrong. The gate is ordinary browser code, and a browser will run it. This loads the
// DEPLOYED app.js, lifts out sharpness() and acceptPhoto() exactly as served, and puts real
// image files through them in a real Chromium. Nothing is stubbed except toast() and confirm(),
// which have no meaning in a headless page and are the things being observed.
//
// With no directory given it generates its own gradient with ImageMagick if that is available;
// otherwise point it at a folder of photos. The useful shape is one sharp photo and the same
// photo at increasing blur.
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = process.env.BOTTLETREE_APP_JS ||
  "https://bottletree-app.dj-b02.workers.dev/app.js";
const dir = process.argv[2] || ".";
const files = readdirSync(dir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort();
if (!files.length) { console.error(`No images in ${dir}`); process.exit(2); }

// PLAYWRIGHT_CHROMIUM lets this run where the browser is preinstalled at a fixed path rather
// than downloaded by Playwright.
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const page = await browser.newPage();
await page.goto("about:blank");

// Only the blur gate is lifted out. The rest of app.js expects a live DOM and a signed-in
// session, and evaluating it whole would fail for reasons that have nothing to do with blur.
const src = await (await fetch(APP)).text();
const from = src.indexOf("const BLURRY");
const to = src.indexOf("// downscale to");
if (from < 0 || to < 0) {
  console.error("Could not find the blur gate in the deployed app.js. If it was renamed or moved,");
  console.error("fix the two markers above rather than trusting a pass from a file that lacks it.");
  process.exit(2);
}

await page.evaluate(code => {
  window.__toasts = []; window.__confirms = [];
  window.toast = m => window.__toasts.push(m);
  // true = the dealer taps "take it again", which is the branch that hands the photo back.
  window.confirm = m => { window.__confirms.push(m); return true; };
  // The exports go inside the same eval: `const BLURRY` declared by eval'd code is scoped to
  // that eval, so assigning from outside it would not see them.
  eval(code + "\nwindow.__sharpness=sharpness;window.__acceptPhoto=acceptPhoto;" +
       "window.__BLURRY=BLURRY;window.__SOFT=SOFT;");
}, src.slice(from, to));

const [B, S] = await page.evaluate(() => [window.__BLURRY, window.__SOFT]);
console.log(`thresholds read from the deployed file: BLURRY=${B} SOFT=${S}`);
console.log(`(real photos from this account: sharp memory kit 2644 and 2242; out-of-focus`);
console.log(` nickel rolls 167 and 229 - the two anchors these numbers were set from)\n`);
console.log("file                 score   verdict                    dialog");
console.log("----                 -----   -------                    ------");

let shown = null;
for (const f of files) {
  const b64 = readFileSync(join(dir, f)).toString("base64");
  const r = await page.evaluate(async ({ b64, name }) => {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const file = new File([u], name, { type: "image/jpeg" });
    window.__toasts = []; window.__confirms = [];
    const score = await window.__sharpness(file);
    const out = await window.__acceptPhoto(file, "photo");
    return { score, blocked: out === null, toasts: window.__toasts, confirms: window.__confirms };
  }, { b64, name: f });
  const verdict = r.score === null ? "unmeasurable, never blocked"
    : r.blocked ? "HANDED BACK"
    : r.toasts.length ? 'accepted, "a little soft"' : "accepted";
  console.log(`${f.padEnd(20)} ${String(r.score).padStart(5)}   ${verdict.padEnd(26)} ${r.confirms.length ? "yes" : "no"}`);
  if (r.confirms.length && !shown) shown = r.confirms[0];
}
if (shown) {
  console.log(`\n--- the dialog a dealer actually sees ---\n${shown}\n---`);
} else {
  console.log(`\nNo photo was blurry enough to trigger the dialog. That is not a pass: feed it a`);
  console.log(`genuinely out-of-focus photo before concluding the gate works.`);
}
await browser.close();
