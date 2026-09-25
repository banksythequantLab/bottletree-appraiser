// Runs every tests/*_test.mjs and adds up the totals.
//
// The suite predates this: each test file is a standalone script that prints "N passed, M
// failed" and exits non-zero if anything failed. node --test does not understand that shape,
// so the totals were being added up by a shell loop retyped by hand every time. This is that
// loop, in the repository, where `npm test` can find it.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f => f.endsWith("_test.mjs")).sort();
if (!files.length) { console.error("no tests found"); process.exit(1); }

let passed = 0, failed = 0;
const broken = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(here, f)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  if (!m) {
    // A file that crashes before printing its tally has not "passed zero tests"; it has failed
    // in a way that a total would hide. Say so, and show enough to start from.
    broken.push(f);
    console.log(`\n=== ${f}: did not report a tally ===\n${out.trim().split("\n").slice(-12).join("\n")}`);
    continue;
  }
  passed += Number(m[1]);
  failed += Number(m[2]);
  if (Number(m[2]) > 0) {
    console.log(`\n=== ${f}: ${m[0]} ===`);
    for (const line of out.split("\n")) if (line.startsWith("FAIL")) console.log(line);
  }
}

console.log(`\n${files.length} files · ${passed} passed, ${failed} failed` +
  (broken.length ? ` · ${broken.length} did not run: ${broken.join(", ")}` : ""));
process.exit(failed || broken.length ? 1 : 0);
