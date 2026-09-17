#!/usr/bin/env bash
# Bottle Tree counter kiosk — one-shot setup for NVIDIA Jetson (Orin Nano / NX, JetPack 6.x, Ubuntu 22.04).
# Installs Ollama (CUDA build for Jetson), pulls the on-device models, installs the appraiser as a
# systemd service, and launches Chromium in kiosk mode on the attached display at boot.
# Usage: sudo bash jetson/setup.sh   (run from the repo root, as the desktop user via sudo)
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KIOSK_USER="${SUDO_USER:-$USER}"
TEXT_MODEL="${LOCAL_TEXT_MODEL:-nemotron-mini}"       # NVIDIA Nemotron-Mini-4B
VISION_MODEL="${LOCAL_VISION_MODEL:-gemma3:4b}"    # 4B VLM, no thinking mode; fits Orin Nano 8 GB alongside the text model

echo "== apt"
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip chromium-browser unclutter curl jq

echo "== ollama"
if ! command -v ollama >/dev/null; then curl -fsSL https://ollama.com/install.sh | sh; fi
systemctl enable --now ollama
# keep models resident and let the two calls per photo overlap
mkdir -p /etc/systemd/system/ollama.service.d
cat >/etc/systemd/system/ollama.service.d/kiosk.conf <<'EOF'
[Service]
Environment="OLLAMA_KEEP_ALIVE=-1"
Environment="OLLAMA_NUM_PARALLEL=2"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
EOF
systemctl daemon-reload && systemctl restart ollama
sleep 3
sudo -u "$KIOSK_USER" ollama pull "$TEXT_MODEL"
sudo -u "$KIOSK_USER" ollama pull "$VISION_MODEL"

echo "== appraiser service"
cd "$REPO_DIR/service"
sudo -u "$KIOSK_USER" python3 -m venv .venv
sudo -u "$KIOSK_USER" .venv/bin/pip install -q -r requirements.txt
if [ ! -f .env ]; then
  sudo -u "$KIOSK_USER" cp .env.example .env
  sed -i "s/^APPRAISER_MODE=.*/APPRAISER_MODE=auto/; t; \$aAPPRAISER_MODE=auto" .env
  sed -i "s/^LOCAL_TEXT_MODEL=.*/LOCAL_TEXT_MODEL=$TEXT_MODEL/; t; \$aLOCAL_TEXT_MODEL=$TEXT_MODEL" .env
  sed -i "s/^LOCAL_VISION_MODEL=.*/LOCAL_VISION_MODEL=$VISION_MODEL/; t; \$aLOCAL_VISION_MODEL=$VISION_MODEL" .env
  echo ">> edit $REPO_DIR/service/.env : NEBIUS_API_KEY (cloud brain when online), BOTTLETREE_URL + BOTTLETREE_DEVICE_KEY (sync)"
fi
sed "s|@REPO@|$REPO_DIR|g; s|@USER@|$KIOSK_USER|g" "$REPO_DIR/jetson/bottletree-appraiser.service" >/etc/systemd/system/bottletree-appraiser.service
systemctl daemon-reload
systemctl enable --now bottletree-appraiser
sleep 4 && curl -fsS http://127.0.0.1:8080/health | jq -c '{ok, brains: .brains.mode, edge: .brains.edge.reachable}'

echo "== kiosk browser (autostart on the desktop session)"
AUTOSTART="/home/$KIOSK_USER/.config/autostart"
sudo -u "$KIOSK_USER" mkdir -p "$AUTOSTART"
sed "s|@REPO@|$REPO_DIR|g" "$REPO_DIR/jetson/kiosk.desktop" | sudo -u "$KIOSK_USER" tee "$AUTOSTART/bottletree-kiosk.desktop" >/dev/null
chmod +x "$REPO_DIR/jetson/kiosk.sh"

echo
echo "Done. Reboot, or run: bash $REPO_DIR/jetson/kiosk.sh"
echo "Service:  systemctl status bottletree-appraiser   logs: journalctl -u bottletree-appraiser -f"
