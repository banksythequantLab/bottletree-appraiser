// Run:  node worker/tests/heic_test.mjs
// The last layer between an iPhone photo and an appraisal invented from the dealer's own
// sentence. Measured 2026-09-24: a real HEIC in R2 produced "vision model failed on every photo;
// appraisal relies on dealer text only", an identification of "Vintage Red and Blue Painted
// Wooden Sign Board", and four lines of evidence every one of which began "Dealer reports".
// The warning fired correctly and was still useless, because it named a symptom rather than the
// one setting that fixes it.
import { photosLookHeic } from "../appraiser.js";

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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
