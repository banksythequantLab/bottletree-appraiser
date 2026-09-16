"""Bottle Tree Antique Price AI Guess-estimator — appraisal service.
Runs on Nebius AI Cloud; calls NVIDIA Nemotron + a vision model on Nebius Token Factory."""
from __future__ import annotations

import base64
import logging
import mimetypes
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile

from .config import settings
from .nebius import Nebius
from .pipeline import appraise
from .schemas import Appraisal, AppraiseRequest, PhotoIn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("appraiser")

_state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    nb = Nebius()
    _state["nebius"] = nb
    _state["probe"] = await nb.probe() if settings.nebius_api_key else {"error": "NEBIUS_API_KEY not set"}
    log.info("model probe: %s", _state["probe"])
    yield


app = FastAPI(title="Bottle Tree Appraiser", version="0.1.0", lifespan=lifespan)


def require_key(x_appraiser_key: str | None = Header(default=None)) -> None:
    if settings.service_key and x_appraiser_key != settings.service_key:
        raise HTTPException(401, "bad service key")


def get_nebius() -> Nebius:
    return _state["nebius"]


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
    return {"ok": True, "service": "bottletree-appraiser", "models": _state.get("probe")}


@app.get("/models")
async def models(nb: Nebius = Depends(get_nebius)):
    return {"available": nb.available, **(_state.get("probe") or {})}


@app.post("/appraise", response_model=Appraisal, dependencies=[Depends(require_key)])
async def appraise_json(req: AppraiseRequest, nb: Nebius = Depends(get_nebius)):
    if not settings.nebius_api_key:
        raise HTTPException(503, "NEBIUS_API_KEY not configured")
    if len(req.photos) > settings.max_photos:
        raise HTTPException(400, f"max {settings.max_photos} photos")
    return await appraise(nb, req, resolve_photo)


@app.post("/appraise/upload", response_model=Appraisal, dependencies=[Depends(require_key)])
async def appraise_upload(
    photos: list[UploadFile] = File(...),
    kinds: str = Form(""),            # comma-separated, parallel to photos; blanks -> "other"
    description: str = Form(""),
    markings: str = Form(""),
    item_id: str | None = Form(None),
    nb: Nebius = Depends(get_nebius),
):
    """Multipart variant for direct phone/browser uploads (no Bottle Tree in the loop)."""
    if not settings.nebius_api_key:
        raise HTTPException(503, "NEBIUS_API_KEY not configured")
    if len(photos) > settings.max_photos:
        raise HTTPException(400, f"max {settings.max_photos} photos")
    kind_list = [k.strip() or "other" for k in kinds.split(",")] if kinds else []
    items: list[PhotoIn] = []
    for i, up in enumerate(photos):
        data = await up.read()
        if len(data) > settings.max_image_bytes:
            raise HTTPException(413, f"{up.filename} too large")
        ctype = up.content_type or mimetypes.guess_type(up.filename or "")[0] or "image/jpeg"
        kind = kind_list[i] if i < len(kind_list) else "other"
        if kind not in PhotoIn.model_fields["kind"].annotation.__args__:  # type: ignore[attr-defined]
            kind = "other"
        items.append(PhotoIn(url=f"data:{ctype};base64,{base64.b64encode(data).decode()}", kind=kind))  # type: ignore[arg-type]
    req = AppraiseRequest(photos=items, description=description, markings=markings, item_id=item_id)
    return await appraise(nb, req, resolve_photo)
