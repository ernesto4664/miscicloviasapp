import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'miscicloviasapp',
  webDir: 'www',

  // ====== Android ======
  android: {
    allowMixedContent: true,
    backgroundColor: '#000000'
  },

  // ====== Plugins ======
  plugins: {
    // Google Maps (MISMA API KEY, una sola)
    GoogleMaps: {
      apiKey: 'AIzaSyDyUsVGv2XeLpAp394cawPZoWllkwBVrf0'
    },

    // Geolocation (mejor experiencia Android)
    Geolocation: {
      enableHighAccuracy: true
    }
  }
};

export default config;
