// Bottle Tree appraiser — ported from the FastAPI service (service/app/{pipeline,nebius,comps}.py)
// so the Worker calls Nebius Token Factory and Tavily directly. No box to keep awake.
// The edge/Ollama brain is intentionally not ported: it exists for the offline kiosk, not for this path.

const DEFAULTS = {
  base: "https://api.tokenfactory.nebius.com/v1/",
  text: "nvidia/nemotron-3-super-120b-a12b",
  vision: "google/gemma-3-27b-it",
  visionFallbacks: ["Qwen/Qwen2.5-VL-72B-Instruct", "google/gemma-3-27b-it"],
};

// ---------- prompts (verbatim from pipeline.py — these are tuned, don't paraphrase them) ----------
const VISION_PROMPT = kind => `You are an antiques cataloguer examining ONE photograph labelled "${kind}" of an item for sale.
Return ONLY a JSON object with these keys:
{
 "object_type": "short noun phrase (e.g. 'oak side chair', 'stoneware crock', 'brass carriage clock')",
 "materials": ["..."],
 "construction": ["joinery, manufacturing or finishing clues you can actually see"],
 "condition": ["wear, repairs, damage, patina you can actually see"],
 "transcribed_text": ["every word, number, stamp, signature, label or mark visible, verbatim; [] if none"],
 "notable_features": ["style cues, hardware, decoration, dimensions if a ruler/reference is visible"]
}
Be literal and specific. Do not guess maker or date here - only report what is visible.
Keep it short: at most 4 items per list, each item under 12 words. No prose outside the JSON.`;

const OCR_PROMPT = `Transcribe ALL text visible in this photo: stamps, impressed marks, cobalt numbers, labels, signatures,
model numbers, hand-written notes. Return ONLY JSON: {"text": ["each distinct line or mark, verbatim"]}.
If there is truly no text, return {"text": []}.`;

const IDENTIFY_SYSTEM = currency => `You are a senior antiques appraiser writing for an independent antique dealer.
You reason from EVIDENCE: photo findings from a vision model, the dealer's own description, and any
markings the dealer transcribed by hand (treat dealer markings as more reliable than OCR).
The per-photo object_type guesses come from a small vision model looking at ONE angle each and often
disagree with each other; the dealer's description, the transcribed marks and patent dates outrank them.
Give a confident identification when the evidence supports it, and an honest confidence when it does not.
If unsure of value, still give a WIDE non-zero price range rather than zeros.
Prices are realistic secondary-market dealer prices in ${currency} for the stated condition, not insurance values.
Always return ONLY one JSON object matching the schema you are given. No prose outside the JSON.`;

const IDENTIFY_SCHEMA = `{
 "identification": {"name": "", "category": "", "maker": "", "origin": "", "period": "", "style": ""},
 "confidence": 0.0,
 "evidence": [],
 "transcribed_text": [],
 "price_range": {"low": 0, "high": 0, "suggested_retail": 0, "floor": 0, "currency": "USD", "basis": ""},
 "listing": {"title": "", "description": "", "tags": [], "condition_grade": ""},
 "questions_for_dealer": []
}

FIELD GUIDE (do not copy these sentences into the JSON):
- identification.name: what the item is, e.g. "Joseph Bayer 5-gallon salt-glazed stoneware crock". Never leave empty.
- confidence: 0.0-1.0 how sure you are of maker/period. 0.9 = stamped and consistent; 0.3 = style guess only.
- evidence: 2-6 short strings, each = one observation and what it implies.
- transcribed_text: every mark/word from the photos and the dealer's markings, cleaned and de-duplicated.
- price_range: low/high = realistic dealer retail band in whole dollars, NEVER all zeros; suggested_retail inside the band;
  floor = lowest you'd accept; basis = one plain sentence on how you priced it.
- listing.title: <= 80 chars, searchable (maker, period, type). listing.description: 2-3 short paragraphs for a shop website.
- listing.condition_grade: one of Excellent, Very good, Good, Fair, Poor, As-is.
- questions_for_dealer: 1-2 things that would most change the appraisal if known.
- If the photographs do not settle what the item is — out of focus, too far away, the wrong face of
  the object, a detail you cannot read — say so plainly in confidence AND make the FIRST entry in
  questions_for_dealer the single specific photograph that would settle it: which face, which mark,
  from how close. "A close, sharp photo of the stamp on the base" is useful; "more photos" is not.
  Trust what the dealer wrote over what you think you see: they are holding the object.

EXAMPLE of a filled answer for a different item (format only):
{"identification":{"name":"Red Wing 3-gallon stoneware crock","category":"Stoneware","maker":"Red Wing Union Stoneware Co.","origin":"Red Wing, Minnesota, USA","period":"c. 1915-1930","style":"Utilitarian salt-glaze"},"confidence":0.85,"evidence":["Red Wing oval stamp on face - factory-marked, post-1906 union period","Cobalt '3' capacity mark matches 3-gallon body size"],"transcribed_text":["RED WING UNION STONEWARE CO.","3"],"price_range":{"low":90,"high":160,"suggested_retail":135,"floor":90,"currency":"USD","basis":"Common marked Red Wing size; hairline would drop it to the low end."},"listing":{"title":"Red Wing 3-Gallon Stoneware Crock, Union Stoneware Co., c. 1920","description":"A classic Red Wing 3-gallon crock with the oval Union Stoneware stamp and a cobalt 3. Sturdy salt-glazed body with the warm patina these pieces earn in a century of farmhouse use.\\n\\nRim and base are sound. A handsome piece for a kitchen counter, utensil storage or a farmhouse display.","tags":["red wing","stoneware","crock","farmhouse"],"condition_grade":"Very good"},"questions_for_dealer":["Any hairlines or chips on the rim or base?"]}`;

const REPRICE_SYSTEM = `You are a senior antiques appraiser. You previously appraised an item; now you have live
comparable listings from the web. Comparables may be irrelevant or asking (not sold) prices - weigh them
accordingly. Return ONLY a JSON object: {"price_range": {...same shape...}, "comparables": [{"title","price","url","source","note"}],
"basis_note": "one sentence", "rejected": [{"title","why"}]}.
Keep at most 4 comparables that are actually similar.
Every comparable you were given that you do NOT keep must appear in "rejected" with a short, concrete
reason - "Riviera, a different Homer Laughlin line", "divided plate, not a dinner plate", "rare Pumpkin
colorway, not comparable to blue". This list is read by the dealer, so say what is different about the
item, never "less relevant" or "not similar".`;

const PRICE_SYSTEM = `You are an antiques dealer setting a retail price. You MUST answer with numbers even when unsure:
give a wide range rather than zeros. Return ONLY JSON:
{"low": 0, "high": 0, "suggested_retail": 0, "floor": 0, "currency": "USD", "basis": ""}`;

// ---------- JSON extraction (ported from nebius.py) ----------
const FENCE = /```(?:json)?\s*([\s\S]*?)```/;

export function extractJson(text) {
  let t = String(text || "").trim();
  const m = FENCE.exec(t);
  if (m) t = m[1].trim();
  else if (t.startsWith("```")) t = t.includes("\n") ? t.slice(t.indexOf("\n") + 1) : "";
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf("{");
  if (start === -1) throw new Error("model returned no JSON object");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  const repaired = repairTruncatedJson(t.slice(start));
  if (repaired) return repaired;
  throw new Error("unterminated JSON object in model output");
}

export function repairTruncatedJson(text, maxBackoff = 40) {
  let cut = text.length;
  for (let n = 0; n < maxBackoff; n++) {
    const chunk = text.slice(0, cut).replace(/\s+$/, "");
    try {
      const obj = JSON.parse(closeOpen(chunk));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch {}
    cut = chunk.lastIndexOf(",");
    if (cut <= 0) return null;
  }
  return null;
}

function closeOpen(chunk) {
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of chunk) {
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "[" ) stack.push("]");
    else if (ch === "{") stack.push("}");
    else if ((ch === "]" || ch === "}") && stack.length) stack.pop();
  }
  let out = (chunk + (inStr ? '"' : "")).replace(/\s+$/, "");
  if (out.endsWith(",")) out = out.slice(0, -1);
  if (out.endsWith(":")) out = out.includes(",") ? out.slice(0, out.lastIndexOf(",")) : out + " null";
  return out + stack.reverse().join("");
}

// ---------- Token Factory (OpenAI-compatible) over plain fetch ----------
function cfg(env) {
  return {
    key: env.NEBIUS_API_KEY || "",
    base: (env.NEBIUS_BASE_URL || DEFAULTS.base).replace(/\/+$/, "") + "/",
    text: env.TEXT_MODEL || DEFAULTS.text,
    vision: env.VISION_MODEL || DEFAULTS.vision,
  };
}

async function chat(c, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(c.base + "chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`token factory ${r.status}: ${txt.slice(0, 200)}`);
    const j = JSON.parse(txt);
    return j.choices?.[0]?.message?.content || "";
  } finally { clearTimeout(t); }
}

async function visionJson(c, prompt, imageUrl, maxTokens = 900, temperature = 0.1) {
  const content = [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }];
  const models = [c.vision, ...DEFAULTS.visionFallbacks.filter(m => m !== c.vision)];
  let last;
  for (const model of models) {
    try {
      // Token Factory vision endpoints sometimes queue a call for minutes; fail fast, fall to the next model.
      const text = await chat(c, { model, messages: [{ role: "user", content }], max_tokens: maxTokens, temperature }, 45000);
      return extractJson(text);
    } catch (e) { last = e; }
  }
  throw last || new Error("vision failed");
}

async function textJson(c, system, user, maxTokens = 1800) {
  // Nemotron 3 Super is a reasoning model: its thinking shares the completion budget with the answer.
  const max_tokens = Math.max(maxTokens, 6000);
  const base = { model: c.text, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens, temperature: 0.2 };
  let text;
  try { text = await chat(c, { ...base, response_format: { type: "json_object" } }, 120000); }
  catch { text = await chat(c, base, 120000); }
  return extractJson(text);
}

