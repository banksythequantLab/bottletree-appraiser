#!/usr/bin/env bash
# Full-screen Chromium on the counter display pointed at the local kiosk page.
# getUserMedia needs a secure context: http://127.0.0.1 counts as one, so no TLS needed on-device.
set -u
export DISPLAY="${DISPLAY:-:0}"
unclutter -idle 1 -root &
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/health >/dev/null && break; sleep 1; done
BROWSER=$(command -v chromium-browser || command -v chromium || command -v google-chrome)
exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required \
  --overscroll-history-navigation=0 --disable-pinch --touch-events=enabled \
  --check-for-update-interval=31536000 "http://127.0.0.1:8080/kiosk"
