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
DEFAULT_VISION_CANDIDATES = [
    "nvidia/nemotron-3-nano-omni-30b-a3b",
    "nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL",
    "nvidia/Nemotron-Nano-12B-v2-VL",
    "Qwen/Qwen2.5-VL-72B-Instruct",
    "Qwen/Qwen2-VL-72B-Instruct",
    "google/gemma-3-27b-it",
]


def _csv(name: str, default: list[str]) -> list[str]:
    raw = os.getenv(name, "").strip()
    return [x.strip() for x in raw.split(",") if x.strip()] or default


@dataclass
class Settings:
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