// ---------- comps (comps.py) ----------
const PRICE_RE = /\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/;
const PRICE_ALL_RE = /(?:US\s*)?\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/g;

// Taking the FIRST dollar figure in a search snippet is how "+$5.99 shipping" became the comp.
// Marketplace snippets are littered with figures that are not the item's price: postage, "Save $10",
// a struck-through was-price, financing.
// Position matters, so these are two separate tests rather than one window. A wide lookback throws
// away real prices: "Free shipping. SK Hynix 32GB DDR4 ECC RDIMM $159.99" is a perfectly good comp,
// and a 40-character sweep backwards would kill it on the word "shipping". What actually disqualifies
// a figure is a word sitting immediately against it — "Save $10", "$5.99 shipping".
const BEFORE_NOT_PRICE = /\b(save|saving|was|orig(?:inal(?:ly)?)?|list price|retail price|msrp|reduced (?:to|from)?|discount(?:ed)?(?: by)?|coupon|rebate|off)\b[\s:–—-]*$/i;
// The financing alternatives sit outside the \b group on purpose: "$79/mo" has no word boundary
// between the digit and the slash, so an anchored \b would never fire.
const AFTER_NOT_PRICE = /^[^$]{0,14}?(?:\b(?:shipping|postage|delivery|freight|s&h|off|per month|monthly|cash ?back|credit|in savings)\b|\/ ?mo(?:nth)?\b)/i;

export function pricesIn(text) {
  const s = String(text || "");
  const out = [];
  let m;
  PRICE_ALL_RE.lastIndex = 0;
  while ((m = PRICE_ALL_RE.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 18), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (BEFORE_NOT_PRICE.test(before) || AFTER_NOT_PRICE.test(after)) continue;
    const v = parseFloat(m[1].replace(/,/g, ""));
    // Under a dollar is a fee or a fragment; over a million is a typo or a market-cap sentence.
    if (Number.isFinite(v) && v >= 1 && v <= 1e6) out.push(v);
  }
  return out;
}

const median = ps => {
  const s = [...ps].sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// One representative number for a hit. A title carrying a price is the most reliable thing on the
// page — it is the listing's own headline. Failing that, the middle of the body's figures, which
// survives one stray number far better than the first one does.
// A WorthPoint page for a Griswold skillet yielded "$906,000". Whatever that figure is — an item
// number, a page counter — it is not a skillet price, and a six-figure comp would wreck any
// appraisal it touched. This tool prices estate sales and antique booths; above this, the dealer is
// not relying on software. The title still goes through as evidence, just without a price attached.
const MAX_COMP = 100000;

export function hitPrice(title, content) {
  const t = pricesIn(title);
  const p = t.length ? median(t) : (pricesIn(content).length ? median(pricesIn(content)) : null);
  return p !== null && p <= MAX_COMP ? p : null;
}

const firstPrice = t => { const m = PRICE_RE.exec(t || ""); if (!m) return null; const v = parseFloat(m[1].replace(/,/g, "")); return Number.isFinite(v) ? v : null; };

// ---------- eBay Browse: what the thing is listed at right now ----------
// eBay put SOLD listings behind a login wall in Aug 2026, and Marketplace Insights (the official
// sold-price API) has been closed to new applicants for years. Active listings are free, open and
// permitted — and asking prices are enough to catch the failure that actually costs money, which is
// not "off by 20%" but "off by 5x because there was no market data at all".
// We report these as what they are: currently listed, not sold.
let _ebayTok = { at: 0, token: null };

// The same silent catch that hid a dead Tavily key for months was sitting here too. A price feed
// that fails quietly is worse than one that is absent, because the appraisal still produces a
// confident number and nothing on the page says where it came from. Record the reason.
let _ebayFail = null;
let _ebayBroadened = null;
export const ebayFailure = () => _ebayFail;
// The query that actually returned listings, when it was not the one we asked for.
export const ebayBroadenedTo = () => _ebayBroadened;

async function ebayToken(env) {
  if (_ebayTok.token && Date.now() - _ebayTok.at < 6600e3) return _ebayTok.token;   // 7200s life, refresh early
  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    _ebayFail = `eBay rejected the API credentials (${r.status})`;
    console.log("ebay auth failed", r.status, detail.slice(0, 300));
    throw new Error(`ebay auth ${r.status}`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error("ebay auth: no token");
  _ebayTok = { at: Date.now(), token: j.access_token };
  return j.access_token;
}

// eBay's search is AND-ish: one token it has never seen returns nothing at all, however good the
// rest of the query is. A dealer's marking is exactly that token. "32GB DDR4 SDRAM DIMM 2Rx4
// C424TRB111" returns 0 results; drop the marking and the same search returns 6,325 listings
// between $198 and $1,140. Silence from eBay is far more often an over-specific query than an
// item nobody is selling.
const OPAQUE_TOKEN = /^(?=.*[a-z])(?=(?:.*\d){3,})[a-z0-9-]{6,}$/i;

// The query reaching eBay is assembled from the model's name, the maker and the period, so it
// arrives carrying punctuation and filler: "32GB DDR4 SDRAM DIMM (Part C424TRB111)" and a period
// guess like "2015-2023". eBay matches on words, and "(Part" and a date range are words it will
// happily try to match, which is how a search for server RAM came back with a DDR5 desktop kit.
// A single year is kept — on an antique it is the most useful token there is.
const EBAY_FILLER = /^(part|parts|model|mod|no|number|circa|ca|c|approx|approximately|unknown|n\/a|and|the|with|for)$/i;

// "No" is filler in "part no C424TRB111" and it is the item's NAME in "Griswold No 8". Only the
// first sense is dropped, and only when a part/model word introduces it. Stripping it outright
// turned "Griswold No 8 skillet" into "Griswold 8 skillet", which is a materially worse search
// for cast iron — the pans are listed by their number. The trailing period is normalised away
// first so that "No." and "No" cannot take different paths through this function; before that
// they did, and the same pan got two different eBay queries depending on the model's punctuation.
const NUM_WORD = /^(?:no|num|number|nr)$/i;
const INTRODUCES_NUM = /^(?:part|parts|model|mod|serial|catalog|catalogue|cat|item|stock)$/i;

export function cleanForEbay(query) {
  const toks = String(query || "")
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}\-/&.]+/gu, ""))          // strip brackets, commas, dashes-as-punctuation
    .map(t => t.replace(/\.+$/, ""))                            // "No." and "No" must behave identically
    .filter(Boolean);

  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^\d{4}\s*[-–]\s*\d{4}$/.test(t)) continue;             // "2015-2023" is a guess, not a search term
    if (/^[-/&.]+$/.test(t)) continue;
    if (NUM_WORD.test(t)) {
      // Drop it only as part of "part no" / "model no"; keep the "Griswold No 8" sense.
      if (INTRODUCES_NUM.test(toks[i - 1] || "")) continue;
      out.push(t);
      continue;
    }
    if (EBAY_FILLER.test(t)) continue;
    out.push(t);
  }
  return out.join(" ").trim();
}

export function broaden(query) {
  const toks = String(query || "").split(/\s+/).filter(Boolean);
  const out = [];
  const seen = new Set([toks.join(" ")]);
  const add = ts => { const s = ts.join(" "); if (s && !seen.has(s)) { seen.add(s); out.push(s); } };
  // First drop anything shaped like a part number or a serial: letters and digits mixed, long.
  const noPart = toks.filter(t => !OPAQUE_TOKEN.test(t.replace(/[^a-z0-9-]/gi, "")));
  if (noPart.length) add(noPart);
  // Then fall back to the leading words, which carry maker and category. Two steps, because an
  // antique query has no part number to drop — "Roseville Freesia vase 1945" needs the year gone
  // before eBay will match it, and that is a trailing word rather than an opaque token.
  const base = noPart.length ? noPart : toks;
  add(base.slice(0, 4));
  add(base.slice(0, 3));
  return out;
}

// Broadening buys results at the cost of precision, and eBay's relevance engine is loose enough
// to answer a DDR4 query with DDR3 parts. In one run that put PC3L-8500R modules at $30 alongside
// the right DDR4 parts at $200 and halved the median. A generation is not a nuance — it is a
// different product at a different price — so a listing that names a different one is rejected.
// The digit straight after ddr/pc is the generation, whether or not a speed follows it:
// DDR4, PC4-2933, PC3L-8500R, and DDR56400 (a DDR5 part) all resolve correctly.
const GEN = t => {
  const m = /\b(?:ddr|pc)(\d)/i.exec(String(t || ""));
  return m ? m[1] : null;
};

// SO-DIMM is laptop memory. A search for server RDIMMs answered with SO-DIMM kits is the same
// class of error as the wrong generation: a different product, at a different price.
const SODIMM = t => /\bso[- ]?dimm\b/i.test(String(t || ""));

export function contradictsGeneration(query, title) {
  const q = GEN(query), t = GEN(title);
  if (q && t && q !== t) return true;
  // Only reject on form factor when the query is specific about wanting the other one.
  if (/\br?dimm\b/i.test(query) && !SODIMM(query) && SODIMM(title)) return true;
  return false;
}

// The antiques equivalent of the generation problem. Against ten real antique identifications,
// eBay answered a "Red Wing 5 gallon salt glaze crock" query with 3 gallon crocks ($30) beside
// 5 gallon ones ($1,195), and a "Zenith Bakelite tube radio" query with a single radio KNOB at
// $19. Both are the same error as DDR3-for-DDR4: a different product answering the query, and
// one that drags the median somewhere the dealer cannot sell at.
//
// Size. Only capacities and inches, and only units written out — "in" as an abbreviation is the
// English word far more often than it is a measurement. A unit is compared only when the query
// states it too, so an unstated size never rejects anything.
// Sellers write capacities as words at least as often as digits — the live run that prompted
// this filter answered a 5 gallon query with an "Antique Red Wing ... Six Gallon Crock" at
// $1,195, which a digits-only pattern let straight through while it was correctly throwing out
// the 3 gallon ones. That is worse than no filter: it strips the honest low comps and keeps the
// outlier. Words and digits have to be read the same way.
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, half: 0.5, quarter: 0.25,
};
const NUM_WORD_RE = Object.keys(NUM_WORDS).join("|");
const SIZE_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?|\\d+\\s*\\/\\s*\\d+|${NUM_WORD_RE})\\s*-?\\s*(gal(?:lon)?s?|quarts?|qts?|pints?|inch(?:es)?|")`,
  "gi");
