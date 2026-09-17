"""Bottle Tree Antique Price AI Guess-estimator — appraisal service.
Cloud: runs on Nebius AI Cloud, calls NVIDIA Nemotron + a vision model on Nebius Token Factory.
Edge:  the same code on a Jetson at the shop counter, calling local Ollama (Nemotron Mini + a 3B VLM),
       with the /kiosk touch UI and an outbox that syncs to Bottle Tree when the store Wi-Fi is up."""
from __future__ import annotations

import base64
import json
import logging
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .brains import Brains
from .config import settings
from .nebius import Nebius
from .outbox import Outbox
from .pipeline import appraise
from .schemas import Appraisal, AppraiseRequest, PhotoIn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("appraiser")

_state: dict = {}
KIOSK_DIR = Path(__file__).resolve().parent.parent / "kiosk"


@asynccontextmanager
async def lifespan(app: FastAPI):
    brains = Brains()
    _state["brains"] = brains
    _state["outbox"] = Outbox(settings.outbox_dir)
    log.info("brains: %s", await brains.startup())
    yield


app = FastAPI(title="Bottle Tree Appraiser", version="0.2.0", lifespan=lifespan)


def require_key(x_appraiser_key: str | None = Header(default=None)) -> None:
    if settings.service_key and x_appraiser_key != settings.service_key:
        raise HTTPException(401, "bad service key")


async def pick_brain() -> Nebius:
    try:
        return await _state["brains"].pick()
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e


async def resolve_photo(url: str) -> str:
    """Accept data: URLs as-is; fetch http(s) URLs and inline them as base64 (models on TF may not fetch)."""
    if url.startswith("data:"):
        return url
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as c:
        r = await c.get(url)
        r.raise_for_status()
        if len(r.content) > settings.max_image_bytes:
            raise HTTPException(413, f"image too large: {url}")
        ctype = r.headers.get("content-type", "").split(";")[0] or mimetypes.guess_type(url)[0] or "image/jpeg"
        return f"data:{ctype};base64,{base64.b64encode(r.content).decode()}"


@app.get("/health")
async def health():
    return {"ok": True, "service": "bottletree-appraiser", "brains": _state["brains"].status(),
            "outbox_pending": _state["outbox"].pending()}


@app.get("/models")
async def models():
    b = _state["brains"]
    return {"cloud": b.cloud.available if b.cloud else None, "edge": b.edge.available if b.edge else None, **b.status()}


@app.post("/appraise", response_model=Appraisal, dependencies=[Depends(require_key)])
async def appraise_json(req: AppraiseRequest, nb: Nebius = Depends(pick_brain)):
    if len(req.photos) > settings.max_photos:
        raise HTTPException(400, f"max {settings.max_photos} photos")
    return await appraise(nb, req, resolve_photo)


def _kinds(kinds: str, n: int) -> list[str]:
    allowed = PhotoIn.model_fields["kind"].annotation.__args__  # type: ignore[attr-defined]
    ks = [k.strip() for k in kinds.split(",")] if kinds else []
    return [(ks[i] if i < len(ks) and ks[i] in allowed else "other") for i in range(n)]


async def _read_uploads(photos: list[UploadFile], kinds: str) -> list[PhotoIn]:
    if len(photos) > settings.max_photos:
        raise HTTPException(400, f"max {settings.max_photos} photos")
    out: list[PhotoIn] = []
    for up, kind in zip(photos, _kinds(kinds, len(photos))):
        data = await up.read()
        if len(data) > settings.max_image_bytes:
            raise HTTPException(413, f"{up.filename} too large")
        ctype = up.content_type or mimetypes.guess_type(up.filename or "")[0] or "image/jpeg"
        out.append(PhotoIn(url=f"data:{ctype};base64,{base64.b64encode(data).decode()}", kind=kind))  # type: ignore[arg-type]
    return out


@app.post("/appraise/upload", response_model=Appraisal, dependencies=[Depends(require_key)])
async def appraise_upload(
    photos: list[UploadFile] = File(...),
    kinds: str = Form(""),            # comma-separated, parallel to photos; blanks -> "other"
    description: str = Form(""),
    markings: str = Form(""),
    item_id: str | None = Form(None),
    nb: Nebius = Depends(pick_brain),
):
    """Multipart variant for direct phone/browser/kiosk uploads (no Bottle Tree in the loop)."""
    items = await _read_uploads(photos, kinds)
    req = AppraiseRequest(photos=items, description=description, markings=markings, item_id=item_id)
    result = await appraise(nb, req, resolve_photo)
    _state["last"] = result          # debugging aid for the kiosk: GET /last
    _save_last_run(items, req, result)
    return result


def _save_last_run(items: list[PhotoIn], req: AppraiseRequest, result: Appraisal) -> None:
    """Keep the most recent kiosk run on disk (photos + result) so prompts can be tuned against real shots.
    Overwritten every run; directory is git-ignored."""
    try:
        d = Path(settings.outbox_dir).parent / "last_run"
        d.mkdir(parents=True, exist_ok=True)
        for old in d.iterdir():
            old.unlink()
        for i, p in enumerate(items):
            head, b64 = p.url.split(",", 1)
            ext = "png" if "png" in head else "jpg"
            (d / f"{i:02d}-{p.kind}.{ext}").write_bytes(base64.b64decode(b64))
        (d / "request.json").write_text(json.dumps({"description": req.description, "markings": req.markings,
                                                     "kinds": [p.kind for p in items]}, indent=1), encoding="utf-8")
        (d / "result.json").write_text(result.model_dump_json(indent=1), encoding="utf-8")  # Windows default is cp1252
    except Exception as e:  # noqa: BLE001
        log.info("could not save last run: %s", e)


@app.get("/last")
async def last():
    """Most recent appraisal from this process (kiosk debugging; not persisted)."""
    r = _state.get("last")
    return r.model_dump() if r else {"last": None}


# ---------- kiosk (Jetson at the counter) ----------
@app.get("/kiosk")
async def kiosk():
    return FileResponse(KIOSK_DIR / "index.html")


@app.post("/kiosk/save")
async def kiosk_save(
    photos: list[UploadFile] = File(...),
    kinds: str = Form(""),
    description: str = Form(""),
    markings: str = Form(""),
    appraisal: str = Form(""),        # JSON of the Appraisal shown on screen
    title: str = Form(""),
    price: str = Form(""),
):
    """Queue an appraised item in the local outbox, then try to sync it to Bottle Tree right away."""
    items = await _read_uploads(photos, kinds)
    ob: Outbox = _state["outbox"]
    entry_id = ob.add(items, description=description, markings=markings, appraisal=appraisal, title=title, price=price)
    synced = await ob.sync()
    return {"queued": entry_id, "synced": synced, "pending": ob.pending()}


@app.post("/kiosk/sync")
async def kiosk_sync():
    ob: Outbox = _state["outbox"]
    return {"synced": await ob.sync(), "pending": ob.pending()}
