"""Offline outbox for the kiosk. Each appraised item is written to disk as a folder
(photos + meta.json) and pushed to Bottle Tree's device-intake endpoint whenever the network is up.
Survives reboots and power cuts — a Jetson at a store counter gets both."""
from __future__ import annotations

import base64
import json
import logging
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .config import settings
from .schemas import PhotoIn

log = logging.getLogger("appraiser.outbox")


class Outbox:
    def __init__(self, root: str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def add(self, photos: list[PhotoIn], **meta: str) -> str:
        entry_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:6]
        d = self.root / entry_id
        d.mkdir()
        files = []
        for i, p in enumerate(photos):
            head, b64 = p.url.split(",", 1)
            ext = "png" if "png" in head else "webp" if "webp" in head else "jpg"
            name = f"{i:02d}-{p.kind}.{ext}"
            (d / name).write_bytes(base64.b64decode(b64))
            files.append({"file": name, "kind": p.kind, "content_type": head[5:].split(";")[0]})
        (d / "meta.json").write_text(json.dumps({"files": files, **meta}, indent=1))
        log.info("outbox: queued %s (%d photos)", entry_id, len(files))
        return entry_id

    def pending(self) -> int:
        return sum(1 for p in self.root.iterdir() if p.is_dir() and (p / "meta.json").exists())

    async def sync(self) -> int:
        """Push every queued entry. Returns how many were accepted. Silent no-op when sync isn't configured."""
        if not settings.bottletree_url or not settings.bottletree_device_key:
            return 0
        done = 0
        for d in sorted(p for p in self.root.iterdir() if p.is_dir()):
            meta_p = d / "meta.json"
            if not meta_p.exists():
                continue
            meta = json.loads(meta_p.read_text())
            try:
                files = [("photos", (f["file"], (d / f["file"]).read_bytes(), f["content_type"])) for f in meta["files"]]
                data = {k: v for k, v in meta.items() if k != "files"}
                data["kinds"] = ",".join(f["kind"] for f in meta["files"])
                async with httpx.AsyncClient(timeout=60) as c:
                    r = await c.post(f"{settings.bottletree_url}/api/device/intake", files=files, data=data,
                                     headers={"x-device-key": settings.bottletree_device_key})
                if r.status_code == 200:
                    shutil.rmtree(d)
                    done += 1
                    log.info("outbox: synced %s -> item %s", d.name, r.json().get("item_id"))
                elif 400 <= r.status_code < 500 and r.status_code != 429:
                    # permanent rejection (bad key, bad payload): park it so it stops retrying
                    d.rename(d.with_name(d.name + ".rejected"))
                    log.error("outbox: %s rejected %s %s", d.name, r.status_code, r.text[:200])
                else:
                    log.warning("outbox: %s deferred (%s)", d.name, r.status_code)
                    break
            except (httpx.HTTPError, OSError) as e:
                log.info("outbox: offline, will retry (%s)", type(e).__name__)
                break
        return done
