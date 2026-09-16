"""Brain selection: cloud (Nebius Token Factory), edge (local Ollama on a Jetson), or auto.

auto = use the cloud when it answers a models.list() within a few seconds, otherwise fall back to
the edge brain. The check is cheap and re-run per request so a kiosk on flaky store Wi-Fi keeps
working and upgrades itself back to Nemotron Super the moment the connection returns."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .config import settings
from .nebius import Nebius

log = logging.getLogger("appraiser.brains")


class Brains:
    def __init__(self) -> None:
        self.mode = settings.mode if settings.mode in ("cloud", "edge", "auto") else "cloud"
        self.cloud: Nebius | None = Nebius() if self.mode in ("cloud", "auto") and settings.nebius_api_key else None
        self.edge: Nebius | None = Nebius.edge() if self.mode in ("edge", "auto") else None
        self._cloud_ok_until = 0.0
        self.probes: dict[str, Any] = {}

    async def startup(self) -> dict[str, Any]:
        for name, b in (("cloud", self.cloud), ("edge", self.edge)):
            if b is not None:
                self.probes[name] = await b.probe()
        self.probes["mode"] = self.mode
        if self.cloud and self.cloud.reachable:
            self._cloud_ok_until = time.time() + 60
        return self.probes

    async def _cloud_alive(self) -> bool:
        if not self.cloud:
            return False
        if time.time() < self._cloud_ok_until:
            return True
        try:
            await asyncio.wait_for(self.cloud.client.models.list(), timeout=4)
            self._cloud_ok_until = time.time() + 60
            return True
        except Exception as e:  # noqa: BLE001
            log.info("cloud unreachable (%s) — using edge brain", type(e).__name__)
            return False

    async def pick(self) -> Nebius:
        if self.mode == "cloud":
            if not self.cloud:
                raise RuntimeError("NEBIUS_API_KEY not configured")
            return self.cloud
        if self.mode == "edge":
            assert self.edge is not None
            return self.edge
        # auto
        if await self._cloud_alive():
            return self.cloud  # type: ignore[return-value]
        assert self.edge is not None
        return self.edge

    def status(self) -> dict[str, Any]:
        return {"mode": self.mode, "cloud_configured": self.cloud is not None, "edge_configured": self.edge is not None,
                **self.probes}
