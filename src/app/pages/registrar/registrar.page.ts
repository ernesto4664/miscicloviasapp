// =========================
// registrar.page.ts ✅ COMPLETO (PARTE 1/2)
//  ✅ Mini mapa Leaflet
//  ✅ Precalienta GPS (best-of-N + getCurrentPosition)
//  ✅ Mini resumen si hay track activo
//  ✅ Hand-off CRÍTICO: trk.setLastFix() para que registrar-activo centre INSTANTE
// =========================

import {
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  inject,
  computed,
  signal,
  effect,
  EffectRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// Ionic (standalone)
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
  IonMenuButton,
  IonButton,
  IonFab,
  IonFabButton,
  IonIcon,
} from '@ionic/angular/standalone';

// Servicios Ionic no-standalone
import { NavController, ToastController, Platform, ModalController } from '@ionic/angular';

import { Geolocation, Position } from '@capacitor/geolocation';
import { Router } from '@angular/router';
import * as L from 'leaflet';

import { AuthService } from '../../core/services/auth.service';
import { TrackService } from '../../core/services/track.service';
import { TrackingModalComponent } from './tracking-modal.component';

type LonLat = [number, number];

@Component({
  standalone: true,
  selector: 'app-registrar',
  templateUrl: './registrar.page.html',
  styleUrls: ['./registrar.page.scss'],
  imports: [
    IonIcon,
    IonFabButton,
    IonFab,
    IonButton,
    CommonModule,
    FormsModule,
    IonButtons,
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    IonMenuButton,
  ],
})
export class RegistrarPage implements OnInit, AfterViewInit, OnDestroy {
  private nav = inject(NavController);
  private router = inject(Router);
  private auth = inject(AuthService);
  private toast = inject(ToastController);
  private platform = inject(Platform);
  private trk = inject(TrackService);
  private modalCtrl = inject(ModalController);

  @ViewChild('previewMapEl', { static: true }) previewMapEl!: ElementRef<HTMLDivElement>;
  private previewMap?: L.Map;
  private previewMarker?: L.CircleMarker;

  starting = false;

  // =========================================================
  // ✅ Señales del estado de tracking (para mini-resumen)
  // =========================================================
  state = this.trk.stateSig;
  distanceKm = this.trk.distanceKmSig;
  speedKmh = this.trk.speedKmhSig;

  hasActive = computed(() => {
    const st = this.state();
    return st === 'recording' || st === 'paused';
  });

  isPaused = computed(() => this.state() === 'paused');

  statusLabel = computed(() => {
    const st = this.state();
    if (st === 'recording') return 'Grabando';
    if (st === 'paused') return 'Pausado';
    return 'Sin actividad';
  });

  distanceKmStr = computed(() => {
    const km = Number(this.distanceKm());
    if (!Number.isFinite(km) || km <= 0) return '0.00 km';
    return `${km.toFixed(2)} km`;
  });

  speedKmhStr = computed(() => {
    const sp = Number(this.speedKmh());
    if (!Number.isFinite(sp) || sp <= 0) return '0 km/h';
    return `${sp.toFixed(1)} km/h`;
  });

  // --- tick para que el tiempo se actualice cada segundo cuando hay actividad ---
  private tick = signal(0);
  private tickTimer?: any;

