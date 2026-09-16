"""Thin wrapper over Nebius Token Factory (OpenAI-compatible) with model probing and JSON extraction."""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from openai import AsyncOpenAI

from .config import settings

log = logging.getLogger("appraiser.nebius")


class Nebius:
    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        self.client = AsyncOpenAI(
            api_key=api_key or settings.nebius_api_key or "missing",
            base_url=base_url or settings.nebius_base_url,
        )
        self.text_model = settings.text_model
        self.vision_model = settings.vision_model
        self.available: list[str] = []

    async def probe(self) -> dict[str, Any]:
        """List models the key can see; resolve vision_model if set to 'auto'."""
        try:
            resp = await self.client.models.list()
            self.available = sorted(m.id for m in resp.data)
        except Exception as e:  # noqa: BLE001
            log.warning("model probe failed: %s", e)
            self.available = []
        if self.vision_model == "auto":
            pick = next((c for c in settings.vision_candidates if c in self.available), None)
            self.vision_model = pick or settings.vision_candidates[0]
            log.info("vision model resolved to %s (%s)", self.vision_model, "listed" if pick else "unverified")
        text_ok = self.text_model in self.available if self.available else None
        return {
            "text_model": self.text_model,
            "text_model_listed": text_ok,
            "vision_model": self.vision_model,
            "vision_model_listed": (self.vision_model in self.available) if self.available else None,
            "nvidia_models_available": [m for m in self.available if m.lower().startswith("nvidia/")],
            "model_count": len(self.available),
        }

    async def vision_json(self, prompt: str, image_data_urls: list[str], max_tokens: int = 900) -> dict[str, Any]:
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for url in image_data_urls:
            content.append({"type": "image_url", "image_url": {"url": url}})
        r = await self.client.chat.completions.create(
            model=self.vision_model,
            messages=[{"role": "user", "content": content}],
            max_tokens=max_tokens,
            temperature=0.1,
        )
        return extract_json(r.choices[0].message.content or "")

    async def text_json(self, system: str, user: str, max_tokens: int = 1800) -> dict[str, Any]:
        kwargs: dict[str, Any] = dict(
            model=self.text_model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=max_tokens,
            temperature=0.2,
        )
        try:
            r = await self.client.chat.completions.create(response_format={"type": "json_object"}, **kwargs)
        except Exception as e:  # noqa: BLE001 — some endpoints reject response_format; retry plain
            log.info("json_object unsupported (%s); retrying without response_format", e)
            r = await self.client.chat.completions.create(**kwargs)
        return extract_json(r.choices[0].message.content or "")


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of model output (handles fences, reasoning preambles)."""
    text = text.strip()
    m = _FENCE.search(text)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start == -1:
        raise ValueError("model returned no JSON object")
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : i + 1])
    raise ValueError("unterminated JSON object in model output")
