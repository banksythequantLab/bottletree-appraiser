// Run:  node worker/tests/heic_test.mjs
// The last layer between an iPhone photo and an appraisal invented from the dealer's own
// sentence. Measured 2026-09-24: a real HEIC in R2 produced "vision model failed on every photo;
// appraisal relies on dealer text only", an identification of "Vintage Red and Blue Painted
// Wooden Sign Board", and four lines of evidence every one of which began "Dealer reports".
// The warning fired correctly and was still useless, because it named a symptom rather than the
// one setting that fixes it.
import { photosLookHeic, blindRunError } from "../appraiser.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${n}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};
const p = (...urls) => urls.map(url => ({ url, kind: "front" }));

// The real shape. worker.js keeps the uploaded extension in the R2 key, so this is what the
// appraiser is handed.
const ORIGIN = "https://bottletree-app.dj-b02.workers.dev/p";
eq("the measured case", photosLookHeic(p(`${ORIGIN}/demo-heic/IMG_4821.heic`)), true);
eq("uppercase, as an iPhone writes it", photosLookHeic(p(`${ORIGIN}/abc/IMG_4821.HEIC`)), true);
eq("heif too", photosLookHeic(p(`${ORIGIN}/abc/x.heif`)), true);
eq("with a query string", photosLookHeic(p(`${ORIGIN}/abc/x.heic?v=2`)), true);
eq("with a fragment", photosLookHeic(p(`${ORIGIN}/abc/x.HEIF#top`)), true);
// One bad photo among good ones is still worth saying: the vision pass failed on all of them,
// and this is the most likely reason.
eq("one heic among jpegs", photosLookHeic(p(`${ORIGIN}/a/1.jpg`, `${ORIGIN}/a/2.heic`)), true);

// Ordinary photos must never be accused of being the wrong format.
eq("jpg", photosLookHeic(p(`${ORIGIN}/a/1.jpg`)), false);
eq("jpeg", photosLookHeic(p(`${ORIGIN}/a/1.jpeg`)), false);
eq("png", photosLookHeic(p(`${ORIGIN}/a/1.png`)), false);
eq("webp", photosLookHeic(p(`${ORIGIN}/a/1.webp`)), false);

// Matching on the extension rather than on "heic" appearing anywhere. A dealer's folder or an
// item name can contain the letters without the file being HEIC, and telling them to change a
// camera setting they are not using would send them off fixing the wrong thing.
eq("a folder named heic", photosLookHeic(p(`${ORIGIN}/heic-samples/photo.jpg`)), false);
eq("an item called heichelheim", photosLookHeic(p(`${ORIGIN}/a/heichelheim-vase.jpg`)), false);
eq("heic in the middle of a name", photosLookHeic(p(`${ORIGIN}/a/my.heic.backup.jpg`)), false);

// Degenerate input must not throw: this runs on the failure path, where things are already wrong.
eq("no photos", photosLookHeic([]), false);
eq("null", photosLookHeic(null), false);
eq("undefined", photosLookHeic(undefined), false);
eq("a null entry", photosLookHeic([null, undefined]), false);
eq("an entry with no url", photosLookHeic([{ kind: "front" }]), false);

// ---------- refusing to price what it could not see ----------
// Measured 2026-09-24 in production: every photo failed, and the run still returned an
// identification of "256 gb total" and a price of $920-1520, inferred from the dealer's sentence,
// having charged them an estimate for it. A warning under a four-figure headline is not a refusal.
const ok = (n, c) => { c ? pass++ : (fail++, console.log(`FAIL ${n}`)); };
const bad = (...n) => Array.from({ length: n[0] }, () => ({ error: "decode failed" }));
const good = (...n) => Array.from({ length: n[0] }, () => ({ notes: "brass dial, hairline crack" }));

ok("every photo unreadable refuses", !!blindRunError(p("a/1.jpg", "a/2.jpg"), bad(2)));
ok("and says the estimate was not spent",
   /estimate has not been used/.test(blindRunError(p("a/1.jpg"), bad(1))));
ok("a single unreadable photo is singular in the message",
   /read any of your 1 photo,/.test(blindRunError(p("a/1.jpg"), bad(1))));
ok("several are plural", /read any of your 3 photos,/.test(blindRunError(p("a/1.jpg", "a/2.jpg", "a/3.jpg"), bad(3))));

// HEIC is the known cause and the dealer can fix it themselves, so it gets its own sentence.
const heicMsg = blindRunError(p("a/IMG_1.heic", "a/IMG_2.heic"), bad(2));
ok("HEIC gets the setting that fixes it", /Settings > Camera > Formats > Most Compatible/.test(heicMsg));
ok("and is not described as unreadable for an unknown reason", !/very dark, blurred/.test(heicMsg));

// Partial failure is less evidence, not no evidence. This is the line that must not become
// over-eager: refusing here would throw away three good photos because of one bad one.
eq("three read, one refused still prices", blindRunError(p("a/1.jpg", "a/2.jpg", "a/3.jpg", "a/4.jpg"),
   [...good(3), ...bad(1)]), null);
eq("one read, three refused still prices", blindRunError(p("a/1.jpg", "a/2.jpg", "a/3.jpg", "a/4.jpg"),
   [...bad(3), ...good(1)]), null);
eq("all read, obviously prices", blindRunError(p("a/1.jpg"), good(1)), null);

// No photos at all is a description-only run, which the API has always allowed. [].every() is
// true, so the naive form of this check refuses the one case where nothing actually failed.
eq("no photos is not a refusal", blindRunError([], []), null);
eq("nor null photos", blindRunError(null, []), null);
eq("nor photos with no findings at all", blindRunError(p("a/1.jpg"), []), null);
eq("a null finding is not an error object", blindRunError(p("a/1.jpg"), [null]), null);

// The pipeline must actually throw on it, and the caller must actually refund. Asserted against
// the real sources, because the value of this change is entirely in those two call sites.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(join(root, "appraiser.js"), "utf8");
const WRK = readFileSync(join(root, "worker.js"), "utf8");
ok("appraise() throws the refusal", /const blind = blindRunError\(req\.photos, findings\);\s*\n\s*if \(blind\) throw new Error\(blind\);/.test(APP));
// Scoped to appraise()'s own body: `await metalPrices()` also appears earlier, in the melt
// helper, and a whole-file indexOf compares against that one instead and always fails.
const PIPE = APP.slice(APP.indexOf("export async function appraise"));
ok("it is decided before any money is spent on the reasoner",
   PIPE.indexOf("if (blind) throw new Error(blind)") < PIPE.indexOf("const spot = await metalPrices()"));
ok("a thrown appraisal is marked error", /UPDATE appraisals SET status='error'/.test(WRK));
ok("and refunds the dealer's estimate", /refundEstimate\(db, owner\.user_id, ap\.funded_by/.test(WRK));
ok("with the real reason, not a generic one", !/refundEstimate\([^)]*"appraisal failed"\)/.test(WRK));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