const UNIT_OF = u => {
  const s = u.toLowerCase();
  if (s.startsWith("gal")) return "gal";
  if (s.startsWith("q")) return "qt";
  if (s.startsWith("p")) return "pt";
  return "in";
};
export function sizesIn(text) {
  const out = new Map();
  for (const m of String(text || "").matchAll(SIZE_RE)) {
    const raw = m[1].toLowerCase();
    const n = raw in NUM_WORDS ? NUM_WORDS[raw]
      : raw.includes("/") ? (([a, b]) => Number(a) / Number(b))(raw.split("/"))
      : Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    const u = UNIT_OF(m[2]);
    if (!out.has(u)) out.set(u, new Set());
    out.get(u).add(n);
  }
  return out;
}

// Parts and reproductions. A knob is not a radio and a replica is not the antique, but a title
// that merely MENTIONS a part is usually fine — "bowl set with lids" is a good comp for a bowl
// set. So a part word only rejects when the title leads with it or marks itself as the part
// alone, and never when the dealer asked about that part in the first place.
const PART = "lids?|knobs?|dials?|handles?|covers?|stoppers?|inserts?|liners?|cords?|grilles?|bezels?|faceplates?|decals?|badges?|emblems?|hinges?|latches|spouts?|shades?|drawers?|legs?|feet";
const PART_ONLY = new RegExp(`\\b(?:${PART}|parts?)\\s+only\\b|\\bfor\\s+parts\\b|\\bparts?\\s*[/&]\\s*repair\\b`, "i");
const PART_LEAD = new RegExp(`^\\s*(?:${PART})\\b`, "i");
const PART_ANY = new RegExp(`\\b(?:${PART})\\b`, "i");
const REPRO = /\b(?:repro|reproduction|replica|replacement|aftermarket)\b/i;

// A listing that sells several variants under one heading displays the CHEAPEST variant's price.
// "Choose FIESTA Dinner Plates Ivory Yellow Turquoise Radioactive Red" showed $10.95 in a pool of
// $25-$125 red plates; $10.95 buys the ivory one. The Browse item summary carries no itemGroupType
// or itemGroupHref for these — checked against live responses for two queries, every summary came
// back with no group field whatsoever — so the heading is the only signal available.
const MULTI_OPTION = /\b(?:choose|you\s*-?\s*pick|u\s*-?\s*pick|your\s+choice|choice\s+of|pick\s+your|mix\s*(?:&|and)\s*match)\b/i;

// Sets and singles are different products at very different prices, in both directions. A single
// #442 bowl at $20 answered a query for a Butterprint bowl SET otherwise priced $201-$300; and
// "Towle Old Master Sterling Teaspoons Set of 2" at $140 answered a query for one teaspoon
// otherwise priced $49-$90, because $140 buys two.
const SET_WORD = /\b(?:set|sets|pair|pairs|service|lot|nesting|roll|rolls|suite|collection|canteen)\b/i;
// A bare "(2)" in a title is a quantity nearly every time a seller writes it — "Two (2) 1930s
// FIESTA PLATES" is two plates at $54, not a $54 plate.
const EXPLICIT_COUNT = /\b(?:set|lot|pair|group|box|roll|pack)\s+of\s+\d+\b|\(\s*\d+\s*\)|\b\d+\s*(?:pc|pcs|pieces?)\b/i;

// Does the title use a plural of one of the query's own nouns? "Cinderella Nesting Bowls" is a
// set even though it never says "set", and rejecting it would throw away a good comp.
function pluralOfQuery(query, title) {
  const t = String(title).toLowerCase();
  for (const tok of String(query).toLowerCase().split(/\s+/)) {
    if (tok.length < 4 || !/^[a-z]+$/.test(tok)) continue;
    if (new RegExp(`\\b${tok}(?:e?s)\\b`).test(t)) return true;
  }
  return false;
}

function isSetQuery(q) { return SET_WORD.test(q) || EXPLICIT_COUNT.test(q); }

export function contradictsSpec(query, title) {
  const q = String(query || ""), t = String(title || "");

  const qs = sizesIn(q), ts = sizesIn(t);
  for (const [unit, qv] of qs) {
    const tv = ts.get(unit);
    // Disjoint values for a unit both sides named: a 3 gallon crock answering a 5 gallon query.
    if (tv && ![...qv].some(v => tv.has(v))) return true;
  }

  if (REPRO.test(t) && !REPRO.test(q)) return true;
  if (PART_ONLY.test(t) && !PART_ONLY.test(q)) return true;
  if (PART_LEAD.test(t) && !PART_ANY.test(q)) return true;

  if (MULTI_OPTION.test(t) && !MULTI_OPTION.test(q)) return true;

  const qSet = isSetQuery(q);
  // A set asked for, a single piece offered: the price is for one of the several.
  if (qSet && !SET_WORD.test(t) && !EXPLICIT_COUNT.test(t) && !pluralOfQuery(q, t)) return true;
  // One piece asked for, several offered: the price is for all of them. A seller who writes
  // "lot" means several even without a count — "Hull ... Figurine Lot" is not one cookie jar.
  if (!qSet && (EXPLICIT_COUNT.test(t) || /\blot\b/i.test(t))) return true;
  return false;
}

async function ebaySearch(env, tok, query, limit, signal) {
  const u = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  u.searchParams.set("q", String(query).slice(0, 120));
  u.searchParams.set("limit", String(limit));
  // Fixed price only: an auction at $0.99 with three days left is not a price signal.
  u.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");
  const r = await fetch(u, {
    headers: {
      authorization: `Bearer ${tok}`,
      "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE || "EBAY_US",
      "content-type": "application/json",
    },
    signal,
  });
  return { r, u };
}

export async function ebayActive(env, query, limit = 12) {
  _ebayFail = null;
  _ebayBroadened = null;
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    _ebayFail = "no eBay API keys are configured";
    return null;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const tok = await ebayToken(env);
    const base = cleanForEbay(query) || String(query);
    let r, u, out = [], used = null;
    for (const q of [base, ...broaden(base)]) {
      ({ r, u } = await ebaySearch(env, tok, q, limit, ac.signal));
      if (!r.ok) break;
      const j = await r.json();
      out = (j.itemSummaries || []).map(i => ({
        title: String(i.title || "").slice(0, 160),
        url: i.itemWebUrl || "",
        source: "ebay.com",
        price: Number(i.price?.value) || null,
        currency: i.price?.currency || "USD",
        condition: i.condition || "",
        note: `Listed now on eBay${i.condition ? ` — ${i.condition}` : ""}`,
        live: true,
      })).filter(x => x.price > 0
        && !contradictsGeneration(query, x.title)
        && !contradictsSpec(query, x.title));
      if (out.length) { used = q; break; }
    }
    if (r && r.ok) {
      // Record when the exact description found nothing, so the dealer is told the prices are for
      // comparable items rather than for this one.
      //
      // Compare against `base`, not the raw query. cleanForEbay is normalisation — it strips
      // punctuation and filler like "No." and "circa" — so "Griswold No 8 skillet" becomes
      // "Griswold 8 skillet" and would have compared unequal to the raw query on the FIRST,
      // un-broadened attempt. That put the "these are comparable items, not this one" warning
      // on nearly every appraisal with a period or a "No." in it, which is how a real warning
      // gets trained out of a dealer's attention. Only actual broadening should set it.
      if (used && used !== base) _ebayBroadened = used;
      return out;
    }
    if (r && !r.ok) {
      const detail = await r.text().catch(() => "");
      _ebayFail = `eBay search returned ${r.status}`;
      console.log("ebay search failed", r.status, u.toString().slice(0, 200), detail.slice(0, 400));
      return null;
    }
    return out;
  } catch (e) {
    if (!_ebayFail) _ebayFail = e.name === "AbortError" ? "the eBay search timed out" : `the eBay search failed (${e.message})`;
    console.log("ebay search threw", String(e && e.message));
    return null;
  }
  finally { clearTimeout(t); }
}

// Which of the live eBay listings survived the model's relevance judgement. The model returns the
// comparables it kept, sometimes with the title tidied up, so match on URL first and fall back to
// the title — a truncated or lightly reworded title still matches on its opening.
const normTitle = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
// One comparable claims at most one listing. Matching each comparable against every live listing
// independently let a single kept comparable pull in three duplicate listings of the same item,
// and the market line then said "3 comparables listed" for one thing listed three times. The
// count the dealer reads has to be the number of comparables the price actually rests on.
export function keptLive(live, comps) {
  if (!live || !live.length || !comps || !comps.length) return [];
  const taken = new Set();
  const claim = pred => {
    const i = live.findIndex((l, idx) => !taken.has(idx) && pred(l));
    if (i >= 0) { taken.add(i); return true; }
    return false;
  };
  for (const c of comps) {
    const url = String(c.url || "");
    const t = normTitle(c.title);
    // Exact URL, then exact title, then a long prefix — a model that tidied or truncated a title
    // still matches, but a short or generic opening cannot claim an unrelated listing.
    if (url && claim(l => String(l.url || "") === url)) continue;
    if (t.length >= 12 && claim(l => normTitle(l.title) === t)) continue;
    if (t.length >= 30) claim(l => {
      const lt = normTitle(l.title);
      return lt.startsWith(t.slice(0, 30)) || t.startsWith(lt.slice(0, 30));
    });
  }
  return [...taken].sort((a, b) => a - b).map(i => live[i]);
}

