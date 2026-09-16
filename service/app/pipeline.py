"""Appraisal pipeline:
  1. every photo -> vision model (parallel)   : per-shot findings + transcribed text
  2. merge findings + dealer description/markings -> evidence sheet
  3. Nemotron -> identification, evidence, price range, listing draft (JSON)
  4. comps search on the identified name -> Nemotron re-prices with comps (if any)
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from .comps import search_comps
from .nebius import Nebius
from .schemas import (Appraisal, AppraiseRequest, Comparable, Identification, Listing, PhotoFindings,
                      PriceRange)

log = logging.getLogger("appraiser.pipeline")

VISION_PROMPT = """You are an antiques cataloguer examining ONE photograph labelled "{kind}" of an item for sale.
Return ONLY a JSON object with these keys:
{{
 "object_type": "short noun phrase (e.g. 'oak side chair', 'stoneware crock', 'brass carriage clock')",
 "materials": ["..."],
 "construction": ["joinery, manufacturing or finishing clues you can actually see"],
 "condition": ["wear, repairs, damage, patina you can actually see"],
 "transcribed_text": ["every word, number, stamp, signature, label or mark visible, verbatim; [] if none"],
 "notable_features": ["style cues, hardware, decoration, dimensions if a ruler/reference is visible"]
}}
Be literal and specific. Do not guess maker or date here - only report what is visible.
Keep it short: at most 4 items per list, each item under 12 words. No prose outside the JSON."""

IDENTIFY_SYSTEM = """You are a senior antiques appraiser writing for an independent antique dealer.
You reason from EVIDENCE: photo findings from a vision model, the dealer's own description, and any
markings the dealer transcribed by hand (treat dealer markings as more reliable than OCR).
Give a confident identification when the evidence supports it, and an honest confidence when it does not.
Prices are realistic secondary-market dealer prices in {currency} for the stated condition, not insurance values.
Always return ONLY one JSON object matching the schema you are given. No prose outside the JSON."""

# Template is deliberately placeholder-free: small edge models copy hint strings back as values.
IDENTIFY_SCHEMA = """{
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

EXAMPLE of a filled answer for a different item (format only):
{"identification":{"name":"Red Wing 3-gallon stoneware crock","category":"Stoneware","maker":"Red Wing Union Stoneware Co.","origin":"Red Wing, Minnesota, USA","period":"c. 1915-1930","style":"Utilitarian salt-glaze"},"confidence":0.85,"evidence":["Red Wing oval stamp on face - factory-marked, post-1906 union period","Cobalt '3' capacity mark matches 3-gallon body size"],"transcribed_text":["RED WING UNION STONEWARE CO.","3"],"price_range":{"low":90,"high":160,"suggested_retail":135,"floor":90,"currency":"USD","basis":"Common marked Red Wing size; hairline would drop it to the low end."},"listing":{"title":"Red Wing 3-Gallon Stoneware Crock, Union Stoneware Co., c. 1920","description":"A classic Red Wing 3-gallon crock with the oval Union Stoneware stamp and a cobalt 3. Sturdy salt-glazed body with the warm patina these pieces earn in a century of farmhouse use.\n\nRim and base are sound. A handsome piece for a kitchen counter, utensil storage or a farmhouse display.","tags":["red wing","stoneware","crock","farmhouse"],"condition_grade":"Very good"},"questions_for_dealer":["Any hairlines or chips on the rim or base?"]}"""

OCR_PROMPT = """Transcribe ALL text visible in this photo: stamps, impressed marks, cobalt numbers, labels, signatures,
model numbers, hand-written notes. Return ONLY JSON: {"text": ["each distinct line or mark, verbatim"]}.
If there is truly no text, return {"text": []}."""

REPRICE_SYSTEM = """You are a senior antiques appraiser. You previously appraised an item; now you have live
comparable listings from the web. Comparables may be irrelevant or asking (not sold) prices - weigh them
accordingly. Return ONLY a JSON object: {"price_range": {...same shape...}, "comparables": [{"title","price","url","source","note"}],
"basis_note": "one sentence"}. Keep at most 4 comparables that are actually similar."""


async def _safe_vision(nb: Nebius, prompt: str, data_url: str, max_tokens: int, label: str) -> dict[str, Any] | None:
    """One vision call with a single retry; None on failure. Small VLMs occasionally emit truncated JSON."""
    last: Exception | None = None
    for attempt in (1, 2):
        try:
            return await nb.vision_json(prompt, [data_url], max_tokens=max_tokens)
        except Exception as e:  # noqa: BLE001
            last = e
            log.info("%s pass attempt %d failed: %s", label, attempt, e)
    log.warning("%s pass failed: %s", label, last)
    return None


async def _photo_findings(nb: Nebius, kind: str, data_url: str) -> PhotoFindings:
    """Two passes per photo: a cataloguing pass and a dedicated OCR pass (small VLMs miss stamps otherwise).
    Cloud brains run them concurrently; an edge GPU serialises anyway, and concurrency there made the
    3B model truncate its JSON, so edge runs them one after the other."""
    if getattr(nb, "kind", "cloud") == "edge":
        raw = await _safe_vision(nb, VISION_PROMPT.format(kind=kind), data_url, 900, "findings")
        ocr = await _safe_vision(nb, OCR_PROMPT, data_url, 300, "ocr")
    else:
        raw, ocr = await asyncio.gather(
            _safe_vision(nb, VISION_PROMPT.format(kind=kind), data_url, 900, "findings"),
            _safe_vision(nb, OCR_PROMPT, data_url, 300, "ocr"),
        )
    if raw is None and ocr is None:
        return PhotoFindings(kind=kind, error="vision model returned no usable output (both passes failed)")
    raw = raw or {}
    ocr_text = _strs((ocr or {}).get("text"))
    return PhotoFindings(
        kind=kind,
        object_type=str(raw.get("object_type", "")),
        materials=_strs(raw.get("materials")),
        construction=_strs(raw.get("construction")),
        condition=_strs(raw.get("condition")),
        transcribed_text=_dedupe(_strs(raw.get("transcribed_text")) + ocr_text),
        notable_features=_strs(raw.get("notable_features")),
        raw=raw | {"ocr": ocr_text},
    )


def _dedupe(xs: list[str]) -> list[str]:
    seen, out = set(), []
    for x in xs:
        k = " ".join(x.upper().split())
        if k and k not in seen:
            seen.add(k)
            out.append(x.strip())
    return out


# Hint strings small models are known to echo back; drop them if they show up as values.
_ECHOES = ("one sentence on how you priced", "consolidated, de-duplicated", "the specific observation and what it implies",
           "short bullet", "2-3 paragraphs", "<= 80 chars", "one or two things")


def _clean(xs: list[str]) -> list[str]:
    return [x for x in xs if not any(e in x.lower() for e in _ECHOES)]


def _strs(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v] if v.strip() else []
    return [str(x) for x in v if str(x).strip()]


def build_evidence_sheet(req: AppraiseRequest, findings: list[PhotoFindings]) -> str:
    lines = ["# Evidence sheet"]
    lines.append(f"Photos supplied: {len(req.photos)} ({', '.join(p.kind for p in req.photos)})")
    lines.append("\n## Dealer description\n" + (req.description.strip() or "(none given)"))
    lines.append("\n## Dealer-transcribed markings (high reliability)\n" + (req.markings.strip() or "(none given)"))
    lines.append("\n## Vision findings per photo")
    for f in findings:
        lines.append(f"\n### Photo: {f.kind}")
        if f.error:
            lines.append(f"(vision model failed: {f.error})")
            continue
        lines.append(f"object_type: {f.object_type}")
        for key in ("materials", "construction", "condition", "transcribed_text", "notable_features"):
            vals = getattr(f, key)
            if vals:
                lines.append(f"{key}: " + "; ".join(vals))
    return "\n".join(lines)


async def appraise(nb: Nebius, req: AppraiseRequest, resolve_photo) -> Appraisal:
    """`resolve_photo(url) -> data_url` turns http(s) URLs or data URLs into base64 data URLs."""
    warnings: list[str] = []
    data_urls = await asyncio.gather(*(resolve_photo(p.url) for p in req.photos))
    findings = await asyncio.gather(*(_photo_findings(nb, p.kind, d) for p, d in zip(req.photos, data_urls)))
    findings = list(findings)
    if all(f.error for f in findings):
        warnings.append("vision model failed on every photo; appraisal relies on dealer text only")

    sheet = build_evidence_sheet(req, findings)
    user = f"{sheet}\n\n## Required output schema\n{IDENTIFY_SCHEMA}"
    first = await nb.text_json(IDENTIFY_SYSTEM.format(currency=req.currency), user)
    if _incomplete(first):
        # small edge models sometimes stop early or leave the numbers at 0 — one nudge usually fixes it
        log.info("reasoner answer incomplete; retrying with a fill-every-field nudge")
        nudge = (user + "\n\nYour previous answer left price_range, evidence or confidence empty or zero. "
                 "Answer again with EVERY field filled with your best estimate. Prices must be non-zero dollars.")
        try:
            second = await nb.text_json(IDENTIFY_SYSTEM.format(currency=req.currency), nudge)
            if not _incomplete(second) or _score(second) > _score(first):
                first = second
        except Exception as e:  # noqa: BLE001
            warnings.append(f"retry failed: {e}")

    ident = Identification(**_pick(first.get("identification", {}), Identification))
    if not ident.name.strip():
        # tiny edge models sometimes leave name blank — fall back to what the vision pass saw
        ident.name = next((f.object_type for f in findings if f.object_type), "Unidentified item")
    price = _price(first.get("price_range", {}), req.currency)
    if price.high <= 0:
        warnings.append("model returned no price; enter one by hand or re-run with the cloud brain")
    price.basis = _clean([price.basis])[0] if _clean([price.basis]) else price.basis
    listing = Listing(**_pick(first.get("listing", {}) | {"title": first.get("listing", {}).get("title") or ident.name,
                                                          "description": first.get("listing", {}).get("description") or ""},
                              Listing))
    listing.condition_grade = _grade(listing.condition_grade)
    comparables: list[Comparable] = []

    query = " ".join(x for x in (ident.maker, ident.name, ident.period) if x).strip() or ident.name
    hits = await search_comps(query)
    if hits:
        reprice_user = (
            f"Item: {json.dumps(ident.model_dump())}\nCondition: {listing.condition_grade}\n"
            f"Current price_range: {json.dumps(price.model_dump())}\n\nComparables:\n{json.dumps(hits, indent=1)}"
        )
        try:
            second = await nb.text_json(REPRICE_SYSTEM, reprice_user, max_tokens=1000)
            price = _price(second.get("price_range", {}), req.currency) if second.get("price_range") else price
            if second.get("basis_note"):
                price.basis = (price.basis + " " + str(second["basis_note"])).strip()
            for c in second.get("comparables", [])[:4]:
                if isinstance(c, dict) and c.get("title"):
                    comparables.append(Comparable(**_pick(c, Comparable)))
        except Exception as e:  # noqa: BLE001
            warnings.append(f"comps re-pricing failed: {e}")
    else:
        warnings.append("no live comparables (TAVILY_API_KEY unset or no hits); price range is model-estimated")

    return Appraisal(
        item_id=req.item_id,
        identification=ident,
        confidence=_clamp(first.get("confidence", 0.5)),
        evidence=_clean(_strs(first.get("evidence"))),
        transcribed_text=_dedupe(_clean(_strs(first.get("transcribed_text")))
                                 + [t for f in findings for t in f.transcribed_text]
                                 + ([req.markings.strip()] if req.markings.strip() else [])),
        price_range=price,
        comparables=comparables,
        listing=listing,
        questions_for_dealer=_clean(_strs(first.get("questions_for_dealer"))),
        photo_findings=findings,
        models={"text": nb.text_model, "vision": nb.vision_model, "brain": getattr(nb, "kind", "cloud")},
        warnings=warnings,
    )


def _score(d: dict[str, Any]) -> int:
    """How filled-in a reasoner answer is (used to pick the better of two attempts)."""
    pr = d.get("price_range") or {}
    return sum([
        _num(pr.get("high")) > 0, _num(d.get("confidence")) > 0, bool(_strs(d.get("evidence"))),
        bool((d.get("listing") or {}).get("description")), bool((d.get("identification") or {}).get("name")),
    ])


def _incomplete(d: dict[str, Any]) -> bool:
    pr = d.get("price_range") or {}
    return _num(pr.get("high")) <= 0 or not _strs(d.get("evidence")) or _num(d.get("confidence")) <= 0


def _pick(d: dict[str, Any], model) -> dict[str, Any]:
    fields = model.model_fields
    out = {}
    for k, v in (d or {}).items():
        if k in fields and v is not None:
            out[k] = v
    return out


def _num(v: Any, default: float = 0.0) -> float:
    try:
        return float(str(v).replace(",", "").replace("$", ""))
    except (TypeError, ValueError):
        return default


def _price(d: dict[str, Any], currency: str) -> PriceRange:
    low, high = _num(d.get("low")), _num(d.get("high"))
    if high < low:
        low, high = high, low
    mid = (low + high) / 2 if (low or high) else 0.0
    return PriceRange(
        low=low, high=high,
        suggested_retail=_num(d.get("suggested_retail"), mid) or mid,
        floor=_num(d.get("floor"), low) or low,
        currency=str(d.get("currency") or currency),
        basis=str(d.get("basis") or ""),
    )


_GRADES = ["Excellent", "Very good", "Good", "Fair", "Poor", "As-is"]


def _grade(s: str) -> str:
    """Map free-text condition to the listing enum; small models write things like 'No chips'."""
    t = (s or "").strip().lower()
    for g in _GRADES:
        if t == g.lower():
            return g
    if not t:
        return ""
    if any(w in t for w in ("mint", "excellent", "pristine")):
        return "Excellent"
    if any(w in t for w in ("very good", "no chips", "no damage", "no repairs", "sound", "clean")):
        return "Very good"
    if any(w in t for w in ("as-is", "as is", "damaged", "broken", "parts")):
        return "As-is"
    if any(w in t for w in ("poor", "heavy", "major")):
        return "Poor"
    if any(w in t for w in ("fair", "chip", "crack", "repair", "hairline", "loss")):
        return "Fair"
    return "Good"


def _clamp(v: Any) -> float:
    x = _num(v, 0.5)
    if x > 1:
        x = x / 100 if x <= 100 else 1.0
    return max(0.0, min(1.0, x))
