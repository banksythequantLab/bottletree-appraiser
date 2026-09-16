"""List models visible to your NEBIUS_API_KEY and test which candidates accept an image.
Run: python scripts/probe_models.py"""
from __future__ import annotations

import asyncio
import base64
import io
import sys

sys.path.insert(0, ".")
from app.config import settings  # noqa: E402
from app.nebius import Nebius  # noqa: E402

# 1x1 white PNG
_PNG = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050001ff2b5f1d0000000049454e44ae426082"
)).decode()


async def main():
    nb = Nebius()
    info = await nb.probe()
    print("== probe ==")
    for k, v in info.items():
        print(f"{k}: {v}")
    print("\n== all models ==")
    for m in nb.available:
        print(" ", m)
    print("\n== image test on candidates ==")
    for cand in settings.vision_candidates:
        nb.vision_model = cand
        try:
            out = await nb.client.chat.completions.create(
                model=cand, max_tokens=20,
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": "Reply with the single word OK."},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{_PNG}"}}]}])
            print(f"  {cand}: OK -> {out.choices[0].message.content!r}")
        except Exception as e:  # noqa: BLE001
            print(f"  {cand}: FAIL ({str(e)[:120]})")


if __name__ == "__main__":
    asyncio.run(main())