// A handful of asking prices, summarised the way a dealer would say it out loud:
// "three listed right now, $150 to $189". The median is the honest middle; the count is the caveat.
function summarise(listings) {
  const ps = listings.map(l => l.price).filter(p => p > 0).sort((a, b) => a - b);
  if (!ps.length) return null;
  const mid = ps.length % 2 ? ps[(ps.length - 1) / 2] : (ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2;
  return {
    count: ps.length,
    low: Math.round(ps[0]),
    high: Math.round(ps[ps.length - 1]),
    median: Math.round(mid),
    currency: listings[0].currency || "USD",
    source: "eBay active listings",
    as_of: new Date().toISOString(),
  };
}

// Antique marketplaces first, because that is the common case and they carry sold prices.
const ANTIQUE_DOMAINS = ["ebay.com", "liveauctioneers.com", "worthpoint.com", "1stdibs.com",
                         "chairish.com", "invaluable.com", "rubylane.com", "etsy.com"];

// A search that is failing and a market with nothing in it are different facts, and for months
// they produced the same sentence. The deployed Worker held a stale Tavily key: every call 401'd,
// the catch below swallowed it, and every appraisal told the dealer "no live comparables found" —
// which reads as "this item is obscure", not "the price you are looking at came from memory
// because our search has been broken since launch". Record why it came back empty.
let _searchFail = null;

async function tavily(env, query, domains, limit) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const body = { api_key: env.TAVILY_API_KEY, query, max_results: limit };
    if (domains) body.include_domains = domains;
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: ac.signal,
    });
    if (!r.ok) {
      _searchFail = r.status === 401 || r.status === 403
        ? `the market-search key was rejected (${r.status})`
        : r.status === 429 ? "the market-search quota is exhausted (429)"
        : `market search returned ${r.status}`;
      return [];
    }
    const j = await r.json();
    return (j.results || []).map(h => {
      const title = String(h.title || "").slice(0, 160);
      const content = String(h.content || "");
      return {
        title,
        url: h.url || "",
        source: String(h.url || "").includes("//") ? String(h.url).split("/")[2] : "",
        price: hitPrice(title, content),
        note: content.slice(0, 240),
      };
    });
  } catch (e) {
    _searchFail = e.name === "AbortError" ? "market search timed out" : `market search failed (${e.message})`;
    return [];
  }
  finally { clearTimeout(t); }
}

export async function searchComps(env, query, limit = 5) {
  _searchFail = null;
  if (!env.TAVILY_API_KEY) { _searchFail = "no market-search key is configured"; return []; }
  if (!String(query || "").trim()) return [];
  // The word "antique" used to be welded onto every query. On a box of DDR4 server RAM that is
  // poison: it guarantees no hits, the price falls back to what the model remembers, and on
  // anything whose market has moved the answer is wildly wrong. Ask plainly first.
  let hits = await tavily(env, `${query} sold price`, ANTIQUE_DOMAINS, limit);
  const priced = hs => hs.filter(h => h.price > 0).length;
  // Nothing with an actual number in it means the category is outside those marketplaces.
  // Search the open web before falling back to memory.
  if (priced(hits) < 2) {
    const wide = await tavily(env, `${query} for sale price`, null, limit);
    const seen = new Set(hits.map(h => h.url));
    hits = [...hits, ...wide.filter(h => !seen.has(h.url) && !isNoise(h))].slice(0, limit + 3);
  }
  // Still thin. Ask eBay directly and in eBay's own words — "for sale" phrasing hits listing pages,
  // where the price is in the title, rather than the guide and blog pages a generic query returns.
  // Costs one more search and only runs when we would otherwise be pricing from memory.
  if (priced(hits) < 3) {
    const bay = await tavily(env, `${query} for sale`, ["ebay.com"], limit);
    const seen = new Set(hits.map(h => h.url));
    hits = [...hits, ...bay.filter(h => !seen.has(h.url))].slice(0, limit + 6);
  }
  // Front doors and career pages are not comparables. They were being handed to the re-pricer as
  // evidence — WorthPoint's "What's it Worth?" landing page carried a $41,418 figure into a Singer
  // Featherweight appraisal. If this empties the list, the no-comparables warning fires, which is
  // the honest outcome.
  return hits.filter(h => isListingPage(h) && !isNoise(h) && relevant(query, h.title));
}

// Why the last search came back empty, or null if it simply found nothing.
export const searchFailure = () => _searchFail;

// There is deliberately no web-search equivalent of summarise() here. It was built and measured
// against ten real queries: it produced a range on one of them, and that one was wrong — three
// copies of the same eBay search page, reporting $8 for a vintage red Fiesta dinner plate that
// sells for $30-60. Tavily returns page descriptions, not listing grids, so the prices that reach
// us are sparse and usually belong to the cheapest thing on a category page. A quiet, confident,
// low number is the single most expensive failure this tool can produce for a dealer. Search hits
// stay what they are — titles and the occasional price, handed to the re-pricer as context — and
// the market card waits for the Browse API, which returns actual per-listing prices.

// An open-web search turns up news and finance pages whose dollar figures are not prices — a CNBC
// piece on chip demand came back as a "$3 comp". Feeding those to the re-pricer is worse than
// finding nothing, because they look like evidence.
// The place names in antique descriptions drag in maps and directories — "Red Wing 5 gallon crock"
// returned a MapQuest page for Red Wing, Minnesota.
const NOISE_HOST = /(^|\.)(cnbc|reuters|bloomberg|investing|finance\.yahoo|marketwatch|forbes|wsj|ft|barrons|seekingalpha|fool|benzinga|rocketreach|zoominfo|linkedin|wikipedia|glassdoor|mapquest|yelp|tripadvisor|indeed|ziprecruiter|facebook|instagram|pinterest|maps\.google)\./i;
const NOISE_WORD = /\b(shares?|stock|earnings|quarterly|revenue|billion|acquisition|merger|ipo|analyst|forecast|benchmark|salary|net worth)\b/i;
// Search engines happily return a marketplace's front door. "Invaluable.com: The World's Premier
// Online Auctions" and WorthPoint's "What's it Worth?" are not listings, but they carry dollar
// figures — a WorthPoint landing page handed us $41,418 for a Singer Featherweight. A real listing
// lives at a deep path; a front door does not.
const NOT_LISTING_HOST = /^(careers|community|help|support|pages|blog|about|www\.help)\./i;
const NOT_LISTING_TITLE = /^(home|sign in|shop|my ebay)\b|world's premier|what's it worth|the art of vintage|\| ebay us$|ebay community/i;

function isListingPage(h) {
  const url = String(h.url || "");
  const host = String(h.source || "");
  if (NOT_LISTING_HOST.test(host)) return false;
  if (NOT_LISTING_TITLE.test(String(h.title || ""))) return false;
  const path = url.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
  // "/itm/226503187440" and "/sch/i.html" clear this; "/", "/us" and "/b/ram" do not. A search
  // results page is kept on purpose — its title describes the item even when no price survives
  // into the snippet, and that is still useful evidence for the re-pricer.
  return path.replace(/\/+$/, "").length >= 8;
}

// A comp for a DIFFERENT thing is worse than no comp at all. A page titled "Micron Memory RAM",
// priced at $29.09, was the sole comparable for a 256GB kit of SK Hynix 32GB DDR4 ECC RDIMMs; the
// model multiplied it by eight and produced $230 for a box that sold for $960. The title shares
// none of what makes the query specific — not 32gb, not ddr4, not ecc, not rdimm.
const REL_STOP = new Set(["for", "sale", "price", "sold", "with", "and", "the", "of", "in", "a", "an",
                          "new", "used", "free", "shipping", "lot", "set", "item", "by", "at", "from"]);
const relTokens = s => new Set(String(s || "").toLowerCase().match(/[a-z0-9]+/g)?.filter(
  w => w.length >= 2 && !REL_STOP.has(w)) || []);

function relevant(query, title) {
  const q = relTokens(query);
  if (!q.size) return true;
  const t = relTokens(title);
  let shared = 0, sharedSpecific = 0;
  for (const w of q) if (t.has(w)) { shared++; if (/\d/.test(w)) sharedSpecific++; }
  // A model number, capacity or year carries far more weight than a shared common noun: "memory"
  // matches half the catalogue, "32gb" matches the part.
  return shared / q.size >= 0.34 || (sharedSpecific >= 1 && shared / q.size >= 0.2);
}

function isNoise(h) {
  const host = String(h.source || "");
  if (NOISE_HOST.test(host)) return true;
  if (NOISE_WORD.test(`${h.title} ${h.note}`)) return true;
  return false;
}

// ---------- helpers (pipeline.py) ----------
const ECHOES = ["one sentence on how you priced", "consolidated, de-duplicated", "the specific observation and what it implies",
                "short bullet", "2-3 paragraphs", "<= 80 chars", "one or two things"];
const OCR_ECHOES = new Set(["stamps", "impressed marks", "cobalt numbers", "labels", "signatures", "model numbers",
                            "hand-written notes", "each distinct line or mark, verbatim", "text", "none", "no text"]);

function strs(v) {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (!Array.isArray(v)) v = [v];
  const out = [];
  for (const x of v) {
    const s = (x && typeof x === "object")
      ? Object.values(x).map(String).filter(t => t.trim()).join(" — ")
      : String(x);
    if (s.trim()) out.push(s);
  }
  return out;
}
const dedupe = xs => { const seen = new Set(), out = []; for (const x of xs) { const k = x.toUpperCase().split(/\s+/).join(" ").trim(); if (k && !seen.has(k)) { seen.add(k); out.push(x.trim()); } } return out; };
const clean = (xs, maxLen = 200) => xs.filter(x => !ECHOES.some(e => x.toLowerCase().includes(e)) && x.length <= maxLen);
const cleanOcr = xs => xs.filter(x => !OCR_ECHOES.has(x.trim().toLowerCase().replace(/[.;:]+$/, "")));

function num(v, dflt = 0) {
  const n = parseFloat(String(v ?? "").replace(/,/g, "").replace(/\$/g, ""));
  return Number.isFinite(n) ? n : dflt;
}
function clamp(v) { let x = num(v, 0.5); if (x > 1) x = x <= 100 ? x / 100 : 1; return Math.max(0, Math.min(1, x)); }

