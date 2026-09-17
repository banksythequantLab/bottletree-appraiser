# Counter kiosk on an NVIDIA edge box (Physical AI track)

The same appraisal service that runs on Nebius AI Cloud runs on a small NVIDIA box at the shop counter,
with a USB camera and a touchscreen, and keeps working when the store's internet doesn't.

**Our demo unit is a laptop with an RTX 2060 (6 GB) and a Logitech BRIO on an arm over a neutral mat** —
the kiosk is hardware-agnostic: anything that runs Ollama with a CUDA GPU works. The Jetson notes below are
for the Orin Nano dev kit (the track prize); the Windows launch commands are at the bottom.

```
   USB camera ──▶ Chromium --kiosk (http://127.0.0.1:8080/kiosk) ──▶ FastAPI service (APPRAISER_MODE=auto)
                                                                          │
                                        online  ───────────────────────────┼──▶ Nebius Token Factory: Nemotron 3 Super + VL model
                                        offline ───────────────────────────┴──▶ Ollama on the Jetson GPU: nemotron-mini (NVIDIA) + gemma3:4b
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
Nemotron-Mini-4B, ~2.7 GB) and `gemma3:4b` (~3.3 GB), installs the service as a systemd unit, and
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

- ~60 s end-to-end fully offline (one vision pass per photo + Nemotron Mini) on an RTX 2060 6 GB.
- Identification correct (maker, town, capacity), confidence 0.9, $100–150 range, no cloud.
- The 3B VLM read "JOS. BAYR / WASHINGTON, MO." — one letter off. This is why the kiosk asks the
  dealer to type the marks: a human reading a worn stamp beats a 3B model, and dealer text is weighted
  above OCR in the reasoning prompt.

Expect the Orin Nano to be 2–3× slower than the 2060 (shared 8 GB, lower TOPS); the UI cycles
"Reading photos… / Looking for marks… / Thinking like an appraiser…" so the wait reads as work, not a hang.

## Running the kiosk on a Windows NVIDIA laptop (what we demo on)

```
ollama pull nemotron-mini ; ollama pull gemma3:4b
cd service ; copy .env.example .env        # set APPRAISER_MODE=auto (or edge for the offline demo)
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8080
start chrome --kiosk --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required http://127.0.0.1:8080/kiosk
```

Chrome will pick the default camera; if it grabs the laptop's built-in webcam instead of the BRIO, set the
BRIO as default under Windows Settings → Bluetooth & devices → Cameras, or pick it once in the Chrome
camera prompt (drop `--use-fake-ui-for-media-stream` to get the prompt). Space or Enter takes a shot.
Pull the Wi-Fi mid-demo: the badge flips from "☁ Nemotron on Nebius" to "⚡ on-device Nemotron" and the
next appraisal still comes back.

## Tuning

- Bigger Jetson? `LOCAL_TEXT_MODEL=nemotron-3-nano` / `gemma3:12b` in `.env` and re-run setup.
- Why gemma3:4b and not a Qwen VLM: on real BRIO frames qwen2.5vl:3b aborts in Ollama ("token repeat limit reached") and qwen3-vl:4b thinks for 35-80 s per photo, often returning nothing. gemma3:4b answers in 4-10 s with clean JSON. It is weak at reading worn stamps, so the dealer types the marks and the reasoner is told dealer text outranks photo guesses; a deterministic guard also keeps the dealer's own wording as the item name if a small model drifts ("fireplace tool" for a fluting iron).
- Capture hygiene: hands out of frame before pressing the shutter, marks shot as close and flat as possible.
- Slow camera? Lower the capture size in `service/kiosk/index.html` (`max = 1600`).
- Logs: `journalctl -u bottletree-appraiser -f`; model health: `curl -s :8080/health | jq .brains`.
