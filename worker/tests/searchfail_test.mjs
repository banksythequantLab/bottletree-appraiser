// Run:  node worker/tests/searchfail_test.mjs
// A broken search and an empty market must never produce the same sentence again.
import { searchComps, searchFailure } from "../appraiser.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
};

// No key configured at all.
await searchComps({}, "anything");
eq("missing key is reported", searchFailure(), "no market-search key is configured");

// A key that the service rejects. Point the fetch at a stub.
const realFetch = globalThis.fetch;
const stub = status => { globalThis.fetch = async () => new Response("", { status }); };

stub(401);
await searchComps({ TAVILY_API_KEY: "x" }, "red wing crock");
eq("401 is reported as a rejected key", searchFailure(), "the market-search key was rejected (401)");

stub(429);
await searchComps({ TAVILY_API_KEY: "x" }, "red wing crock");
eq("429 is reported as quota", searchFailure(), "the market-search quota is exhausted (429)");

stub(500);
await searchComps({ TAVILY_API_KEY: "x" }, "red wing crock");
eq("other statuses are reported verbatim", searchFailure(), "market search returned 500");

// A search that works and genuinely finds nothing must NOT report a failure.
globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }), {
  status: 200, headers: { "content-type": "application/json" },
});
await searchComps({ TAVILY_API_KEY: "x" }, "red wing crock");
eq("an empty but healthy search reports no failure", searchFailure(), null);

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
