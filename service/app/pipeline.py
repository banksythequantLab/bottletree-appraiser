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
Be literal and specific. Do not guess maker or date here - only report what is visible."""

IDENTIFY_SYSTEM = """You are a senior antiques appraiser writing for an independent antique dealer.
You reason from EVIDENCE: photo findings from a vision model, the dealer's own description, and any
markings the dealer transcribed by hand (treat dealer markings as more reliable than OCR).
Give a confident identification when the evidence supports it, and an honest confidence when it does not.
Prices are realistic secondary-market dealer prices in {currency} for the stated condition, not insurance values.
Always return ONLY one JSON object matching the schema you are given. No prose outside the JSON."""

IDENTIFY_SCHEMA = """{
 "identification": {"name": "", "category": "", "maker": "", "origin": "", "period": "", "style": ""},
 "confidence": 0.0,
 "evidence": ["short bullet: the specific observation and what it implies"],
 "transcribed_text": ["consolidated, de-duplicated marks/text"],
 "price_range": {"low": 0, "high": 0, "suggested_retail": 0, "floor": 0, "currency": "USD",
                 "basis": "one sentence on how you priced it"},
 "listing": {"title": "<= 80 chars, searchable, maker/period/type", "description": "2-3 paragraphs for a shop website",
             "tags": ["..."], "condition_grade": "Excellent | Very good | Good | Fair | Poor | As-is"},
 "questions_for_dealer": ["one or two things that would most change the appraisal if known"]
}"""

REPRICE_SYSTEM = """You are a senior antiques appraiser. You previously appraised an item; now you have live
comparable listings from the web. Comparables may be irrelevant or asking (not sold) prices - weigh them
accordingly. Return ONLY a JSON object: {"price_range": {...same shape...}, "comparables": [{"title","price","url","source","note"}],
"basis_note": "one sentence"}. Keep at most 4 comparables that are actually similar."""


async def _photo_findings(nb: Nebius, kind: str, data_url: str) -> PhotoFindings:
    try:
        raw = await nb.vision_json(VISION_PROMPT.format(kind=kind), [data_url])
        return PhotoFindings(
            kind=kind,
            object_type=str(raw.get("object_type", "")),
            materials=_strs(raw.get("materials")),
            construction=_strs(raw.get("construction")),
            condition=_strs(raw.get("condition")),
            transcribed_text=_strs(raw.get("transcribed_text")),
            notable_features=_strs(raw.get("notable_features")),
            raw=raw,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("vision failed for %s photo: %s", kind, e)
        return PhotoFindings(kind=kind, error=str(e))


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

    ident = Identification(**_pick(first.get("identification", {}), Identification))
    price = _price(first.get("price_range", {}), req.currency)
    listing = Listing(**_pick(first.get("listing", {}) | {"title": first.get("listing", {}).get("title") or ident.name,
                                                          "description": first.get("listing", {}).get("description") or ""},
                              Listing))
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
        evidence=_strs(first.get("evidence")),
        transcribed_text=_strs(first.get("transcribed_text")) or sorted({t for f in findings for t in f.transcribed_text}),
        price_range=price,
        comparables=comparables,
        listing=listing,
        questions_for_dealer=_strs(first.get("questions_for_dealer")),
        photo_findings=findings,
        models={"text": nb.text_model, "vision": nb.vision_model},
        warnings=warnings,
    )


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


def _clamp(v: Any) -> float:
    x = _num(v, 0.5)
    if x > 1:
        x = x / 100 if x <= 100 else 1.0
    return max(0.0, min(1.0, x))
