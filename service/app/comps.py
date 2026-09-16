"""Comparable-sales lookup. Uses Tavily if TAVILY_API_KEY is set; otherwise returns [] and the
pipeline flags that the price range is model-estimated without live comps."""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from .config import settings

log = logging.getLogger("appraiser.comps")

_PRICE = re.compile(r"\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)")


def _first_price(text: str) -> float | None:
    m = _PRICE.search(text or "")
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None


async def search_comps(query: str, limit: int = 5) -> list[dict[str, Any]]:
    if not settings.tavily_api_key or not query.strip():
        return []
    q = f"{query} sold price antique"
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": settings.tavily_api_key,
                    "query": q,
                    "max_results": limit,
                    "include_domains": [
                        "ebay.com", "liveauctioneers.com", "worthpoint.com", "1stdibs.com",
                        "chairish.com", "invaluable.com", "rubylane.com", "etsy.com",
                    ],
                },
            )
            r.raise_for_status()
            out = []
            for hit in r.json().get("results", []):
                out.append({
                    "title": hit.get("title", "")[:160],
                    "url": hit.get("url", ""),
                    "source": (hit.get("url", "").split("/")[2] if "//" in hit.get("url", "") else ""),
                    "price": _first_price(hit.get("content", "")),
                    "note": (hit.get("content", "") or "")[:240],
                })
            return out
    except Exception as e:  # noqa: BLE001
        log.warning("comps search failed: %s", e)
        return []