const GRADES = ["Excellent", "Very good", "Good", "Fair", "Poor", "As-is"];
function grade(s) {
  const t = String(s || "").trim().toLowerCase();
  for (const g of GRADES) if (t === g.toLowerCase()) return g;
  if (!t) return "";
  const has = (...ws) => ws.some(w => t.includes(w));
  if (has("mint", "excellent", "pristine")) return "Excellent";
  if (has("very good", "no chips", "no damage", "no repairs", "sound", "clean")) return "Very good";
  if (has("as-is", "as is", "damaged", "broken", "parts")) return "As-is";
  if (has("poor", "heavy", "major")) return "Poor";
  if (has("fair", "chip", "crack", "repair", "hairline", "loss")) return "Fair";
  return "Good";
}

function priceOf(d, currency) {
  d = d || {};
  let low = num(d.low), high = num(d.high);
  if (high < low) [low, high] = [high, low];
  const mid = (low || high) ? (low + high) / 2 : 0;
  return {
    low, high,
    suggested_retail: num(d.suggested_retail, mid) || mid,
    floor: num(d.floor, low) || low,
    currency: String(d.currency || currency),
    basis: String(d.basis || ""),
  };
}

const score = d => [num((d.price_range || {}).high) > 0, num(d.confidence) > 0, strs(d.evidence).length > 0,
                    !!(d.listing || {}).description, !!(d.identification || {}).name].filter(Boolean).length;
const incomplete = d => num((d.price_range || {}).high) <= 0 || !strs(d.evidence).length || num(d.confidence) <= 0;

const STOP = new Set(["a","an","the","and","or","of","with","from","in","on","for","to","is","it","its","this","that",
  "has","no","not","very","old","antique","vintage","piece","item","heavy","small","large",
  "cast","iron","brass","copper","tin","steel","metal","wood","wooden","oak","pine","glass",
  "ceramic","pottery","stoneware","porcelain","black","brown","white","red","green","blue",
  // Sentence scaffolding. A dealer writes "These are four rolls..."; counting "these" and "are"
  // as things they told us inflates every overlap measure built on this set.
  "these","those","there","here","they","them","are","was","were","been","being","have","had",
  "got","some","just","really","about","maybe","looks","like"]);
