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
    """One OpenAI-compatible brain. `kind` is "cloud" (Nebius Token Factory) or "edge" (local Ollama etc.)."""

    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 text_model: str | None = None, vision_model: str | None = None, kind: str = "cloud"):
        self.kind = kind
        self.client = AsyncOpenAI(
            api_key=api_key or settings.nebius_api_key or "missing",
            base_url=base_url or settings.nebius_base_url,
            timeout=120 if kind == "cloud" else 600,   # small edge GPUs are slow on first token
        )
        self.text_model = text_model or settings.text_model
        self.vision_model = vision_model or settings.vision_model
        self.vision_fallbacks: list[str] = []   # other listed candidates, used when the primary times out
        self.available: list[str] = []
        self.reachable: bool | None = None

    @classmethod
    def edge(cls) -> "Nebius":
        return cls(api_key="local", base_url=settings.local_base_url, text_model=settings.local_text_model,
                   vision_model=settings.local_vision_model, kind="edge")

    async def probe(self) -> dict[str, Any]:
        """List models the endpoint serves; resolve vision_model if set to 'auto'."""
        try:
            resp = await self.client.models.list()
            self.available = sorted(m.id for m in resp.data)
            self.reachable = True
        except Exception as e:  # noqa: BLE001
            log.warning("[%s] model probe failed: %s", self.kind, e)
            self.available = []
            self.reachable = False
        if self.vision_model == "auto":
            pick = next((c for c in settings.vision_candidates if c in self.available), None)
            self.vision_model = pick or settings.vision_candidates[0]
            log.info("vision model resolved to %s (%s)", self.vision_model, "listed" if pick else "unverified")
        if self.kind == "cloud":
            self.vision_fallbacks = [c for c in settings.vision_candidates if c in self.available and c != self.vision_model]
        text_ok = self.text_model in self.available if self.available else None
        return {
            "kind": self.kind,
            "reachable": self.reachable,
            "text_model": self.text_model,
            "text_model_listed": text_ok,
            "vision_model": self.vision_model,
            "vision_model_listed": (self.vision_model in self.available) if self.available else None,
            "nvidia_models_available": [m for m in self.available if "nvidia" in m.lower() or "nemotron" in m.lower()],
            "model_count": len(self.available),
        }

    async def vision_json(self, prompt: str, image_data_urls: list[str], max_tokens: int = 900,
                          temperature: float | None = None) -> dict[str, Any]:
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for url in image_data_urls:
            content.append({"type": "image_url", "image_url": {"url": url}})
        kwargs: dict[str, Any] = {}
        if self.kind == "edge":
            # a little heat keeps small VLMs from looping; big token budget because qwen3-vl thinks first
            kwargs.update(temperature=0.2 if temperature is None else temperature)
            max_tokens = max(max_tokens, 3000)
        else:
            # Token Factory vision endpoints sometimes queue a call for minutes; don't let the SDK's own
            # 2 retries x 120 s hide that — fail fast and let the caller fall through to the next model.
            kwargs.update(temperature=0.1 if temperature is None else temperature)
        client = self.client if self.kind == "edge" else self.client.with_options(timeout=40, max_retries=0)
        r = None
        for model in [self.vision_model, *self.vision_fallbacks]:
            try:
                r = await client.chat.completions.create(
                    model=model, messages=[{"role": "user", "content": content}], max_tokens=max_tokens, **kwargs)
                if model != self.vision_model:
                    log.info("vision fallback used: %s", model)
                break
            except Exception as e:  # noqa: BLE001
                if not self.vision_fallbacks or model == self.vision_fallbacks[-1]:
                    raise
                log.info("vision model %s failed (%s); trying next", model, type(e).__name__)
        assert r is not None
        text = r.choices[0].message.content or ""
        try:
            return extract_json(text)
        except ValueError:
            log.info("vision output was not JSON (finish=%s): %r", r.choices[0].finish_reason, text[:300])
            raise

    async def text_json(self, system: str, user: str, max_tokens: int = 1800) -> dict[str, Any]:
        if self.kind == "cloud":
            # Nemotron 3 Super is a reasoning model: its thinking shares the completion budget with the answer
            # (measured: ~550 tokens / 5.6 s for a one-line pricing question, and a better price than with
            # thinking disabled). Give it room or it hits finish=length with an empty content.
            max_tokens = max(max_tokens, 6000)
        kwargs: dict[str, Any] = dict(
            model=self.text_model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=max_tokens,
            temperature=0.0 if self.kind == "edge" else 0.2,
        )
        try:
            r = await self.client.chat.completions.create(response_format={"type": "json_object"}, **kwargs)
        except Exception as e:  # noqa: BLE001 — some endpoints reject response_format; retry plain
            log.info("json_object unsupported (%s); retrying without response_format", e)
            r = await self.client.chat.completions.create(**kwargs)
        text = r.choices[0].message.content or ""
        try:
            return extract_json(text)
        except ValueError:
            log.info("text output was not JSON (finish=%s): %r", r.choices[0].finish_reason, text[:300])
            raise


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of model output (handles fences, reasoning preambles, and
    answers cut off by max_tokens — those are repaired by closing the open strings/arrays/objects)."""
    text = text.strip()
    m = _FENCE.search(text)
    if m:
        text = m.group(1).strip()
    elif text.startswith("```"):                      # opening fence, no closing one (truncated)
        text = text.split("\n", 1)[1] if "\n" in text else ""
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
    repaired = repair_truncated_json(text[start:])
    if repaired is not None:
        log.info("repaired truncated JSON from model output")
        return repaired
    raise ValueError("unterminated JSON object in model output")


def repair_truncated_json(text: str, max_backoff: int = 40) -> dict[str, Any] | None:
    """Close whatever is open at the end of a truncated JSON document. If that doesn't parse, back off to
    the previous comma and try again — dropping the partial trailing element each time."""
    cut = len(text)
    for _ in range(max_backoff):
        chunk = text[:cut].rstrip()
        candidate = _close_open(chunk)
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
        cut = chunk.rfind(",")
        if cut <= 0:
            return None
    return None


def _close_open(chunk: str) -> str:
    stack: list[str] = []
    in_str = False
    esc = False
    for ch in chunk:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "[{":
            stack.append("]" if ch == "[" else "}")
        elif ch in "]}" and stack:
            stack.pop()
    out = chunk + ('"' if in_str else "")
    out = out.rstrip()
    if out.endswith(","):
        out = out[:-1]
    if out.endswith(":"):                             # dangling key with no value
        out = out[: out.rfind(",")] if "," in out else out + " null"
    return out + "".join(reversed(stack))
