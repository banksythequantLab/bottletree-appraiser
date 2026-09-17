"""Runtime configuration — everything comes from the environment (.env), never hard-coded."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()

# Nemotron does the reasoning / listing copy. Required by the hackathon (NVIDIA open model).
DEFAULT_TEXT_MODEL = "nvidia/nemotron-3-super-120b-a12b"

# Vision candidates, tried in order at startup against /v1/models. First one the key can see wins.
# NVIDIA models first so the vision leg is also NVIDIA when Token Factory serves one.
# Verified 2026-09-17 against a Token Factory account: none of the Nemotron models there accept images
# (Super/Nano/Lightning all return "does not support image input"); google/gemma-3-27b-it reads a worn
# cast-iron stamp correctly in ~2.5 s, openbmb/MiniCPM-V-4_5 is faster but sloppier. NVIDIA VL names stay
# first so the kiosk upgrades itself the day one is served.
DEFAULT_VISION_CANDIDATES = [
    "nvidia/nemotron-3-nano-omni-30b-a3b",
    "nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL",
    "google/gemma-3-27b-it",
    "openbmb/MiniCPM-V-4_5",
    "Qwen/Qwen2.5-VL-72B-Instruct",
]


def _csv(name: str, default: list[str]) -> list[str]:
    raw = os.getenv(name, "").strip()
    return [x.strip() for x in raw.split(",") if x.strip()] or default


# Edge (Jetson / offline) defaults — any OpenAI-compatible local server; Ollama by default.
# nemotron-mini = NVIDIA Nemotron-Mini-4B (fits a Jetson Orin Nano 8 GB alongside a 3B VLM).
DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1/"
DEFAULT_LOCAL_TEXT_MODEL = "nemotron-mini"
# Vision model, measured 2026-09-17 on an RTX 2060 6 GB with real Logitech BRIO frames:
#   qwen2.5vl:3b  — aborts in Ollama ("token repeat limit reached") on many frames, deterministic per image.
#   qwen3-vl:4b   — never aborts but thinks 3-7k tokens first (Ollama ignores think=false): 35-80 s per photo,
#                   often finish=length with empty content; a 4-photo run took 4.5 min.
#   gemma3:4b     — no thinking, clean JSON, 4-10 s per photo; weak at reading worn stamps, which is fine because
#                   the dealer types the marks and IDENTIFY_SYSTEM ranks dealer text above photo guesses.
# Edge still uses ONE combined pass per photo and caps photos at EDGE_MAX_PHOTOS to keep a counter run short.
DEFAULT_LOCAL_VISION_MODEL = "gemma3:4b"


@dataclass
class Settings:
    # cloud  = Nebius Token Factory only (hackathon default)
    # edge   = local OpenAI-compatible server only (Jetson kiosk, no internet)
    # auto   = cloud when reachable, otherwise edge (kiosk with flaky store Wi-Fi)
    mode: str = field(default_factory=lambda: os.getenv("APPRAISER_MODE", "cloud").lower())
    local_base_url: str = field(default_factory=lambda: os.getenv("LOCAL_BASE_URL", DEFAULT_LOCAL_BASE_URL))
    local_text_model: str = field(default_factory=lambda: os.getenv("LOCAL_TEXT_MODEL", DEFAULT_LOCAL_TEXT_MODEL))
    local_vision_model: str = field(default_factory=lambda: os.getenv("LOCAL_VISION_MODEL", DEFAULT_LOCAL_VISION_MODEL))
    edge_max_photos: int = field(default_factory=lambda: int(os.getenv("EDGE_MAX_PHOTOS", "6")))
    edge_single_pass: bool = field(default_factory=lambda: os.getenv("EDGE_SINGLE_PASS", "1") == "1")
    # Kiosk → Bottle Tree sync (optional). Device key is issued per shop in the Bottle Tree app.
    bottletree_url: str = field(default_factory=lambda: os.getenv("BOTTLETREE_URL", "").rstrip("/"))
    bottletree_device_key: str = field(default_factory=lambda: os.getenv("BOTTLETREE_DEVICE_KEY", ""))
    outbox_dir: str = field(default_factory=lambda: os.getenv("OUTBOX_DIR", "outbox"))
    nebius_api_key: str = field(default_factory=lambda: os.getenv("NEBIUS_API_KEY", ""))
    nebius_base_url: str = field(
        default_factory=lambda: os.getenv("NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1/")
    )
    text_model: str = field(default_factory=lambda: os.getenv("NEMOTRON_MODEL", DEFAULT_TEXT_MODEL))
    vision_model: str = field(default_factory=lambda: os.getenv("VISION_MODEL", "auto"))
    vision_candidates: list[str] = field(
        default_factory=lambda: _csv("VISION_CANDIDATES", DEFAULT_VISION_CANDIDATES)
    )
    tavily_api_key: str = field(default_factory=lambda: os.getenv("TAVILY_API_KEY", ""))
    max_photos: int = field(default_factory=lambda: int(os.getenv("MAX_PHOTOS", "8")))
    max_image_bytes: int = field(default_factory=lambda: int(os.getenv("MAX_IMAGE_BYTES", str(8 * 1024 * 1024))))
    # Shared secret the Bottle Tree worker sends as X-Appraiser-Key. Empty = open (dev only).
    service_key: str = field(default_factory=lambda: os.getenv("APPRAISER_SERVICE_KEY", ""))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8080")))


settings = Settings()
