// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

// src/environments/environment.ts
export const environment = {
  production: false,
  // Usa 127.0.0.1 para evitar rarezas con IPv6 en simuladores
  apiUrl: 'https://backend-damp-pond-3746.fly.dev/api/v1',
  maptilerKey: '0qOCMRmbn7DIpKSDj0WU',
  firebase: {
    apiKey: 'AIzaSyA1K13zmc-y62o5hY0KlfPXYYYxlfrdu_Q',
    authDomain: 'miscicloviasapp.firebaseapp.com',
    projectId: 'miscicloviasapp',
    storageBucket: 'miscicloviasapp.appspot.com',
    messagingSenderId: '818656114867',
    appId: '1:818656114867:web:c822c26c493e9761ca58c6',
  },
  useBackendExchange: true,
  googleMapsKey: 'AIzaSyDyUsVGv2XeLpAp394cawPZoWllkwBVrf0',
};


/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.
