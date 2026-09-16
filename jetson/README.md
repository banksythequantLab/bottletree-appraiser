# Counter kiosk on NVIDIA Jetson (Physical AI track)

The same appraisal service that runs on Nebius AI Cloud runs on a Jetson at the shop counter, with a
USB camera and a touchscreen, and keeps working when the store's internet doesn't.

```
   USB camera ──▶ Chromium --kiosk (http://127.0.0.1:8080/kiosk) ──▶ FastAPI service (APPRAISER_MODE=auto)
                                                                          │
                                        online  ───────────────────────────┼──▶ Nebius Token Factory: Nemotron 3 Super + VL model
                                        offline ───────────────────────────┴──▶ Ollama on the Jetson GPU: nemotron-mini (NVIDIA) + qwen2.5vl:3b
                                                                          │
                                                          outbox/ on disk ─┴──▶ Bottle Tree /api/device/intake when Wi-Fi returns
```

## Hardware

- Jetson Orin Nano 8 GB (JetPack 6.x) — the track prize unit. Orin NX 16 GB lets you swap in bigger models.
- Any UVC USB camera (Logitech BRIO / C920 class). Mount it on a small arm over a neutral mat.
- Touchscreen or any HDMI display + keyboard (Space / Enter takes a photo).

## Install

```
git clone https://github.com/banksythequantLab/bottletree-appraiser
cd bottletree-appraiser
sudo bash jetson/setup.sh
nano service/.env        # NEBIUS_API_KEY (optional, cloud brain), BOTTLETREE_URL + BOTTLETREE_DEVICE_KEY (sync)
sudo systemctl restart bottletree-appraiser
bash jetson/kiosk.sh     # or reboot — it autostarts on the desktop session
```

`setup.sh` installs Ollama (its installer ships the Jetson CUDA build), pulls `nemotron-mini` (NVIDIA
Nemotron-Mini-4B, ~2.7 GB) and `qwen2.5vl:3b` (~3.2 GB), installs the service as a systemd unit, and
adds a Chromium kiosk autostart. Both models stay resident (`OLLAMA_KEEP_ALIVE=-1`) so the first
appraisal of the day isn't slow.

## Modes (`APPRAISER_MODE` in `service/.env`)

| mode | behaviour |
|---|---|
| `auto` (kiosk default) | Nebius when a models.list() answers within 4 s, otherwise the on-device brain. Re-checked every minute, so it upgrades itself back to Nemotron Super when Wi-Fi returns. |
| `edge` | On-device only. Use for the offline demo. |
| `cloud` | Nebius only (what the hosted service uses). |

The appraisal card shows which brain answered (`⚡ on-device Nemotron` vs `☁ Nemotron on Nebius`).

## Sync to Bottle Tree

In the Bottle Tree app → *My shop* → *Counter kiosk* → *Generate new key*. Put it in `service/.env` as
`BOTTLETREE_DEVICE_KEY` with `BOTTLETREE_URL=https://bottletree-app.dj-b02.workers.dev`. "Save to
Bottle Tree" on the kiosk writes the photos + appraisal to `service/outbox/`, pushes immediately if
online, and retries every 2 minutes otherwise. Items land in a "Kiosk intake" sale, ready to approve
and list online from the phone app.

## Measured on a stand-in (RTX 2060 6 GB, Windows, same models)

Single front photo of a stamped 5-gallon Jos. Bayer crock, dealer typed the markings:

- ~55 s end-to-end fully offline (two vision passes + Nemotron Mini), first run of the day.
- Identification correct (maker, town, capacity), confidence 0.9, $100–150 range, no cloud.
- The 3B VLM read "JOS. BAYR / WASHINGTON, MO." — one letter off. This is why the kiosk asks the
  dealer to type the marks: a human reading a worn stamp beats a 3B model, and dealer text is weighted
  above OCR in the reasoning prompt.

Expect the Orin Nano to be 2–3× slower than the 2060 (shared 8 GB, lower TOPS); the UI cycles
"Reading photos… / Looking for marks… / Thinking like an appraiser…" so the wait reads as work, not a hang.

## Tuning

- Bigger Jetson? `LOCAL_TEXT_MODEL=nemotron-3-nano` / `qwen2.5vl:7b` in `.env` and re-run setup.
- Slow camera? Lower the capture size in `service/kiosk/index.html` (`max = 1600`).
- Logs: `journalctl -u bottletree-appraiser -f`; model health: `curl -s :8080/health | jq .brains`.
