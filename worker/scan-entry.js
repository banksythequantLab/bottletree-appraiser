// Bundled into public/scan.js — the Safari/iOS fallback for tag scanning.
// Loaded only when BarcodeDetector is missing, so Android doesn't pay for a decoder it already has.
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

const hints = new Map();
// Only the two formats we print. Narrowing this is most of the speed on an older phone.
hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128]);
hints.set(DecodeHintType.TRY_HARDER, true);

window.BTScan = {
  // video already has a live stream attached; ZXing reads frames off it and leaves it alone.
  async start(video, onHit) {
    const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 180 });
    const controls = await reader.decodeFromVideoElement(video, (result, err) => {
      if (result) { try { onHit(result.getText()); } catch {} }
      // err fires constantly on frames with no code in them — that is normal, not a failure.
    });
    return { stop: () => { try { controls.stop(); } catch {} } };
  },
};
