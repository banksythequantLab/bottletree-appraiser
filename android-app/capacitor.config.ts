import type { CapacitorConfig } from '@capacitor/cli';

// The Android app is a native shell around the live PWA: same origin as the API, so the session cookie,
// camera capture and the storefront all work unchanged. Native adds Google Play billing through RevenueCat.
const config: CapacitorConfig = {
  appId: 'ai.banksy.bottletree',
  appName: 'Bottle Tree',
  webDir: 'www',
  server: {
    url: 'https://bottletree-app.dj-b02.workers.dev',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#f6f1e7',
  },
  plugins: {
    // Only Google is bundled; the others would drag in SDKs we don't use.
    SocialLogin: {
      providers: { google: true, facebook: false, apple: false, twitter: false },
      logLevel: 1,
    },
  },
};

export default config;
