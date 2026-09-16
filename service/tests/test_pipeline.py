"""Pipeline tests with a fake Nebius client — no network, no key."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import pipeline
from app.nebius import extract_json
from app.schemas import AppraiseRequest, PhotoIn


class FakeNebius:
    text_model = "nvidia/nemotron-3-super-120b-a12b"
    vision_model = "fake/vision"
    available: list[str] = []

    def __init__(self):
        self.vision_calls = 0
        self.text_calls: list[str] = []

    async def vision_json(self, prompt, image_data_urls, max_tokens=900):
        self.vision_calls += 1
        kind = prompt.split('labelled "')[1].split('"')[0]
        return {
            "object_type": "oak side chair",
            "materials": ["oak"],
            "construction": ["hand-cut dovetails"] if kind == "underside" else [],
            "condition": ["light wear"],
            "transcribed_text": ["STICKLEY"] if kind == "marks" else [],
            "notable_features": ["slat back"],
        }

    async def text_json(self, system, user, max_tokens=1800):
        self.text_calls.append(user)
        if "Comparables:" in user:
            return {"price_range": {"low": 400, "high": 700, "suggested_retail": 595, "floor": 400},
                    "comparables": [{"title": "Stickley chair sold", "price": 550, "url": "https://x", "source": "ebay.com"}],
                    "basis_note": "two sold comps"}
        return {
            "identification": {"name": "Stickley oak side chair", "maker": "L. & J.G. Stickley", "period": "c.1910"},
            "confidence": 0.82,
            "evidence": ["STICKLEY stamp on underside", "hand-cut dovetails"],
            "transcribed_text": ["STICKLEY"],
            "price_range": {"low": 300, "high": 600, "suggested_retail": 495, "floor": 300, "basis": "knowledge"},
            "listing": {"title": "Stickley Oak Side Chair c.1910", "description": "A fine chair.", "tags": ["stickley"],
                        "condition_grade": "Very good"},
            "questions_for_dealer": ["Any repairs?"],
        }


async def fake_resolve(url: str) -> str:
    return url


def _req(n=3):
    kinds = ["front", "underside", "marks"][:n]
    return AppraiseRequest(
        photos=[PhotoIn(url="data:image/jpeg;base64,AAAA", kind=k) for k in kinds],
        description="Old oak chair from an estate",
        markings="Stickley red decal",
        item_id="item-1",
    )


def test_appraise_runs_vision_per_photo_and_merges(monkeypatch):
    nb = FakeNebius()

    async def no_comps(q, limit=5):
        return []

    monkeypatch.setattr(pipeline, "search_comps", no_comps)
    out = asyncio.run(pipeline.appraise(nb, _req(3), fake_resolve))
    assert nb.vision_calls == 3
    assert out.identification.maker == "L. & J.G. Stickley"
    assert out.confidence == pytest.approx(0.82)
    assert out.price_range.low == 300 and out.price_range.high == 600
    assert "STICKLEY" in out.transcribed_text
    assert out.item_id == "item-1"
    assert any("no live comparables" in w for w in out.warnings)
    # evidence sheet carried the dealer markings to the reasoner
    assert "Stickley red decal" in nb.text_calls[0]


def test_appraise_reprices_with_comps(monkeypatch):
    nb = FakeNebius()

    async def comps(q, limit=5):
        return [{"title": "Stickley chair", "price": 550, "url": "https://x", "source": "ebay.com", "note": ""}]

    monkeypatch.setattr(pipeline, "search_comps", comps)
    out = asyncio.run(pipeline.appraise(nb, _req(2), fake_resolve))
    assert out.price_range.high == 700
    assert len(out.comparables) == 1 and out.comparables[0].price == 550
    assert "two sold comps" in out.price_range.basis


def test_vision_failure_is_survivable(monkeypatch):
    nb = FakeNebius()

    async def boom(prompt, urls, max_tokens=900):
        raise RuntimeError("model down")

    nb.vision_json = boom  # type: ignore[assignment]

    async def no_comps(q, limit=5):
        return []

    monkeypatch.setattr(pipeline, "search_comps", no_comps)
    out = asyncio.run(pipeline.appraise(nb, _req(2), fake_resolve))
    assert all(f.error for f in out.photo_findings)
    assert any("vision model failed" in w for w in out.warnings)
    assert out.identification.name  # reasoner still produced an answer from dealer text


def test_extract_json_handles_fences_and_preamble():
    assert extract_json('Sure! ```json\n{"a": 1}\n```')["a"] == 1
    assert extract_json('thinking... {"a": {"b": 2}} trailing')["a"]["b"] == 2
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_price_normalisation_swaps_and_clamps():
    p = pipeline._price({"low": "$900", "high": "600"}, "USD")
    assert (p.low, p.high) == (600.0, 900.0)
    assert p.suggested_retail == 750.0
    assert pipeline._clamp(85) == 0.85
    assert pipeline._clamp("0.4") == 0.4