const words = s => new Set((String(s || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter(w => !STOP.has(w)));
// Exported under a clearer name for the tests; `words` stays the short internal name.
export const significantWords = words;

export const dealerName = d => {
  const head = String(d || "").trim().split(/[.;,\n]/)[0];
  return head.split(/\s+/).slice(0, 10).join(" ").trim() || String(d || "").trim().slice(0, 80);
};
// A dealer writes a sentence, not a search term: "These are 4 rolls of world war 2 silver
// nickels". Handed to eBay whole, and then shortened by broaden(), that became "United States
// Mint These" and returned rolls of postage stamps. Reduce it to the words that identify the
// thing, keeping their order and any numbers — "4 rolls world war 2 silver nickels".
const PHRASE_DROP = new Set(["these","this","that","those","there","here","it","its","they","them",
  "i","we","my","our","your","am","are","is","was","were","be","been","being","have","has","had",
  "got","a","an","the","of","and","or","with","from","in","on","for","to","some","just","really",
  "look","looks","like","think","believe","says","said","said's","about","maybe","probably"]);
export function searchPhrase(s) {
  return String(s || "").split(/\s+/)
    .map(t => t.replace(/^[^\p{L}\p{N}]+/gu, "").replace(/[^\p{L}\p{N}%"'.-]+$/gu, ""))
    .filter(t => t && !PHRASE_DROP.has(t.toLowerCase()))
    .slice(0, 10).join(" ").trim();
}

export function ignoresDealer(name, description) {
  const dw = words(dealerName(description));
  if (!dw.size || !String(name || "").trim()) return false;
  let shared = 0;
  for (const w of words(name)) if (dw.has(w)) shared++;
  if (shared === 0) return true;

  // One word in common is not agreement. Production, 2026-09-23: against "4 rolls of world war 2
  // silver nickels" the model answered "2023 American Silver Eagle Coin Set". The single word
  // "silver" cleared the old zero-overlap test, so the dealer's identification never took over —
  // and because the melt check prices whatever the identification says the item is, it valued
  // four one-ounce Eagles at $260 instead of 160 wartime nickels at $585. The same photograph had
  // priced at $585 minutes earlier. Underpricing a lot below its own scrap value is the worst
  // number this tool can produce, and one incidental shared word was all it took.
  //
  // Only applied when the dealer gave enough words for a single match to be plausibly accidental.
  // Below that, a lone shared word is a large share of everything they said, and overriding a
  // specific identification on that basis would do more harm than good.
  if (dw.size >= 4 && shared < 2) return true;
  return false;
}
const MAKER_SUFFIX = "(?:CO\\.?|COMPANY|MFG\\.?|MANUFACTURING|BROS\\.?|BROTHERS|& SONS?|INC\\.?|LTD\\.?|WORKS|POTTERY|FOUNDRY)";
function makerFromMarks(marks) {
  const m = new RegExp(`\\b((?:[A-Z][A-Z'&.-]*\\s+){0,4}${MAKER_SUFFIX})(?=\\s|$|,)`).exec(String(marks || "").toUpperCase());
  if (!m) return "";
  return m[1].split(/\s+/).map(w => w.startsWith("&") ? w : w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}
// ---------- lots ----------
// Asked four times for the same 256GB kit of eight RDIMMs, the model answered $190-330, $20-50,
// $200-500 and $100-200. Reading its own stated basis each time, the arithmetic is where it comes
// apart: sometimes it prices one module, sometimes eight, and it reports both as "the price".
// Multiplication is not a judgement call, so we take it away from the model and do it here.
const CAP = { mb: 1 / 1024, gb: 1, tb: 1024 };
// "of" is mandatory after lot/box/set. Without it, "Lot 14" on an estate-sale tag is a lot
// NUMBER, not a quantity, and multiplying a single item's price by fourteen is the worst thing
// this code could do. Written-out small counts are common on tags and cost nothing to read.
// Dealers write the container count both ways round, and only one of them was being read.
// "4 rolls of war nickels" is how anyone would actually say it, and it was missed while "roll of
// 4" was caught. That miss cost real accuracy: with no lot detected the model prices the whole
// group as one object, and eight live listings of SINGLE rolls at $130-$200 — the best evidence
// available for that item — were rejected by the re-pricer as "single roll, not four rolls".
// Detect the lot and the same listings become the right comparables, because the model is then
// asked to price one roll. Four times the ~$140 median is $560, against a melt floor of $586:
// two independent routes to the same number.
//
// Years cannot be read as counts here: the count is capped at three digits, so "1943 rolls"
// cannot match. A matched set ("4 piece tea service") is still excluded below.
// Deliberately NOT here: "tube". A 1940s 5 tube radio is one radio, and counting its valves as a
// lot would have quintupled the price of every tube radio in the catalogue. The existing suite
// caught that the moment it was added, which is the whole argument for keeping these tests.
const CONTAINER = "lots?|sets?|boxes|packs?|rolls?|groups?|cases|trays?|bags|sleeves?|crates?|cartons?";
const COUNT_RE = new RegExp(
  `(?:\\b(?:lot|set|box|pack|roll|group|case|tray|bag)\\s+of\\s+(\\d{1,3})\\b)` +
  `|(?:\\b(?:qty|quantity)\\s*[:#]?\\s*(\\d{1,3})\\b)` +
  `|(?:\\b(\\d{1,3})\\s*(?:x|×|pcs?|pieces?|sticks?|modules?|units?|count|ct)\\b)` +
  `|(?:\\b(\\d{1,3})\\s*(?:${CONTAINER})\\b)`, "i");
const WORD_COUNT = { pair: 2, brace: 2, dozen: 12, "half dozen": 6, "half-dozen": 6 };
const WORD_COUNT_RE = /\b(half[- ]dozen|dozen|pair|brace)\s+of\s+|\b(half[- ]dozen|dozen|pair|brace)\b/i;

// A "3 piece carving set" is one object that happens to have three parts, and its value is not
// three times one piece of it. Same for a 4 piece tea service. The count words are identical to a
// genuine lot's, so the surrounding noun is what separates them.
const MATCHED_SET = /\b(set|service|suite|kit|ensemble|setting|canteen)\b/i;

// A capacity stated as a total, divided by the capacity stated per piece: "256 gb total" against
// markings reading "32gb" is eight modules, and the dealer never had to type the number 8.
const TOTAL_WORD = /\btotal\b|\ball ?together\b|\bcombined\b|\bin all\b/;

function capacity(text, wantTotal) {
  // Scope "total" to its own clause. In "512gb total, 64gb per stick" the word belongs to the
  // first figure only, and a plain character window either side would let it swallow the second.
  let best = 0;
  for (const clause of String(text || "").toLowerCase().split(/[,;|/\n]+/)) {
    const isTotal = TOTAL_WORD.test(clause);
    if (isTotal !== !!wantTotal) continue;
    const re = /(\d+(?:\.\d+)?)\s*(mb|gb|tb)\b/g;
    let m;
    while ((m = re.exec(clause))) best = Math.max(best, parseFloat(m[1]) * CAP[m[2]]);
  }
  return best;
}

export function detectLot(description, markings) {
  const both = `${description || ""} ${markings || ""}`;
  const m = COUNT_RE.exec(both);
  if (m) {
    const n = Number(m[1] || m[2] || m[3] || m[4]);
    // m[3] is the "N pieces" branch — the only one that can be describing the parts of a single
    // matched object rather than a quantity of separate ones. m[4] is "N rolls", "N boxes": the
    // container is named, so there is no such ambiguity.
    const fromPieces = m[3] !== undefined;
    if (n >= 2 && n <= 500 && !(fromPieces && MATCHED_SET.test(both)))
      return { count: n, how: "the dealer stated the count" };
  }
  const w = WORD_COUNT_RE.exec(both);
  if (w) {
    const n = WORD_COUNT[String(w[1] || w[2]).toLowerCase().replace("-", " ")];
    if (n) return { count: n, how: `the dealer wrote "${String(w[1] || w[2]).toLowerCase()}"` };
  }
  const total = capacity(description, true) || capacity(markings, true);
  const unit = capacity(markings, false) || capacity(description, false);
  if (total > 0 && unit > 0 && total > unit) {
    const n = total / unit;
    // Only a clean division is evidence. 250 over 32 is not seven and a bit modules, it is two
    // numbers that have nothing to do with each other.
    if (Number.isInteger(n) && n >= 2 && n <= 64) {
      return { count: n, how: `${total}GB total divided by ${unit}GB per piece` };
    }
  }
  return null;
}

// The name leads, then the maker. broaden() shortens a query from the end, so whatever comes
// first survives every broadening step — and that has to be what the item IS. With the maker
// first, a wartime-nickel query broadened to "United States Mint These" and found postage
// stamps: three steps of broadening had thrown away every word that named the object and kept
// only the mint. A maker is context for an identification, never a substitute for one.
function compsQuery(ident) {
  const out = [], seen = new Set();
  for (const chunk of [ident.name, ident.maker, ident.period]) {
    for (const w of String(chunk || "").replace(/,/g, " ").split(/\s+/)) {
      const k = w.toLowerCase().replace(/\.+$/, "");
      if (!k || ["c", "ca", "circa", "usa", "co", "inc"].includes(k) || seen.has(k)) continue;
      seen.add(k); out.push(w.replace(/^\.+|\.+$/g, ""));
    }
  }
  return out.slice(0, 10).join(" ") || ident.name;
}

const pick = (d, keys) => { const o = {}; for (const k of keys) if (d && d[k] !== undefined && d[k] !== null) o[k] = d[k]; return o; };
const IDENT_KEYS = ["name", "category", "maker", "origin", "period", "style"];
const LISTING_KEYS = ["title", "description", "tags", "condition_grade"];
const COMP_KEYS = ["title", "price", "url", "source", "note"];

// ---------- per-photo vision ----------
async function safeVision(c, prompt, url, maxTokens, _label) {
  for (const attempt of [1, 2]) {
    try { return await visionJson(c, prompt, url, maxTokens, attempt === 1 ? 0.1 : 0.6); }
    catch {}
  }
  return null;
}

async function photoFindings(c, kind, url) {
  const [raw, ocr] = await Promise.all([
    safeVision(c, VISION_PROMPT(kind), url, 900, "findings"),
    safeVision(c, OCR_PROMPT, url, 300, "ocr"),
  ]);
  if (!raw && !ocr) return { kind, error: "vision model returned no usable output (both passes failed)", transcribed_text: [], object_type: "" };
  const r = raw || {};
  const ocrText = cleanOcr(strs((ocr || {}).text));
  return {
    kind,
    object_type: String(r.object_type || ""),
    materials: strs(r.materials),
    construction: strs(r.construction),
    condition: strs(r.condition),
    transcribed_text: dedupe([...strs(r.transcribed_text), ...ocrText]),
    notable_features: strs(r.notable_features),
    error: null,
  };
}

function buildEvidenceSheet(req, findings) {
  const L = ["# Evidence sheet"];
  L.push(`Photos supplied: ${req.photos.length} (${req.photos.map(p => p.kind).join(", ")})`);
  L.push("\n## Dealer description\n" + (String(req.description || "").trim() || "(none given)"));
  L.push("\n## Dealer-transcribed markings (high reliability)\n" + (String(req.markings || "").trim() || "(none given)"));
  L.push("\n## Vision findings per photo");
  for (const f of findings) {
    L.push(`\n### Photo: ${f.kind}`);
    if (f.error) { L.push(`(vision model failed: ${f.error})`); continue; }
    L.push(`object_type: ${f.object_type}`);
    for (const key of ["materials", "construction", "condition", "transcribed_text", "notable_features"]) {
      const vals = f[key];
      if (vals && vals.length) L.push(`${key}: ` + vals.join("; "));
    }
  }
  return L.join("\n");
}

// Three photos at a time (six in-flight vision calls) — more got queued for minutes on Token Factory.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

// ---------- precious metal: live prices and a melt floor ----------
// The model knows metallurgy (it correctly read a wartime nickel as 1.75g Ag) but its spot price is
// frozen at training time — it priced 9 oz of silver off ~$25/oz while writing "at current spot".
// So: the model supplies fine metal weight, we supply today's price and do the arithmetic ourselves.
const METAL_SYMBOL = { silver: "SI=F", gold: "GC=F", platinum: "PL=F", palladium: "PA=F" };
let _spot = { at: 0, data: null };

export async function metalPrices() {
  if (_spot.data && Date.now() - _spot.at < 3600e3) return _spot.data;
  const out = {};
  await Promise.all(Object.entries(METAL_SYMBOL).map(async ([metal, sym]) => {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      // COMEX front-month, not true spot — within about 1% and free without a key. Labelled honestly.
      const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
        { headers: { "user-agent": "Mozilla/5.0" }, signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) return;
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      const p = Number(m?.regularMarketPrice);
      if (Number.isFinite(p) && p > 0) out[metal] = p;
    } catch {}
  }));
  if (!Object.keys(out).length) return _spot.data;   // keep a stale copy over nothing
  _spot = { at: Date.now(), data: { ...out, as_of: new Date().toISOString(), source: "COMEX front-month futures (Yahoo Finance)" } };
  return _spot.data;
}

const METAL_SYSTEM = `You are a precious-metals buyer assessing scrap/melt value. Given an item description,
work out the TOTAL fine precious metal it contains. Be literal and show the arithmetic in "basis".
Return ONLY JSON: {"metal": "silver|gold|platinum|palladium|none", "fine_troy_oz": 0.0, "basis": "", "confidence": 0.0}

Rules:
- fine_troy_oz is the TOTAL pure metal across every piece, not per item and not gross weight.
- Multiply out counts: "4 rolls of wartime nickels" = 4 x 40 = 160 coins.
- Common fine weights: US 90% silver dime 0.0723 ozt, quarter 0.1808, half 0.3617, dollar 0.7734;
  40% silver half (1965-1970) 0.1479; wartime nickel (1942-1945) 0.0563; Silver Eagle 1.0.
  Sterling .925 and coin silver .900 multiply gross weight by that fraction.
  Gold: 10k = .4167, 14k = .5833, 18k = .750, 22k = .9167 of gross weight.
- Silver PLATE, silverplate, EPNS, "German silver", nickel silver contain NO recoverable silver: return "none".
- WEIGHTED / LOADED pieces are mostly cement or pitch, not metal: sterling knife handles, most candlesticks,
  weighted compotes and trophy bases. Do NOT multiply their gross weight. A weighted knife holds roughly
  0.5-1 ozt of actual silver regardless of how heavy it feels; a weighted candlestick roughly 2-4 ozt.
  If a lot mixes weighted and solid pieces and you cannot separate them, still answer: treat the knives as
  weighted (about 0.75 ozt each), treat everything else as solid at gross x fineness, and state that
  assumption in "basis". Do NOT return "none" for a lot whose weight or count you were given — a
  conservative number is useful, a refusal is not. When genuinely torn, UNDERSTATE: this becomes a price
  floor, and too high a floor costs the dealer a sale.
- If the piece is not precious metal, or you cannot establish a weight or count, return metal "none" and 0.
- Never guess a weight you have no basis for. confidence 0.0-1.0.`;

// Standalone scrap check: metal content and today's value, no photos and no full appraisal.
export async function meltCheck(env, { name = "", maker = "", period = "", description = "", markings = "" }) {
  const c = cfg(env);
  if (!c.key) throw new Error("NEBIUS_API_KEY is not set");
  const spot = await metalPrices();
  if (!spot) return { melt: null, error: "live metal prices unavailable" };
  const m = await meltEstimate(c, { name, maker, period }, { description, markings }, []);
  if (!m || !spot[m.metal]) return { melt: null, spot };
  return {
    melt: {
      metal: m.metal, fine_troy_oz: Math.round(m.fine_troy_oz * 1000) / 1000,
      price_per_oz: spot[m.metal], value: Math.round(m.fine_troy_oz * spot[m.metal]),
      basis: m.basis, confidence: m.confidence, as_of: spot.as_of, source: spot.source,
    },
    spot,
  };
}

async function meltEstimate(c, ident, req, findings) {
  const desc = [
    `Item: ${ident.name}`,
    ident.maker ? `Maker: ${ident.maker}` : "",
    ident.period ? `Period: ${ident.period}` : "",
    `Dealer description: ${String(req.description || "").trim() || "(none)"}`,
    `Dealer markings: ${String(req.markings || "").trim() || "(none)"}`,
    `Vision notes: ${findings.map(f => [f.object_type, ...(f.materials || []), ...(f.notable_features || [])].filter(Boolean).join("; ")).filter(Boolean).join(" | ").slice(0, 600)}`,
  ].filter(Boolean).join("\n");
  const r = await textJson(c, METAL_SYSTEM, desc, 800);
  const metal = String(r.metal || "none").toLowerCase();
  const oz = num(r.fine_troy_oz);
  if (!METAL_SYMBOL[metal] || !(oz > 0)) return null;
  return { metal, fine_troy_oz: oz, basis: String(r.basis || ""), confidence: clamp(r.confidence ?? 0.5) };
}

// ---------- the pipeline ----------
export async function appraise(env, req) {
  const c = cfg(env);
  if (!c.key) throw new Error("NEBIUS_API_KEY is not set");
  const currency = req.currency || "USD";
  const warnings = [];

  const findings = await mapLimit(req.photos, 3, p => photoFindings(c, p.kind, p.url));
  if (findings.every(f => f.error)) warnings.push("vision model failed on every photo; appraisal relies on dealer text only");

  // Give the reasoner today's metal prices up front so its own number starts from reality.
  const spot = await metalPrices();
  const spotSheet = spot
    ? `\n\n## Today's metal prices (${spot.source}, ${spot.as_of.slice(0, 10)})\n` +
      Object.keys(METAL_SYMBOL).filter(k => spot[k]).map(k => `${k}: $${spot[k].toFixed(2)} per troy ounce`).join("\n") +
      `\nIf this item is precious metal, price it from THESE numbers. Do not use a remembered spot price.`
    : "";

  // Settle the lot question before the model sees anything, so every price in the pipeline —
  // the first pass, the comps re-pricing — means the same thing: one piece. Comparables are
  // per-piece listings anyway, so this is also the frame the evidence is already in.
  const lotInfo = detectLot(req.description, req.markings);
  const lotSheet = lotInfo
    ? `\n\n## This is a lot of ${lotInfo.count}\nThe dealer's text describes ${lotInfo.count} identical ` +
      `pieces (${lotInfo.how}). Price ONE PIECE in price_range, not the lot. Do NOT multiply by ` +
      `${lotInfo.count} — that is done afterwards, outside your answer. Comparable listings are ` +
      `per-piece prices, so compare like with like.`
    : "";

  const sheet = buildEvidenceSheet(req, findings) + spotSheet + lotSheet;
  const user = `${sheet}\n\n## Required output schema\n${IDENTIFY_SCHEMA}`;
  let first = await textJson(c, IDENTIFY_SYSTEM(currency), user);
  if (incomplete(first)) {
    const nudge = user + "\n\nYour previous answer left price_range, evidence or confidence empty or zero. " +
      "Answer again with EVERY field filled with your best estimate. Prices must be non-zero dollars.";
    try {
      const second = await textJson(c, IDENTIFY_SYSTEM(currency), nudge);
      if (!incomplete(second) || score(second) > score(first)) first = second;
    } catch (e) { warnings.push(`retry failed: ${e.message}`); }
  }

  const ident = { name: "", category: "", maker: "", origin: "", period: "", style: "",
                  ...pick(first.identification || {}, IDENT_KEYS) };
  for (const k of IDENT_KEYS) ident[k] = String(ident[k] || "");
  if (!ident.name.trim()) ident.name = (findings.find(f => f.object_type) || {}).object_type || "Unidentified item";
  // The model's own name is kept for searching even when the dealer's wording wins the display.
  // "256 gb total" is what the dealer typed; "SK Hynix 32GB DDR4-2400 ECC RDIMM" is what finds comps.
  let searchName = ident.name;
  let idConflict = null;
  if (ignoresDealer(ident.name, req.description)) {
    // ignoresDealer means the model's name shares NOT ONE significant word with what the dealer
    // wrote. That covers two very different situations, and the difference is how much the dealer
    // actually said. Against "256 gb total" the model's "SK Hynix 32GB DDR4-2400 ECC RDIMM" is the
    // same object described better, and it is the far better search term. Against "WWII silver
    // Jefferson nickels, 4 rolls" the model's "Reloaded Federal 12 Gauge Shotshells" is a
    // different object — it misread the photographs — and searching its name returned four
    // shotgun-ammo listings for a box of coins. The dealer is holding the thing; when they have
    // described it in substance, their words win the search too, not just the display.
    const said = words(dealerName(req.description));
    idConflict = { model: ident.name, dealer: dealerName(req.description) };
    warnings.push(`model named it '${ident.name}'; using the dealer's description for the name instead`);
    ident.name = dealerName(req.description);
    if (said.size >= 3) {
      // The dealer's words, reduced to a search term. Handing over the raw sentence is what
      // produced "United States Mint These" and a page of postage stamps.
      searchName = searchPhrase(ident.name);
      warnings.push(`the model's identification did not match your description, so comparables were ` +
        `searched using your words rather than its own — check the item name is right.`);
    }
  }
  // A low-confidence identification is the most expensive thing this tool produces, because the
  // melt check and the comps search both price whatever the identification says the item is. Five
  // runs on one out-of-focus photograph gave five different items and prices from $260 to $850 on
  // the same lot. When the model is unsure, the dealer should know before the number persuades
  // them, and should be told what would fix it.
  const conf = clamp(first.confidence ?? 0.5);
  if (conf < 0.55) {
    const ask = clean(strs(first.questions_for_dealer))[0];
    warnings.push(`the identification is uncertain (confidence ${Math.round(conf * 100)}%), and everything ` +
      `below is priced as if it were right. ${ask ? ask.replace(/\?$/, "") + " — that would settle it." :
      "A sharper photo of the marks, or a line about what it is, would settle it."}`);
  }

  if (String(req.markings || "").trim() && !ident.maker.trim()) {
    const maker = makerFromMarks(req.markings);
    if (maker) ident.maker = maker;
  }

  let price = priceOf(first.price_range, currency);
  const rawListing = first.listing || {};
  const listing = { title: "", description: "", tags: [], condition_grade: "", ...pick(rawListing, LISTING_KEYS) };
  listing.title = String(listing.title || "") || ident.name;
  listing.description = String(listing.description || "");
  listing.tags = strs(listing.tags);
  listing.condition_grade = grade(listing.condition_grade);

  if (price.high <= 0) {
    try {
      const u = `Item: ${ident.name}\nMaker: ${ident.maker || "unknown"}\nOrigin: ${ident.origin || "unknown"}\n` +
                `Period: ${ident.period || "unknown"}\nCondition: ${listing.condition_grade || "Good"}\nCurrency: ${currency}\n` +
                `Typical secondary-market dealer retail price range in whole dollars?`;
      const p2 = priceOf(await textJson(c, PRICE_SYSTEM, u, 300), currency);
      if (p2.high > 0) { price = p2; warnings.push("price came from a second, pricing-only pass"); }
    } catch {}
  }
  if (price.high <= 0) warnings.push("model returned no price; enter one by hand or re-run");
  const cleanedBasis = clean([price.basis]);
  price.basis = cleanedBasis.length ? cleanedBasis[0] : price.basis;

  const comparables = [];
  let rejected = [];
  const q = compsQuery({ ...ident, name: searchName });
  // eBay first: it is the only live, free, permitted price feed we have. Tavily backfills the
  // categories eBay is thin on, and covers us entirely when no eBay keys are configured.
  const live = await ebayActive(env, q);
  const hits = [...(live || []), ...(live && live.length >= 3 ? [] : await searchComps(env, q))];
  // Only the Browse API produces a market range. See the note above searchComps for why search
  // hits do not get one.
  const market = (live && live.length) ? summarise(live) : null;
  // What the dealer is shown. Narrowed to the listings the model judged comparable once it has
  // said which those are; until then it is the whole pool.
  let marketShown = market;
  // Keys configured but no listings back means the feed is broken, not that eBay is empty.
  const ebayWhy = ebayFailure();
  if (ebayWhy && ebayWhy !== "no eBay API keys are configured")
    warnings.push(`LIVE EBAY PRICES UNAVAILABLE — ${ebayWhy}. Today's asking prices did not reach ` +
      `this appraisal, so treat the number below as an estimate rather than the market.`);
  // Nothing matched the exact description, so these prices are for the nearest comparable thing.
  // The dealer should know that before trusting the range on a piece with unusual markings.
  const broadenedTo = ebayBroadenedTo();
  if (market && broadenedTo)
    warnings.push(`no eBay listing matched the full description, so these prices are for ` +
      `"${broadenedTo}" — comparable items rather than this exact one.`);
  if (hits.length) {
    const repriceUser = `Item: ${JSON.stringify(ident)}\nCondition: ${listing.condition_grade}\n` +
      `Current price_range: ${JSON.stringify(price)}\n` +
      (lotInfo ? `\nThis is a lot of ${lotInfo.count} identical pieces, and price_range is the price ` +
        `of ONE PIECE. Keep it that way. The comparables below are per-piece listings, so they are ` +
        `directly comparable. Do NOT multiply by ${lotInfo.count}.\n` : "") +
      (market ? `\nLIVE eBay asking prices right now: ${market.count} listed, ` +
        `$${market.low}-$${market.high}, median $${market.median}. These are ASKING prices, not sold ` +
        `prices, so they run high — but they are today's market, and your own estimate is a memory. ` +
        `If your range sits well below these, raise it.\n` : "") +
      `\nComparables:\n${JSON.stringify(hits, null, 1)}`;
    try {
      const second = await textJson(c, REPRICE_SYSTEM, repriceUser, 1000);
      if (second.price_range) price = priceOf(second.price_range, currency);
      if (second.basis_note) price.basis = (price.basis + " " + String(second.basis_note)).trim();
      for (const cp of (second.comparables || []).slice(0, 4))
        if (cp && typeof cp === "object" && cp.title) comparables.push(pick(cp, COMP_KEYS));

      // The model has always been free to discard comparables — "keep at most 4 that are actually
      // similar" is a judgement call it makes on every appraisal — but until now it made it
      // silently. The deterministic filters above catch mechanical contradictions: a 3 gallon crock
      // answering a 5 gallon query, a knob answering a radio. They cannot catch a Riviera plate
      // answering a Fiesta query, or a divided plate standing in for a dinner plate, and no regex
      // will. That judgement belongs to the model. What does NOT belong to it is making that
      // judgement where nobody can see it: a model that quietly drops the one honest comp and
      // prices from three wrong ones is the exact failure this tool spent two days removing from
      // the search layer. So the reasons are recorded, and when most of the pool goes, the dealer
      // is told rather than shown a confident number built on what survived.
      rejected = (second.rejected || [])
        .filter(r => r && typeof r === "object" && r.title)
        .map(r => ({ title: String(r.title).slice(0, 160), why: String(r.why || "").slice(0, 200) }));
      if (rejected.length) console.log("repricer rejected", JSON.stringify(rejected));
      if (hits.length >= 4 && comparables.length && rejected.length >= hits.length - 1)
        warnings.push(`only ${comparables.length} of the ${hits.length} listings found were judged ` +
          `comparable — the rest were set aside as different items (${rejected.slice(0, 3).map(r => r.why).filter(Boolean).join("; ")}). ` +
          `A price built on ${comparables.length} listing${comparables.length === 1 ? "" : "s"} is thinner than the count suggests.`);
    } catch (e) { warnings.push(`comps re-pricing failed: ${e.message}`); }

    // The market line is built from every live listing, because the model needs the whole pool in
    // front of it before it can judge any of it. But what the dealer READS has to agree with the
    // price printed beside it. On a 4-roll lot of war nickels the pool was $90-$730 median $159 —
    // mostly single rolls — sitting under a $643 price. A dealer seeing that reasonably concludes
    // the price is wrong. Once the model has said which listings are the same item, the headline
    // is rebuilt from those.
    const kept = keptLive(live, comparables);
    if (kept.length) marketShown = summarise(kept);
    else if (!comparables.length && rejected.length) marketShown = null;
    if (market && !marketShown)
      warnings.push(`all ${market.count} eBay listings found were judged to be different items, so ` +
        `there is no live price range for this one — the estimate is not anchored to today's market.`);
    // Relevant listings with no numbers on them cannot correct anything. Search returns page
    // descriptions, and a marketplace's description often names the item without ever quoting a
    // price — so the re-pricer reads four genuinely comparable listings, finds nothing to price
    // against, and keeps its own guess. Three production runs on a 256GB RDIMM kit all said as
    // much in their own basis and all came in at a third of what the box actually sold for.
    // The dealer sees "4 comparables" and reasonably assumes the price was checked against them.
    if (!hits.some(h => h.price > 0))
      warnings.push(`${hits.length} similar listing${hits.length === 1 ? " was" : "s were"} found but ` +
        `none showed a price, so this estimate is still the model's own — the listings confirm what ` +
        `the item is, not what it sells for.`);
  } else {
    // This is the dangerous state, not a footnote: with no comps the number is the model's
    // recollection of a market it last saw during training. Fine for a Victorian jug, ruinous
    // for anything whose price has moved — memory, tools, bullion, anything with a spot market.
    // Say which of the two things happened. "Nothing is listed" is a fact about the item;
    // "our search is broken" is a fact about us, and the dealer is owed the difference.
    const why = searchFailure();
    warnings.push(why
      ? `MARKET SEARCH IS NOT WORKING — ${why}. This price is the model's best guess from memory, ` +
        `not today's market, and that is our fault rather than a quiet market. Do not rely on it.`
      : "NO LIVE COMPARABLES FOUND — this price is the model's best guess from memory, " +
        "not today's market. Check it yourself before you sell, especially for electronics, metals " +
        "or anything sold by the unit.");
    price.basis = (price.basis + (why
      ? ` Market search was unavailable (${why}), so this is a memory-based estimate.`
      : " No live comparables were found, so this is a memory-based estimate.")).trim();
  }
  // Everything above priced ONE piece. Multiply here, where it is arithmetic rather than opinion.
  // "$960 the box" and "$150 a stick" are different conversations and the dealer needs both.
  let lot = null;
  if (lotInfo && price.high > 0) {
    const n = lotInfo.count;
    const unit = { low: price.low, high: price.high, retail: price.suggested_retail, floor: price.floor };
    // If the model ignored the instruction and priced the whole lot anyway, multiplying would
    // overstate by a factor of n. Per-piece comparables are the check: a unit price several times
    // the dearest comparable is not a unit price. Better to leave it alone and say so than to
    // silently multiply a number that already includes the multiplication.
    const compPrices = hits.map(h => h.price).filter(p => p > 0);
    const ceiling = compPrices.length ? Math.max(...compPrices) * 3 : Infinity;
    if (unit.retail > ceiling) {
      warnings.push(`this looks like a lot of ${n}, but the per-piece price came back at ` +
        `$${Math.round(unit.retail)} against comparables topping out at $${Math.round(Math.max(...compPrices))} — ` +
        `the model may have priced the whole lot, so it has been left as-is rather than multiplied. Check it.`);
    } else {
      price = {
        low: Math.round(unit.low * n),
        high: Math.round(unit.high * n),
        suggested_retail: Math.round(unit.retail * n),
        floor: Math.round(unit.floor * n),
        currency,
        basis: `$${Math.round(unit.retail)} per piece × ${n} = $${Math.round(unit.retail * n)} ` +
               `(${lotInfo.how}). ${price.basis}`.trim(),
      };
      lot = {
        count: n, how: lotInfo.how,
        unit_low: Math.round(unit.low), unit_high: Math.round(unit.high),
        unit_retail: Math.round(unit.retail),
      };
    }
  }

  // Melt floor, last, so the comps re-pricer cannot undo it. Scrap value is arithmetic, not opinion:
  // whatever the piece is worth as an antique, it is worth at least its metal.
  let melt = null;
  if (spot) {
    try {
      const m = await meltEstimate(c, ident, req, findings);
      if (m && spot[m.metal]) {
        const value = m.fine_troy_oz * spot[m.metal];
        melt = {
          metal: m.metal, fine_troy_oz: Math.round(m.fine_troy_oz * 1000) / 1000,
          price_per_oz: spot[m.metal], value: Math.round(value),
          basis: m.basis, as_of: spot.as_of, source: spot.source,
        };
        // Only a weight the model actually established gets to move the price. A guessed weight is
        // still shown to the dealer, but it must not silently become a floor.
        melt.applied = m.confidence >= 0.7;
        if (!melt.applied) warnings.push(`metal content is an estimate (confidence ${m.confidence}); shown but not used as a floor`);
        if (melt.applied && value > price.low) {
          const was = `$${Math.round(price.low)}-${Math.round(price.high)}`;
          price.low = Math.round(value);
          price.high = Math.max(Math.round(price.high), Math.round(value * 1.2));
          price.floor = Math.max(Math.round(price.floor), Math.round(value));
          price.suggested_retail = Math.min(Math.max(price.suggested_retail, Math.round(value * 1.1)), price.high);
          price.basis = (`Raised to metal content: ${melt.fine_troy_oz} ozt ${m.metal} at $${spot[m.metal].toFixed(2)}/ozt = $${melt.value} melt. ` + price.basis).trim();
          warnings.push(`price raised to melt value ($${melt.value}); the model's own estimate was ${was}`);
        }
      }
    } catch (e) { warnings.push(`melt check failed: ${e.message}`); }
  } else {
    warnings.push("live metal prices unavailable; no melt floor applied");
  }

  // The per-piece figures were worked out from the price BEFORE the melt floor was applied, and
  // the floor moves the lot total without moving them. On a 4-roll lot of war nickels that put
  // "$68 each × 4 pieces" on the card directly above "4 comparables at $125-$135" — two numbers
  // that cannot both be true, sitting an inch apart. The floor is arithmetic on the whole lot, so
  // it divides back down the same way.
  if (lot && lot.count > 1 && price.suggested_retail > 0) {
    const before = lot.unit_retail;
    lot.unit_low = Math.round(price.low / lot.count);
    lot.unit_high = Math.round(price.high / lot.count);
    lot.unit_retail = Math.round(price.suggested_retail / lot.count);
    if (before && lot.unit_retail >= before * 1.5)
      warnings.push(`per-piece price raised from $${before} to $${lot.unit_retail} so the ${lot.count} ` +
        `pieces add up to the lot total above.`);
  }

  // A statement of fact the dealer can check, rather than an opinion they have to trust.
  if (marketShown) {
    const m = marketShown;
    price.basis = (price.basis + (m.count === 1
      ? ` One comparable listed on eBay right now at $${m.low} — an asking price, not a sale.`
      : ` ${m.count} comparable${m.count === 1 ? "" : "s"} listed on eBay right now at ` +
        `$${m.low}-$${m.high} (median $${m.median}) — asking prices, not sold.`)).trim();
  }

  return {
    melt,
    lot,
    // The identification gate. A dealer reads the digits and skips the warning above them, so a
    // number carrying a caveat is worse than no number at all: run 4 of the nickel lot printed
    // "$260, low confidence" and $260 is what a dealer would have taken, for silver worth $585.
    //
    // The gate keys on disagreement with the DEALER, not on agreement between melt and comps.
    // Those two are not independent evidence — the comps query is built from the identification,
    // so a wrong name produces a search that produces a pool agreeing with the wrong name. The
    // numbers prove it: run 4, the disaster, had melt $260 against a comps median of $289 and
    // would have passed any coherence check; run 2, which was correct, had melt $585 against a
    // comps median of $159 and would have failed one. Coherence scoring inverts on both. The
    // dealer's own words are the only signal here that is not downstream of the identification,
    // because they are holding the object.
    needs_clarification: (idConflict || clamp(first.confidence ?? 0.5) < 0.55) ? {
      reason: idConflict
        ? "your description and the photographs disagree about what this is"
        : `the photographs do not settle what this is (${Math.round(clamp(first.confidence ?? 0.5) * 100)}% confident)`,
      candidates: idConflict ? [idConflict.model, idConflict.dealer] : null,
      question: clean(strs(first.questions_for_dealer))[0] ||
        "What is it, in a few words — and is there any writing or stamp on it?",
    } : null,
    // The judged market is the headline; the unjudged pool stays available rather than being
    // thrown away, so nothing is hidden from a dealer who wants to see everything eBay returned.
    market: marketShown,
    market_all: market && marketShown && market.count !== marketShown.count ? market : null,
    // What the model set aside and why. A dealer who disagrees with a price should be able to see
    // which listings were kept out of it — including the ones it was wrong to exclude.
    rejected_comparables: rejected.slice(0, 8),
    // Comparable listings first: the ones the price actually rests on.
    live_listings: (() => {
      const k = keptLive(live, comparables);
      const ku = new Set(k.map(l => l.url));
      return [...k, ...(live || []).filter(l => !ku.has(l.url))].slice(0, 6);
    })(),
    item_id: req.item_id,
    identification: ident,
    confidence: clamp(first.confidence ?? 0.5),
    evidence: clean(strs(first.evidence)),
    transcribed_text: dedupe([
      ...clean(strs(first.transcribed_text)),
      ...findings.flatMap(f => f.transcribed_text || []),
      ...(String(req.markings || "").trim() ? [String(req.markings).trim()] : []),
    ]),
    price_range: price,
    comparables,
    listing,
    questions_for_dealer: clean(strs(first.questions_for_dealer)),
    photo_findings: findings,
    models: { text: c.text, vision: c.vision, brain: "worker" },
    warnings,
  };
}
