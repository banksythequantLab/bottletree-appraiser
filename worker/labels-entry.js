// Bundled into public/labels.js — the print sheet needs real encoders, and a garage sale in a
// basement should not depend on a CDN being reachable.
import QRCode from "qrcode";
import JsBarcode from "jsbarcode";

// Payload on the label. Sale-scoped so a tag from last weekend cannot ring up in this weekend's sale.
export const payload = (saleId, tag) => `BT-${String(saleId).replace(/-/g, "").slice(0, 8)}-${String(tag).padStart(3, "0")}`;

export async function qrDataUrl(text, px = 220) {
  return QRCode.toDataURL(text, { width: px, margin: 0, errorCorrectionLevel: "M" });
}

export function code128Svg(text, { width = 1.6, height = 38 } = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  JsBarcode(el, text, { format: "CODE128", width, height, displayValue: false, margin: 0 });
  return el;
}

window.BTLabels = { payload, qrDataUrl, code128Svg };