  private tickEff: EffectRef = effect(() => {
    const active = this.hasActive();
    if (active) {
      if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick.update((v) => v + 1), 1000);
    } else {
      if (this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = undefined;
      }
    }
  });

  activeTimeStr = computed(() => {
    this.tick(); // fuerza recalcular cada segundo
    const st = this.state();
    const start = this.trk.startedAtSig?.() ?? null;
    if (!start || (st !== 'recording' && st !== 'paused')) return '00:00:00';

    const pausedAccum = this.trk.pausedAccumMsSig?.() ?? 0;
    const pauseStartedAt = this.trk.pauseStartedAtSig?.() ?? null;

    const nowOrPaused = st === 'paused' && pauseStartedAt ? pauseStartedAt : Date.now();
    const ms = Math.max(0, nowOrPaused - start - pausedAccum);
    return this.msToHMS(ms);
  });

  // =========================================================
  // ---- Calidad / suavizado (para el preview) ----
  // =========================================================
  private readonly ACC_GOOD = 20; // m
  private readonly ACC_OK = 50; // m

  private emaLat?: number;
  private emaLng?: number;

  private ema(alpha: number, lat: number, lng: number): L.LatLng {
    this.emaLat = this.emaLat === undefined ? lat : alpha * lat + (1 - alpha) * this.emaLat;
    this.emaLng = this.emaLng === undefined ? lng : alpha * lng + (1 - alpha) * this.emaLng;
    return L.latLng(this.emaLat, this.emaLng);
  }

  ngOnInit() {}

  ngAfterViewInit() {
    void this.initPreviewMap();
  }

  // =========================================================
  // Permisos ubicación (robusto)
  // =========================================================
  private async ensurePerms(): Promise<boolean> {
    try {
      const perm = await Geolocation.checkPermissions();
      if ((perm as any).location === 'granted') return true;

      const req = await Geolocation.requestPermissions();
      return (req as any).location === 'granted';
    } catch {
      return false;
    }
  }

  // =========================================================
  // Best-of-N para primer fix (junta varias lecturas y toma la mejor accuracy)
  // =========================================================
  private collectPositions(windowMs = 3500, perPosTimeout = 10000): Promise<import('@capacitor/geolocation').GeolocationPosition> {
    return new Promise(async (resolve, reject) => {
      const picks: import('@capacitor/geolocation').GeolocationPosition[] = [];
      let watchId: string | undefined;

      setTimeout(async () => {
        if (watchId) await Geolocation.clearWatch({ id: watchId });
        if (picks.length) {
          picks.sort((a, b) => (a.coords.accuracy ?? 1e9) - (b.coords.accuracy ?? 1e9));
          resolve(picks[0]);
        } else {
          reject(new Error('no-fix'));
        }
      }, windowMs);

      watchId = await Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 0, timeout: perPosTimeout },
        (pos, err) => {
          if (pos) picks.push(pos as import('@capacitor/geolocation').GeolocationPosition);
        }
      );
    });
  }

  // =========================================================
  // START (navega a activo)
  // =========================================================
  async onStart() {
    if (this.starting) return;
    this.starting = true;

    try {
      const ok = await this.ensurePerms();
      if (!ok) {
        await this.showToast('Necesitamos tu ubicación para iniciar.');
        return;
      }

      // “calentamos” el GPS (rápido, no bloquea)
      Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000 }).catch(() => null);

      // ✅ idempotente: si ya hay recorrido, solo navegamos
      const st = this.state();
      if (st === 'recording' || st === 'paused') {
        await this.router.navigateByUrl('/tabs/registrar/activo');
        return;
      }

      // ✅ arranca tracking (idempotente dentro del servicio)
      await this.trk.start();

      // navega a la página de tracking activo
      await this.router.navigateByUrl('/tabs/registrar/activo');
    } catch {
      await this.showToast('No se pudo iniciar el registro. Reintenta.');
    } finally {
      this.starting = false;
    }
  }

  // ✅ Botón: volver al recorrido activo
  async goToActive() {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.router.navigateByUrl('/tabs/registrar/activo');
    } finally {
      this.starting = false;
    }
  }

  // ----------------- UI utils -----------------
  private async showToast(message: string) {
    const t = await this.toast.create({ message, duration: 2400, position: 'bottom' });
    await t.present();
  }

  // =========================================================
  // Preview Map (Leaflet) + HANDOFF lastFix
  // =========================================================
  private async initPreviewMap() {
    if (!this.previewMap) {
      this.previewMap = L.map(this.previewMapEl.nativeElement, {
        zoomControl: false,
        attributionControl: true,
      });

      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
        maxZoom: 20,
        attribution: '&copy; OpenStreetMap, © CARTO',
      }).addTo(this.previewMap);
    }

    // fallback Santiago
    let center = L.latLng(-33.4489, -70.6693);
    let acc: number | null = null;

    try {
      const pos = (await Promise.race([
        this.collectPositions(2500, 8000),
        Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }),
      ])) as import('@capacitor/geolocation').GeolocationPosition;

      acc = typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : null;

      const base = L.latLng(pos.coords.latitude, pos.coords.longitude);
      const alpha = acc !== null && acc <= this.ACC_GOOD ? 0.35 : acc !== null && acc <= this.ACC_OK ? 0.25 : 0.15;
      center = this.ema(alpha, base.lat, base.lng);

      // ✅ CLAVE: precargar lastFix para que la pantalla activa arranque centrada instantáneo
      this.trk.setLastFix([center.lng, center.lat], acc);
    } catch {
      // si no hay fix, igual dejamos fallback sin romper
      this.trk.setLastFix([center.lng, center.lat], acc);
    }

    this.previewMap.setView(center, 16);

    if (!this.previewMarker) {
      this.previewMarker = L.circleMarker(center, {
        radius: 8,
        color: '#2b8cff',
        weight: 2,
        fillColor: '#2b8cff',
        fillOpacity: 0.25,
      }).addTo(this.previewMap);
    } else {
      this.previewMarker.setLatLng(center);
    }

    // importante para que Leaflet calcule bien el tamaño dentro de Ionic
    setTimeout(() => this.previewMap!.invalidateSize(true), 200);
  }
// =========================
// registrar.page.ts ✅ COMPLETO (PARTE 2/2)
// =========================

  async centerPreview() {
    try {
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 250,
      });

      const acc = typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : null;

      const raw = L.latLng(pos.coords.latitude, pos.coords.longitude);
      const alpha = acc !== null && acc <= this.ACC_GOOD ? 0.35 : acc !== null && acc <= this.ACC_OK ? 0.25 : 0.15;
      const ll = this.ema(alpha, raw.lat, raw.lng);

      // ✅ CLAVE: refrescar lastFix (así al entrar a activo se centra al tiro)
      this.trk.setLastFix([ll.lng, ll.lat], acc);

      this.previewMap?.setView(ll, Math.max(this.previewMap?.getZoom() ?? 16, 16), { animate: true });

      if (!this.previewMarker) {
        this.previewMarker = L.circleMarker(ll, {
          radius: 8,
          color: '#2b8cff',
          weight: 2,
          fillColor: '#2b8cff',
          fillOpacity: 0.25,
        }).addTo(this.previewMap!);
      } else {
        this.previewMarker.setLatLng(ll);
      }
    } catch {
      // fallback: solo recentra a donde ya estabas
      const center = this.previewMap?.getCenter();
      if (center) {
        this.previewMap?.setView(center, 16, { animate: true });
        // igual “handoff” con lo que tengamos
        this.trk.setLastFix([center.lng, center.lat], null);
      }
    }
  }

  // ----------------- utils -----------------
  private msToHMS(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  ngOnDestroy() {
    // ✅ evita fugas del timer del mini-resumen
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.tickEff?.destroy?.();

    // opcional: destruir mapa para liberar memoria si Ionic cachea la vista
    try {
      this.previewMap?.remove();
    } catch {}
    this.previewMap = undefined;
    this.previewMarker = undefined;
  }
}
