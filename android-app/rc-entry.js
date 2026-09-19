// Bundled into worker/public/rc-sdk.js. Exposes the RevenueCat Capacitor SDK to the PWA (billing.js) as
// window.RCPurchases. On the plain web (no Capacitor bridge) the calls are unused.
import { Purchases } from '@revenuecat/purchases-capacitor';
window.RCPurchases = Purchases;
