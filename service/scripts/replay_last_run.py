"""Replay a saved kiosk run (last_run/ or a copy) against the running service and print the verdict.
Usage: python scripts/replay_last_run.py [dir] [base_url]"""
import json, os, sys, time
from pathlib import Path
import httpx

d = Path(sys.argv[1] if len(sys.argv) > 1 else "last_run")
base = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8080"
req = json.loads((d / "request.json").read_text("utf-8"))
photos = sorted(p for p in d.iterdir() if p.suffix.lower() == ".jpg")
files = [("photos", (p.name, p.read_bytes(), "image/jpeg")) for p in photos]
data = {"kinds": ",".join(req.get("kinds", [])), "description": req.get("description", ""),
        "markings": req.get("markings", "")}
headers = {"x-service-key": os.getenv("APPRAISER_SERVICE_KEY", "")}
t = time.time()
r = httpx.post(f"{base}/appraise/upload", files=files, data=data, headers=headers, timeout=900)
r.raise_for_status()
a = r.json()
i, p = a["identification"], a["price_range"]
print(f"TOTAL {time.time()-t:.0f}s")
print(f"name={i['name']!r} maker={i['maker']!r} period={i['period']!r} conf={a['confidence']}")
print(f"price {p['low']}-{p['high']} {p['currency']} retail={p['suggested_retail']} | grade={a['listing']['condition_grade']}")
print("warnings:", " | ".join(a["warnings"]))
print("listing:", a["listing"]["title"])
