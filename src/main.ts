import { provideZoneChangeDetection, importProvidersFrom } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular/standalone';

import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';

import { provideRouter, withPreloading, PreloadAllModules } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { AuthInterceptorProvider } from './app/core/interceptors/auth.interceptor';

import { environment } from './environments/environment';
import { provideFirebaseApp, initializeApp } from '@angular/fire/app';
import { provideAuth, getAuth } from '@angular/fire/auth';
import { provideFirestore, getFirestore } from '@angular/fire/firestore';
import { provideStorage, getStorage } from '@angular/fire/storage';
import { StatusBar, Style } from '@capacitor/status-bar';

// ➕ para providers de overlays (Modal/Toast/Alert) en modo standalone
import { IonicModule } from '@ionic/angular';

/** === Ionicons globales === */
import { addIcons } from 'ionicons';
import {
  menuOutline, logInOutline, logOutOutline, personCircleOutline,
  homeOutline, mapOutline, newspaperOutline, bicycleOutline, settingsOutline,
  alertOutline, calendarOutline, playCircleOutline, locateOutline   // ⬅️ IMPORTANTE
} from 'ionicons/icons';

addIcons({
  menuOutline, logInOutline, logOutOutline, personCircleOutline,
  homeOutline, mapOutline, newspaperOutline, bicycleOutline, settingsOutline,
  alertOutline, calendarOutline, playCircleOutline, locateOutline    // ⬅️ REGISTRADO
});

bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },

    provideIonicAngular(),
    importProvidersFrom(IonicModule.forRoot()),  // ⬅️ overlays ok

    provideRouter(routes, withPreloading(PreloadAllModules)),
    provideHttpClient(withInterceptorsFromDi()),
    AuthInterceptorProvider,

    // Firebase
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideAuth(() => getAuth()),
    provideFirestore(() => getFirestore()),
    provideStorage(() => getStorage()),
  ],
});

(async () => {
  try {
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Dark });
  } catch {}
})();
