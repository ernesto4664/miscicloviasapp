// =========================
// registrar-activo.page.ts (Google Maps Capacitor - NATIVE FIRST) ✅ FINAL
//  ✅ Cola de posiciones (evita lag por awaits)
//  ✅ Cronómetro no se queda corriendo al salir (Ionic cache)
//  ✅ Permisos robustos + logs
//  ✅ watchPosition captura err
//  ✅ Heartbeat: si watch no entrega, reinicia watch + getCurrentPosition con backoff (FIX anti-loop Xiaomi)
//  ✅ Init zoom correcto + try/catch en llamadas mapa
//  ✅ Polyline segmentada + PROPS correctas (strokeColor/strokeWidth)
//  ✅ Snap Roads adaptado a segmentos, no bloqueante
//  ✅ Heading tipo Google Maps: compás nativo (Capgo) + movimiento
//  ✅ Follow real tipo Google Maps: arrastre/pinch apaga follow, centrar lo reactiva
//  ✅ Throttles marker / polyline / cámara
//  ✅ Guardas anti-TypeError: mapReady + trackingActive en callbacks async
//  ✅ Compass adaptativo
//  ✅ Marker update robusto: updateMarker si existe, si no -> remove+add
//  ✅ watchPosition fallback automático: high -> low
//  ✅ (FIX CRÍTICO) Snap Roads: en Android no se permite URL relativa -> NO más Invalid base URL
//
//  ✅ NUEVO: suavizado de trazado (minDist dinámico + simplificación RDP)
//  ✅ NUEVO: polyline más “gorda” tipo Google Maps (outline + main)
//  ✅ NUEVO: NO se pierde trazado al salir/volver (redraw al re-entrar)
//  ✅ NUEVO: heading estable (bearing por movimiento solo si avanzas > umbral)
//
//  ✅ NUEVO (Google Maps feel real):
//     - Camera padding (HUD) -> cursor abajo SIN inventar coordenadas
//     - followCamera() sin offsetM; el “cursor abajo” lo hace el padding
// =========================

import {
  Component, AfterViewInit, OnDestroy, ElementRef, ViewChild,
  inject, computed, signal, effect, EffectRef, NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ToastController, Platform, ModalController } from '@ionic/angular';
import { Router } from '@angular/router';

import { Geolocation, Position } from '@capacitor/geolocation';
import { GoogleMap } from '@capacitor/google-maps';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

import { CapgoCompass } from '@capgo/capacitor-compass';

import { TrackService } from '../../core/services/track.service';
import { FinishConfirmModal } from './finish-confirm.modal';
import { environment } from '../../../environments/environment';

type LonLat = [number, number];

interface FollowInfo {
  spKmh?: number;
  prev?: LonLat | null;
}

@Component({
  standalone: true,
  selector: 'app-registrar-activo',
  templateUrl: './registrar-activo.page.html',
  styleUrls: ['./registrar-activo.page.scss'],
  imports: [IonicModule, CommonModule],
})
export class RegistrarActivoPage implements AfterViewInit, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;
  @ViewChild('hudEl', { static: false }) hudEl?: ElementRef<HTMLDivElement>;

  private trk = inject(TrackService);
  private toast = inject(ToastController);
  private modalCtrl = inject(ModalController);
  private router = inject(Router);
  private platform = inject(Platform);
  private zone = inject(NgZone);

  state = this.trk.stateSig;
  distanceKm = this.trk.distanceKmSig;
  speedKmh = this.trk.speedKmhSig;

  // =========================
  // DEBUG / LOGS
  // =========================
  private readonly DEBUG = true;
  private log(...args: any[]) { if (this.DEBUG) console.log('[MC-TRACK]', ...args); }
  private warn(...args: any[]) { if (this.DEBUG) console.warn('[MC-TRACK]', ...args); }
  private err(...args: any[]) { console.error('[MC-TRACK]', ...args); }

  // =========================
  // GEO CONFIG (Xiaomi/MIUI friendly)
  // =========================
  private readonly GEO_HIGH = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 } as const;
  private readonly GEO_LOW  = { enableHighAccuracy: false, timeout: 12000, maximumAge: 60_000 } as const;
  private readonly WATCH_HIGH = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 } as const;
  private readonly WATCH_LOW  = { enableHighAccuracy: false, maximumAge: 20_000, timeout: 15000 } as const;

  // ---- Camera tuning ----
  private readonly CAM_SLOW_KMH = 6;
  private readonly CAM_MIN_INTERVAL_SLOW_MS = 520;
  private readonly CAM_MIN_INTERVAL_FAST_MS = 220;

  private camBearing = 0;

  // =========================
  // CRONÓMETRO
  // =========================
  private tick = signal(0);
  private tickTimer?: any;
  private inView = signal(false);

  private tickEff: EffectRef = effect(() => {
    const view = this.inView();
    const st = this.state();

    if (view && st === 'recording') {
      if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick.update(v => v + 1), 1000);
    } else {
      if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
    }
  });

  timeStr = computed(() => {
    this.tick();
    const st = this.state();
    const start = this.trk.startedAtSig();
    if (st === 'idle' || !start) return '00:00:00';

    const nowOrPaused = (st === 'paused' ? this.trk.pauseStartedAtSig() : Date.now());
    const ms = (nowOrPaused || Date.now()) - start - this.trk.pausedAccumMsSig();
    return this.msToHMS(ms);
  });

  // =========================
  // MAPA
  // =========================
  private map?: GoogleMap;
  private mapReady = false;

  private trackingActive = false;

  private ensureMapReady(): boolean {
    return !!this.map && this.mapReady && this.trackingActive && this.inView();
  }

  // ✅ FIX: “map listo” pero SIN exigir trackingActive/inView (para marker instantáneo)
  private mapUsable(): boolean {
    return !!this.map && this.mapReady;
  }

  private lastCenter: LonLat | null = null;

  private lastMoveBearing: number | null = null;
  private lastMoveBearingFrom?: LonLat;

  private lastBearing = 0;
  private headingDeg = 0;

  private readonly FOLLOW_ZOOM = 18;

  private readonly IGNORE_ACC = 999;
  private watchId?: string;

  // =========================
  // FOLLOW MODE
  // =========================
  private followEnabled = true;
  private downX = 0;
  private downY = 0;
  private pointerIsDown = false;

  // =========================
  // EMA GPS
  // =========================
  private emaLat?: number;
  private emaLng?: number;
  private ema(alpha: number, lat: number, lng: number): LonLat {
    this.emaLat = this.emaLat === undefined ? lat : alpha * lat + (1 - alpha) * this.emaLat;
    this.emaLng = this.emaLng === undefined ? lng : alpha * lng + (1 - alpha) * this.emaLng;
    return [this.emaLng, this.emaLat];
  }

  // =========================
  // MARKER
  // =========================
  private userMarkerId?: string;
  private readonly NAV_ICON_URL = 'assets/icon/up-arrow.png';
  private readonly NAV_ICON_SIZE = 48;
  private readonly ICON_BEARING_OFFSET = 0;

  private lastMarkerAt = 0;
  private readonly MARKER_MIN_INTERVAL_MS = 90;

  // =========================
  // “Blue dot” nativo (opcional)
  // =========================
  private readonly USE_NATIVE_LOCATION_DOT = false;

  // =========================
  // TRAZADO (Polyline)
  // =========================
  private activeLineIdsMain: string[] = [];
  private activeLineIdsOutline: string[] = [];
  private activeSegments: LonLat[][] = [[]];

  private readonly TRACE_MIN_METERS_BASE = 2.2;
  private readonly TRACE_MAX_POINTS = 7000;
  private lastDrawPoint: LonLat | null = null;
  private readonly MAX_JUMP_METERS = 80;

  private polyBusy = false;
  private lastPolyAt = 0;
  private readonly POLY_MIN_INTERVAL_MS = 750;

  private readonly SIMPLIFY_MIN_POINTS = 10;
  private readonly SIMPLIFY_EPS_MIN_M = 1.8;
  private readonly SIMPLIFY_EPS_MAX_M = 6.0;

  private readonly TRACE_WIDTH_MAIN = 10;
  private readonly TRACE_WIDTH_OUTLINE = 14;
  private readonly TRACE_COLOR_MAIN = '#2b9bff';
  private readonly TRACE_COLOR_OUTLINE = '#0b1220';

  // =========================
  // SNAP (ROADS)  ✅ más Google Maps
  // =========================
  private snapBusy = false;
  private lastSnapAtMs = 0;
  private snapAnchor: LonLat | null = null;

  // ✅ antes: 250m / 12s
  private readonly SNAP_EVERY_METERS = 60;
  private readonly SNAP_MIN_SECONDS = 4;
  private readonly SNAP_TAIL_POINTS = 80;

  // =========================
  // MAP STYLE
  // =========================
  private readonly DARK_MAP_STYLE: any[] = [
    { elementType: 'geometry', stylers: [{ color: '#121822' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#b7c7d3' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#121822' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a3440' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2b9bff' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0c1a26' }] },
  ];

  // =========================
  // HEADING (Brújula NATIVA + fallback web)
  // =========================
  private compassHeadingDeg: number | null = null;
  private compassOk = false;
  private compassHandle?: PluginListenerHandle;
  private compassBootTimer?: any;

  private deviceHeadingDeg: number | null = null;
  private deviceHeadingOk = false;
  private orientationHandler?: (ev: DeviceOrientationEvent) => void;

  private compassActive = false;
  private compassStarting = false;
  private slowSinceMs: number | null = null;

  private readonly HEADING_COMPASS_PRIORITY_KMH = 8.0;
  private readonly HEADING_BLEND_END_KMH = 14.0;
  private readonly COMPASS_ON_BELOW_KMH = 10.0;
  private readonly COMPASS_OFF_ABOVE_KMH = 16.0;
  private readonly COMPASS_SLOW_ON_MS = 0;

  private readonly MOVE_BEAR_MIN_METERS = 4.0;

  // =========================
  // POS QUEUE
  // =========================
  private posBusy = false;
  private pendingPos: Position | null = null;

  // =========================
  // CAMERA THROTTLE
  // =========================
  private lastCamAt = 0;

  // =========================
  // USER INTERACTION HANDLERS
  // =========================
  private _detachFns: Array<() => void> = [];

  // =========================
  // WATCH “HEARTBEAT” (FIX: restart + backoff)
  // =========================
  private lastPosAtMs = 0;
  private heartbeatTimer?: any;
  private readonly HEARTBEAT_EVERY_MS = 3500;
  private readonly HEARTBEAT_STALE_MS = 6500;

  private hbFailCount = 0;
  private hbNextAllowedAt = 0;

  private watchLastRestartAt = 0;
  private readonly WATCH_RESTART_MIN_MS = 12_000;

  // =========================
  // CAMERA PADDING (Google Maps feel)
  // =========================
  private paddingApplied = false;
  private lastPadding = { top: 0, bottom: 0, left: 0, right: 0 };

  async ngAfterViewInit() {
    await this.platform.ready();
  }

  // ============================================================
  // URL BUILDER (NO TOCA environment)
  // ============================================================
  private buildApiUrl(path: string): string {
    const raw = String((environment as any).apiUrl ?? '').trim();
    if (!raw) return '';
    const base = raw.replace(/\/+$/, '');
    const cleanPath = String(path).replace(/^\/+/, '');
    return `${base}/${cleanPath}`;
  }

  // ============================================================
  // PERMISSIONS
  // ============================================================
  private async ensurePerms(): Promise<boolean> {
    try {
      const perm = await Geolocation.checkPermissions();
      this.log('checkPermissions:', perm);
      if ((perm as any).location === 'granted') return true;

      const req = await Geolocation.requestPermissions();
      this.log('requestPermissions:', req);
      return (req as any).location === 'granted';
    } catch (e) {
      this.warn('ensurePerms error:', e);
      return false;
    }
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================
  async ionViewDidEnter() {
    this.inView.set(true);
    this.trackingActive = true;

    this.log('ionViewDidEnter() platform=', Capacitor.getPlatform(), 'native=', Capacitor.isNativePlatform());

    // ✅ restore si venimos desde cache
    try { this.trk.restoreIfAny(); } catch {}

    // ✅ Si NO hay actividad, la iniciamos
    try {
      if (this.trk.stateSig() === 'idle') await this.trk.start();
    } catch (e) {
      this.warn('trk.start error:', e);
    }

    document.body.classList.add('gm-native-page');
    await this.platform.ready();

    // ✅ NO hard reset si ya existe un recorrido activo
    const hasActive = this.trk.stateSig() !== 'idle';

    await this.cleanupAll(!hasActive);
    await this.waitForLayout();

    const ok = await this.ensurePerms();
    if (!ok) {
      await this.toastMsg('Necesitamos permisos de ubicación para registrar.');
      this.router.navigateByUrl('/tabs/registrar');
      return;
    }

    // ✅ CLAVE: usa lastFix precargado por pantalla anterior
    let ll: LonLat = this.lastCenter ?? [-70.6693, -33.4489];

    const fix = (this.trk as any).getFreshLastFix?.(25_000);
    if (fix?.ll) {
      ll = fix.ll;
      this.log('using fresh lastFix for instant center', fix);
    } else {
      try {
        Geolocation.getCurrentPosition(this.GEO_HIGH).catch(() => null); // warm-up

        const p = await Geolocation.getCurrentPosition(this.GEO_HIGH);
        ll = [p.coords.longitude, p.coords.latitude];
        this.log('getCurrentPosition(highAcc) ok:', p.coords);
      } catch (e) {
        this.warn('getCurrentPosition(highAcc) failed:', e);
        try {
          const p2 = await Geolocation.getCurrentPosition(this.GEO_LOW);
          ll = [p2.coords.longitude, p2.coords.latitude];
          this.log('getCurrentPosition(lowAcc) ok:', p2.coords);
        } catch (e2) {
          this.warn('getCurrentPosition(lowAcc) failed:', e2);
        }
      }
    }

    this.lastCenter = ll;
    if (!this.snapAnchor) this.snapAnchor = ll;

    this.followEnabled = true;

    await this.initMap(ll);

    // ✅ espera 1 frame para medir HUD y aplicar padding real
    await new Promise(r => requestAnimationFrame(() => r(true)));
    await this.applyMapPadding();

    this.attachUserInteractionHandlers();

    await this.setNativeLocationDot(this.USE_NATIVE_LOCATION_DOT);

    // ✅ crear marker inicial SOLO requiere mapReady
    if (!this.USE_NATIVE_LOCATION_DOT) {
      await this.ensureUserMarker(ll, 0);
    }

    await this.kickCamera(ll);

    // compás adaptativo: parte OFF
    this.stopNativeCompass();
    this.stopDeviceHeadingFallback();
    this.compassActive = false;
    this.compassStarting = false;
    this.slowSinceMs = null;

    // ✅ re-dibujar al volver
    await this.redrawAllSegments();

    this.startWatch();
    this.startHeartbeat();
  }

  ionViewWillLeave() {
    this.inView.set(false);
    this.trackingActive = false;

    // soft cleanup: no borra segmentos
    void this.cleanupAll(false);

    document.body.classList.remove('gm-native-page');
  }

  ngOnDestroy() {
    this.inView.set(false);
    this.trackingActive = false;
    void this.cleanupAll(false);
    this.tickEff.destroy();
    document.body.classList.remove('gm-native-page');
  }

  // ============================================================
  // CAMERA PADDING (Google Maps feel)
  // ============================================================
  private async applyMapPadding() {
    if (!this.map || !this.mapReady) return;

    const headerPx = 56 + 12;
    const hudPx = this.hudEl?.nativeElement?.getBoundingClientRect()?.height ?? 220;

    const bottomPx = Math.round(hudPx + 28);
    const pad = { top: headerPx, bottom: bottomPx, left: 0, right: 0 };

    if (
      this.paddingApplied &&
      pad.top === this.lastPadding.top &&
      pad.bottom === this.lastPadding.bottom
    ) return;

    this.lastPadding = pad;
    this.paddingApplied = true;

    try {
      const anyMap = this.map as any;
      if (typeof anyMap.setPadding === 'function') {
        await anyMap.setPadding(pad);
        this.log('map padding applied', pad);
      } else {
        // No rompe nada: solo informa
        this.warn('setPadding not available in this plugin version. (Opcional) actualiza @capacitor/google-maps');
      }
    } catch (e) {
      this.warn('setPadding failed:', e);
    }
  }

  // ============================================================
  // WATCH START (fallback high -> low)
  // ============================================================
  private startWatch() {
    try {
      this.watchId = undefined;

      const start = async (opts: any, label: string) => {
        try {
          const id = await Geolocation.watchPosition(opts, (pos, err) => {
            if (!this.trackingActive) return;

            if (err) { this.warn(`watchPosition(${label}) error:`, err); return; }
            if (!pos) { this.warn(`watchPosition(${label}) pos=null`); return; }

            this.lastPosAtMs = Date.now();

            try {
              const lat = pos.coords.latitude;
              const lng = pos.coords.longitude;
              const acc = (typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : null);
              if (Number.isFinite(lat) && Number.isFinite(lng)) this.trk.setLastFix([lng, lat], acc);
            } catch {}

            this.enqueuePos(pos);
          });

          this.watchId = id;
          this.log(`watchPosition(${label}) started id=`, id);
          return true;
        } catch (e) {
          this.warn(`watchPosition(${label}) failed to start:`, e);
          return false;
        }
      };

      void (async () => {
        const okHigh = await start(this.WATCH_HIGH, 'high');
        if (!okHigh && this.trackingActive) await start(this.WATCH_LOW, 'low');
      })();

    } catch (e) {
      this.err('startWatch exception:', e);
    }
  }

  private async restartWatchIfStale(now: number) {
    if (!this.trackingActive) return;

    const sinceLastRestart = now - this.watchLastRestartAt;
    if (sinceLastRestart < this.WATCH_RESTART_MIN_MS) return;

    this.watchLastRestartAt = now;
    this.warn('HEARTBEAT: restarting watchPosition() ...');

    try {
      if (this.watchId) {
        try { await Geolocation.clearWatch({ id: this.watchId }); } catch {}
        this.watchId = undefined;
      }
    } catch {}

    this.startWatch();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastPosAtMs = Date.now();

    this.hbFailCount = 0;
    this.hbNextAllowedAt = 0;
    this.watchLastRestartAt = 0;

    this.heartbeatTimer = setInterval(async () => {
      if (!this.trackingActive) return;
      if (!this.inView()) return;
      if (!this.mapReady) return;

      const now = Date.now();
      const stale = (now - this.lastPosAtMs) > this.HEARTBEAT_STALE_MS;
      if (!stale) return;

      await this.restartWatchIfStale(now);

      if ((Date.now() - this.lastPosAtMs) <= this.HEARTBEAT_STALE_MS) return;
      if (now < this.hbNextAllowedAt) return;

      this.warn('HEARTBEAT: stale -> getCurrentPosition() fallback');

      try {
        const p = await Geolocation.getCurrentPosition({
          ...this.GEO_HIGH,
          timeout: 30000,
          maximumAge: 1000,
        } as any);

        if (!this.trackingActive) return;

        this.lastPosAtMs = Date.now();
        this.hbFailCount = 0;
        this.hbNextAllowedAt = 0;

        try {
          const lat = p.coords.latitude;
          const lng = p.coords.longitude;
          const acc = (typeof p.coords.accuracy === 'number' ? p.coords.accuracy : null);
          if (Number.isFinite(lat) && Number.isFinite(lng)) this.trk.setLastFix([lng, lat], acc);
        } catch {}

        this.enqueuePos(p);
      } catch (e) {
        this.hbFailCount++;
        const backoffMs = Math.min(60_000, 5_000 * this.hbFailCount);
        this.hbNextAllowedAt = Date.now() + backoffMs;
        this.warn(`HEARTBEAT getCurrentPosition failed x${this.hbFailCount} -> backoff ${backoffMs}ms`, e);
      }
    }, this.HEARTBEAT_EVERY_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      try { clearInterval(this.heartbeatTimer); } catch {}
      this.heartbeatTimer = undefined;
    }
  }

  // ============================================================
  // POS QUEUE
  // ============================================================
  private enqueuePos(pos: Position) {
    if (!this.trackingActive) return;
    this.pendingPos = pos;
    if (this.posBusy) return;
    void this.drainPosQueue();
  }

  private async drainPosQueue() {
    this.posBusy = true;
    try {
      while (this.pendingPos) {
        if (!this.trackingActive) break;
        const p = this.pendingPos;
        this.pendingPos = null;
        await this.onPosition(p);
      }
    } finally {
      this.posBusy = false;
    }
  }

  // ============================================================
  // INIT MAP
  // ============================================================
  private async initMap(center: LonLat) {
    const rect = this.mapEl.nativeElement.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) {
      await new Promise(r => setTimeout(r, 150));
    }

    this.map = await GoogleMap.create({
      id: 'mc_registro_map',
      element: this.mapEl.nativeElement,
      apiKey: environment.googleMapsKey,
      config: {
        center: { lat: center[1], lng: center[0] },
        zoom: this.FOLLOW_ZOOM,
        styles: this.DARK_MAP_STYLE,
        disableDefaultUI: true,
        gestureHandling: 'greedy',
      } as any,
    });

    this.mapReady = true;
    this.log('map created OK');
  }

  private async setNativeLocationDot(enabled: boolean) {
    if (!this.map) return;
    try {
      try { await (this.map as any).setMyLocationEnabled(enabled); } catch {}
      try { await (this.map as any).enableCurrentLocation(enabled); } catch {}
      this.log('native location dot enabled=', enabled);
    } catch (e) {
      this.warn('setNativeLocationDot failed:', e);
    }
  }

  private async kickCamera(ll: LonLat) {
    if (!this.map) return;
    try {
      await this.map.setCamera({
        coordinate: { lat: ll[1], lng: ll[0] },
        zoom: this.FOLLOW_ZOOM,
        bearing: 0,
        animate: false,
      });
    } catch (e) {
      this.warn('kickCamera failed:', e);
    }
  }

  private async waitForLayout() {
    await new Promise(r => requestAnimationFrame(() => r(true)));
    await new Promise(r => requestAnimationFrame(() => r(true)));
    await new Promise(r => setTimeout(r, 90));
  }

  // ============================================================
  // USER INTERACTION => apaga follow SOLO al arrastrar/pinch
  // ============================================================
  private attachUserInteractionHandlers() {
    const el = this.mapEl?.nativeElement;
    if (!el) return;

    const opts: AddEventListenerOptions = { passive: true, capture: true };

    const onPointerDown = (ev: PointerEvent) => {
      this.pointerIsDown = true;
      this.downX = ev.clientX;
      this.downY = ev.clientY;
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (!this.pointerIsDown) return;
      const dx = ev.clientX - this.downX;
      const dy = ev.clientY - this.downY;
      const moved = Math.hypot(dx, dy);

      if (moved > 10) {
        if (this.followEnabled) this.log('follow disabled: user interacting');
        this.followEnabled = false;
      }
    };

    const onPointerUp = () => { this.pointerIsDown = false; };

    // ✅ Touch extra (móvil): más confiable
    const onTouchStart = (ev: TouchEvent) => {
      this.pointerIsDown = true;
      const t = ev.touches?.[0];
      if (!t) return;
      this.downX = t.clientX;
      this.downY = t.clientY;
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (!this.pointerIsDown) return;
      const t = ev.touches?.[0];
      if (!t) return;
      const dx = t.clientX - this.downX;
      const dy = t.clientY - this.downY;
      const moved = Math.hypot(dx, dy);
      if (moved > 10) this.followEnabled = false;
    };
    const onTouchEnd = () => { this.pointerIsDown = false; };

    el.addEventListener('pointerdown', onPointerDown, opts);
    el.addEventListener('pointermove', onPointerMove, opts);
    el.addEventListener('pointerup', onPointerUp, opts);
    el.addEventListener('pointercancel', onPointerUp, opts);

    el.addEventListener('touchstart', onTouchStart, opts);
    el.addEventListener('touchmove', onTouchMove, opts);
    el.addEventListener('touchend', onTouchEnd, opts);
    el.addEventListener('touchcancel', onTouchEnd, opts);

    this._detachFns = [
      () => el.removeEventListener('pointerdown', onPointerDown, true),
      () => el.removeEventListener('pointermove', onPointerMove, true),
      () => el.removeEventListener('pointerup', onPointerUp, true),
      () => el.removeEventListener('pointercancel', onPointerUp, true),

      () => el.removeEventListener('touchstart', onTouchStart, true),
      () => el.removeEventListener('touchmove', onTouchMove, true),
      () => el.removeEventListener('touchend', onTouchEnd, true),
      () => el.removeEventListener('touchcancel', onTouchEnd, true),
    ];
  }

  private detachUserInteractionHandlers() {
    try { this._detachFns.forEach(fn => fn()); } catch {}
    this._detachFns = [];
    this.pointerIsDown = false;
  }

  // ============================================================
  // CLEANUP
  // ============================================================
  private async cleanupAll(hard: boolean) {
    this.pendingPos = null;
    this.posBusy = false;

    this.stopHeartbeat();

    if (this.watchId) {
      try { await Geolocation.clearWatch({ id: this.watchId }); } catch {}
      this.log('watch cleared', this.watchId);
      this.watchId = undefined;
    }

    this.stopNativeCompass();
    this.stopDeviceHeadingFallback();
    this.slowSinceMs = null;
    this.compassActive = false;
    this.compassStarting = false;

    this.detachUserInteractionHandlers();

    await this.removePolylinesFromMapOnly();

    this.userMarkerId = undefined;

    if (this.map) {
      try { await this.map.destroy(); } catch {}
      this.map = undefined;
    }

    this.mapReady = false;

    this.snapBusy = false;
    this.lastSnapAtMs = 0;

    this.hbFailCount = 0;
    this.hbNextAllowedAt = 0;
    this.watchLastRestartAt = 0;

    this.paddingApplied = false;
    this.lastPadding = { top: 0, bottom: 0, left: 0, right: 0 };

    if (hard) {
      this.emaLat = undefined;
      this.emaLng = undefined;

      this.activeSegments = [[]];
      this.lastDrawPoint = null;

      this.activeLineIdsMain = [];
      this.activeLineIdsOutline = [];

      this.lastBearing = 0;
      this.lastMoveBearing = null;
      this.lastMoveBearingFrom = undefined;

      this.lastCamAt = 0;
      this.lastMarkerAt = 0;
      this.lastPolyAt = 0;

      this.followEnabled = true;
      this.lastPosAtMs = 0;

      this.snapAnchor = null;
    }
  }

  private async removePolylinesFromMapOnly() {
    if (!this.map) return;
    const ids: string[] = [];
    ids.push(...this.activeLineIdsMain.filter(Boolean));
    ids.push(...this.activeLineIdsOutline.filter(Boolean));
    if (!ids.length) return;
    try { await (this.map as any).removePolylines(ids); } catch {}
  }

  private async redrawAllSegments() {
    if (!this.map || !this.mapReady) return;

    await this.removePolylinesFromMapOnly();
    this.activeLineIdsMain = new Array(this.activeSegments.length).fill('');
    this.activeLineIdsOutline = new Array(this.activeSegments.length).fill('');

    for (let i = 0; i < this.activeSegments.length; i++) {
      const seg = this.activeSegments[i];
      if (!seg || seg.length < 2) continue;

      const { path, epsM } = this.preparePathForDraw(seg, this.speedKmh(), null);
      if (path.length < 2) continue;

      const idsOutline = await (this.map as any).addPolylines([{
        path,
        strokeColor: this.TRACE_COLOR_OUTLINE,
        strokeWidth: this.TRACE_WIDTH_OUTLINE,
        geodesic: false, // ✅
        zIndex: 1,
      }]);

      const idsMain = await (this.map as any).addPolylines([{
        path,
        strokeColor: this.TRACE_COLOR_MAIN,
        strokeWidth: this.TRACE_WIDTH_MAIN,
        geodesic: false, // ✅
        zIndex: 2,
      }]);

      this.activeLineIdsOutline[i] = idsOutline?.[0] ?? '';
      this.activeLineIdsMain[i] = idsMain?.[0] ?? '';

      this.log('redraw seg', i, 'pts=', seg.length, 'epsM=', epsM.toFixed(2));
    }
  }

  // ============================================================
  // GEO UPDATES
  // ============================================================
  private async onPosition(pos: Position) {
    if (!this.trackingActive) return;
    if (!this.mapReady || !this.map) return;

    const { latitude, longitude, speed, accuracy, heading } = pos.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    if ((accuracy ?? 9999) > this.IGNORE_ACC) return;

    const alpha = (accuracy ?? 9999) <= 25 ? 0.4 : 0.25;
    const ll = this.ema(alpha, latitude, longitude);
    const spKmh = (speed ?? 0) * 3.6;

    this.manageCompassAdaptive(spKmh);

    const moveBear = this.computeMoveBearingStable(ll);
    this.headingDeg = this.fusedHeading({
      gpsHeading: typeof heading === 'number' ? heading : null,
      moveBearing: moveBear,
      spKmh,
    });

    if (!this.USE_NATIVE_LOCATION_DOT) {
      void this.ensureUserMarker(ll, this.headingDeg).catch(() => {});
    }

    // TrackService
    if (this.state() === 'recording') {
      this.trk.onPosition(
        latitude,
        longitude,
        pos.timestamp || Date.now(),
        (typeof speed === 'number' ? speed : undefined),
        (typeof accuracy === 'number' ? accuracy : undefined),
      );
    } else {
      if (this.state() === 'paused') this.trk.speedKmhSig.set(0);
      else if (typeof speed === 'number') this.trk.speedKmhSig.set(Math.max(0, speed * 3.6));
    }

    // Polyline
    if (this.state() === 'recording') {
      const segIndex = this.activeSegments.length - 1;
      const seg = this.activeSegments[segIndex];

      if (!this.lastDrawPoint) {
        this.lastDrawPoint = ll;
        if (seg.length === 0) seg.push(ll);
      } else {
        const d = this.distMeters(this.lastDrawPoint, ll);

        if (d > this.MAX_JUMP_METERS) {
          this.activeSegments.push([ll]);
          this.activeLineIdsMain.push('');
          this.activeLineIdsOutline.push('');
          this.lastDrawPoint = ll;
        } else {
          const minDist = this.dynamicTraceMinMeters(spKmh, accuracy ?? null);
          if (d >= minDist) {
            this.lastDrawPoint = ll;
            seg.push(ll);

            if (seg.length > this.TRACE_MAX_POINTS) seg.shift();

            void this.upsertTrackPolylineThrottled(spKmh, accuracy ?? null);
            void this.maybeSnapRoads(ll);
          }
        }
      }
    }

    void this.followCamera(ll, { spKmh, prev: this.lastCenter }).catch(() => {});
    this.lastCenter = ll;
  }

  private dynamicTraceMinMeters(spKmh: number, acc: number | null): number {
    let m = this.TRACE_MIN_METERS_BASE;

    if (spKmh < 6) m += 1.3;
    if (spKmh < 3) m += 1.2;

    if (acc != null) {
      if (acc > 20) m += 1.0;
      if (acc > 35) m += 1.2;
      if (acc > 60) m += 1.8;
    }

    return Math.min(7.5, Math.max(2.0, m));
  }

  // ============================================================
  // COMPASS ADAPTATIVO
  // ============================================================
  private manageCompassAdaptive(spKmh: number) {
    if (!this.trackingActive) return;

    if (spKmh >= this.COMPASS_OFF_ABOVE_KMH) {
      this.slowSinceMs = null;
      if (this.compassActive || this.compassStarting) {
        this.stopNativeCompass();
        this.compassActive = false;
        this.compassStarting = false;
      }
      return;
    }

    if (spKmh <= this.COMPASS_ON_BELOW_KMH) {
      if (!this.compassActive && !this.compassStarting) {
        if (this.slowSinceMs == null) this.slowSinceMs = Date.now();
        const slowFor = Date.now() - this.slowSinceMs;

        if (slowFor >= this.COMPASS_SLOW_ON_MS) {
          this.compassStarting = true;
          void this.startNativeCompass().then(() => {
            this.compassActive = true;
            this.compassStarting = false;

            if (!this.compassOk) void this.startDeviceHeadingFallback();
          }).catch(() => {
            this.compassStarting = false;
          });
        }
      }
      return;
    }

    this.slowSinceMs = null;
  }

  // ============================================================
  // POLYLINE + throttle (con smoothing)
  // ============================================================
  private async upsertTrackPolylineThrottled(spKmh: number, acc: number | null) {
    const now = Date.now();
    if (now - this.lastPolyAt < this.POLY_MIN_INTERVAL_MS) return;
    this.lastPolyAt = now;
    await this.upsertTrackPolyline(spKmh, acc);
  }

  private preparePathForDraw(
    seg: LonLat[],
    spKmh: number,
    acc: number | null
  ): { path: Array<{lat:number,lng:number}>, epsM: number } {
    let epsM = 2.2;
    if (spKmh < 6) epsM += 0.8;
    if (spKmh < 3) epsM += 1.0;
    if (acc != null) {
      if (acc > 25) epsM += 1.0;
      if (acc > 45) epsM += 1.2;
    }
    epsM = Math.min(this.SIMPLIFY_EPS_MAX_M, Math.max(this.SIMPLIFY_EPS_MIN_M, epsM));

    let pts = seg;
    if (seg.length >= this.SIMPLIFY_MIN_POINTS) {
      pts = this.simplifyRDP(seg, epsM);
    }

    const path = pts.map(p => ({ lat: p[1], lng: p[0] }));
    return { path, epsM };
  }

  private async upsertTrackPolyline(spKmh: number, acc: number | null) {
    if (!this.map || !this.ensureMapReady()) return;

    const segIndex = this.activeSegments.length - 1;
    const seg = this.activeSegments[segIndex];
    if (!seg || seg.length < 2) return;

    if (this.polyBusy) return;
    this.polyBusy = true;

    try {
      const { path, epsM } = this.preparePathForDraw(seg, spKmh, acc);
      if (path.length < 2) return;

      const existingMain = this.activeLineIdsMain[segIndex];
      const existingOutline = this.activeLineIdsOutline[segIndex];
      const rm: string[] = [];
      if (existingMain) rm.push(existingMain);
      if (existingOutline) rm.push(existingOutline);
      if (rm.length) {
        try { await (this.map as any).removePolylines(rm); } catch {}
      }

      const idsOutline = await (this.map as any).addPolylines([{
        path,
        strokeColor: this.TRACE_COLOR_OUTLINE,
        strokeWidth: this.TRACE_WIDTH_OUTLINE,
        geodesic: false, // ✅
        zIndex: 1,
      }]);

      const idsMain = await (this.map as any).addPolylines([{
        path,
        strokeColor: this.TRACE_COLOR_MAIN,
        strokeWidth: this.TRACE_WIDTH_MAIN,
        geodesic: false, // ✅
        zIndex: 2,
      }]);

      this.activeLineIdsOutline[segIndex] = idsOutline?.[0] ?? '';
      this.activeLineIdsMain[segIndex] = idsMain?.[0] ?? '';

      if (this.DEBUG) this.log('poly upsert seg=', segIndex, 'pts=', seg.length, 'drawPts=', path.length, 'epsM=', epsM.toFixed(2));
    } finally {
      this.polyBusy = false;
    }
  }

  // ============================================================
  // SNAP ROADS ✅ URL ABSOLUTA EN ANDROID
  // ============================================================
  private async maybeSnapRoads(curr: LonLat) {
    if (!this.ensureMapReady()) return;
    if (this.snapBusy) return;

    const tail = this.getTailPoints(this.SNAP_TAIL_POINTS);
    if (tail.length < 8) return;

    const now = Date.now();
    if (now - this.lastSnapAtMs < this.SNAP_MIN_SECONDS * 1000) return;

    if (!this.snapAnchor) this.snapAnchor = curr;
    const dist = this.distMeters(this.snapAnchor, curr);
    if (dist < this.SNAP_EVERY_METERS) return;

    const url = this.buildApiUrl('roads/snap');
    if (Capacitor.isNativePlatform() && !url) return;

    this.snapBusy = true;
    this.lastSnapAtMs = now;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interpolate: true,
          points: tail.map(p => ({ lat: p[1], lng: p[0] })),
        }),
      });

      if (!resp.ok) {
        this.warn('snap resp not ok:', resp.status);
        return;
      }

      const data = await resp.json();
      const snapped: LonLat[] = (data?.points ?? [])
        .map((p: any) => [Number(p.lng), Number(p.lat)] as LonLat)
        .filter((p: LonLat) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

      if (snapped.length < 2) return;

      const lastIdx = this.activeSegments.length - 1;
      this.activeSegments[lastIdx] = snapped;
      this.lastDrawPoint = snapped[snapped.length - 1] ?? curr;

      await this.upsertTrackPolyline(this.speedKmh(), null);
      this.snapAnchor = snapped[snapped.length - 1] ?? curr;
    } catch (e) {
      this.warn('snap failed:', e);
    } finally {
      this.snapBusy = false;
    }
  }

  private getTailPoints(maxPoints: number): LonLat[] {
    const out: LonLat[] = [];
    for (let i = this.activeSegments.length - 1; i >= 0; i--) {
      const seg = this.activeSegments[i];
      if (!seg || !seg.length) continue;
      for (let j = seg.length - 1; j >= 0; j--) {
        out.push(seg[j]);
        if (out.length >= maxPoints) break;
      }
      if (out.length >= maxPoints) break;
    }
    return out.reverse();
  }

  // ============================================================
  // MARKER (throttle) - FIX robusto updateMarker
  // ============================================================
  private async ensureUserMarker(ll: LonLat, bearing: number) {
    if (!this.mapUsable()) return;

    const now = Date.now();
    if (now - this.lastMarkerAt < this.MARKER_MIN_INTERVAL_MS) return;
    this.lastMarkerAt = now;

    const rot = this.smoothAngle(
      this.lastBearing,
      this.normalizeDeg(bearing + this.ICON_BEARING_OFFSET),
      0.25
    );
    this.lastBearing = rot;

    const coord = { lat: ll[1], lng: ll[0] };

    if (!this.userMarkerId) {
      const ids = await this.map!.addMarkers([{
        coordinate: coord,
        iconUrl: this.NAV_ICON_URL,
        iconSize: { width: this.NAV_ICON_SIZE, height: this.NAV_ICON_SIZE },
        anchor: { x: 0.5, y: 0.5 },
        rotation: rot,
      } as any]);

      this.userMarkerId = ids?.[0];
      this.log('marker created id=', this.userMarkerId);
      return;
    }

    try {
      const anyMap = this.map as any;

      if (typeof anyMap.updateMarker === 'function') {
        await anyMap.updateMarker({
          id: this.userMarkerId,
          coordinate: coord,
          rotation: rot,
        });
        return;
      }

      if (typeof anyMap.removeMarker === 'function') {
        await anyMap.removeMarker(this.userMarkerId);
      } else if (typeof anyMap.removeMarkers === 'function') {
        await anyMap.removeMarkers([this.userMarkerId]);
      }
    } catch (e) {
      this.warn('marker update/remove failed -> recreate:', e);
    }

    try {
      const ids2 = await this.map!.addMarkers([{
        coordinate: coord,
        iconUrl: this.NAV_ICON_URL,
        iconSize: { width: this.NAV_ICON_SIZE, height: this.NAV_ICON_SIZE },
        anchor: { x: 0.5, y: 0.5 },
        rotation: rot,
      } as any]);

      this.userMarkerId = ids2?.[0];
    } catch (e2) {
      this.warn('marker recreate failed:', e2);
      this.userMarkerId = undefined;
    }
  }

  // ============================================================
  // CAMERA FOLLOW ✅ tipo Google Maps
  //   - SIN offset geográfico
  //   - “cursor abajo” lo hace setPadding()
  // ============================================================
  private async followCamera(center: LonLat, info?: FollowInfo) {
    if (!this.map || !this.ensureMapReady()) return;
    if (!this.followEnabled) return;

    const sp = Math.max(0, info?.spKmh ?? 0);

    const interval =
      sp <= this.CAM_SLOW_KMH
        ? this.CAM_MIN_INTERVAL_SLOW_MS
        : this.CAM_MIN_INTERVAL_FAST_MS;

    const now = Date.now();
    if (now - this.lastCamAt < interval) return;
    this.lastCamAt = now;

    await this.applyMapPadding();

    const targetBearing = this.normalizeDeg(this.lastBearing);
    this.camBearing = this.smoothAngle(this.camBearing, targetBearing, 0.18);

    try {
      await this.map.setCamera({
        coordinate: { lat: center[1], lng: center[0] },
        zoom: this.FOLLOW_ZOOM,
        bearing: this.camBearing,
        animate: true,
      });
    } catch {}
  }

  // ============================================================
  // COMPASS NATIVO (Capgo)
  // ============================================================
  private async startNativeCompass() {
    this.compassOk = false;
    this.compassHeadingDeg = null;

    try {
      const st = await CapgoCompass.checkPermissions();
      if ((st as any)?.compass !== 'granted') {
        const req = await CapgoCompass.requestPermissions();
        if ((req as any)?.compass !== 'granted') {
          this.compassOk = false;
          this.compassHeadingDeg = null;
          return;
        }
      }

      await CapgoCompass.startListening();

      this.compassHandle = await CapgoCompass.addListener('headingChange', (ev: any) => {
        if (!this.trackingActive) return;
        const v = Number(ev?.value);
        if (!Number.isFinite(v)) return;
        this.compassHeadingDeg = this.normalizeDeg(v);
        this.compassOk = true;
      });

      this.compassBootTimer = setTimeout(() => {
        if (this.compassHeadingDeg == null) {
          this.compassOk = false;
          this.warn('native compass no data -> fallback web');
        }
      }, 1200);

      this.log('native compass started');
    } catch (e) {
      this.warn('startNativeCompass failed:', e);
      this.compassOk = false;
      this.compassHeadingDeg = null;
    }
  }

  private stopNativeCompass() {
    try { if (this.compassBootTimer) clearTimeout(this.compassBootTimer); } catch {}
    this.compassBootTimer = undefined;

    try { this.compassHandle?.remove(); } catch {}
    this.compassHandle = undefined;

    this.compassHeadingDeg = null;
    this.compassOk = false;

    try { CapgoCompass.stopListening(); } catch {}
  }

  // ============================================================
  // FALLBACK web deviceorientation
  // ============================================================
  private async startDeviceHeadingFallback() {
    try {
      const anyDO = DeviceOrientationEvent as any;
      if (anyDO?.requestPermission) {
        const res = await anyDO.requestPermission();
        if (res !== 'granted') return;
      }
    } catch {}

    this.orientationHandler = (ev: DeviceOrientationEvent) => {
      const w = ev as any;
      let heading: number | null = null;

      if (typeof w.webkitCompassHeading === 'number') heading = w.webkitCompassHeading;
      else if (typeof ev.alpha === 'number') heading = this.alphaToHeading(ev.alpha);

      if (heading === null) return;

      this.deviceHeadingDeg = this.normalizeDeg(heading);
      this.deviceHeadingOk = true;
    };

    window.addEventListener('deviceorientation', this.orientationHandler, { passive: true });
    this.log('web orientation fallback started');
  }

  private stopDeviceHeadingFallback() {
    if (this.orientationHandler) {
      window.removeEventListener('deviceorientation', this.orientationHandler);
      this.orientationHandler = undefined;
    }
    this.deviceHeadingDeg = null;
    this.deviceHeadingOk = false;
  }

  private alphaToHeading(alpha: number): number {
    let h = 360 - alpha;
    const so = (screen.orientation?.angle ?? (window as any).orientation ?? 0) as number;
    h = h + (typeof so === 'number' ? so : 0);
    return this.normalizeDeg(h);
  }

  // ============================================================
  // HEADING FUSION
  // ============================================================
  private fusedHeading(params: {
    gpsHeading: number | null;
    moveBearing: number | null;
    spKmh: number;
  }): number {
    const { gpsHeading, moveBearing, spKmh } = params;

    const compass =
      (this.compassOk && this.compassHeadingDeg != null)
        ? this.compassHeadingDeg
        : (this.deviceHeadingOk && this.deviceHeadingDeg != null)
          ? this.deviceHeadingDeg
          : null;

    if (compass !== null && spKmh <= this.HEADING_COMPASS_PRIORITY_KMH) {
      return this.smoothAngle(this.lastBearing, compass, 0.25);
    }

    if (compass !== null && moveBearing !== null && spKmh < this.HEADING_BLEND_END_KMH) {
      const t = Math.min(
        1,
        Math.max(0, (spKmh - this.HEADING_COMPASS_PRIORITY_KMH) / (this.HEADING_BLEND_END_KMH - this.HEADING_COMPASS_PRIORITY_KMH))
      );
      const blended = this.blendAngles(compass, moveBearing, t);
      return this.smoothAngle(this.lastBearing, blended, 0.28);
    }

    if (moveBearing !== null) return this.smoothAngle(this.lastBearing, moveBearing, 0.30);

    if (gpsHeading !== null) return this.smoothAngle(this.lastBearing, gpsHeading, 0.20);
    if (compass !== null) return this.smoothAngle(this.lastBearing, compass, 0.18);

    return this.lastBearing;
  }

  private computeMoveBearingStable(curr: LonLat): number | null {
    if (!this.lastMoveBearingFrom) {
      this.lastMoveBearingFrom = curr;
      return this.lastMoveBearing;
    }

    const d = this.distMeters(this.lastMoveBearingFrom, curr);

    if (d < this.MOVE_BEAR_MIN_METERS) {
      return this.lastMoveBearing;
    }

    const b = this.bearing(this.lastMoveBearingFrom, curr);
    this.lastMoveBearingFrom = curr;
    this.lastMoveBearing = b;
    return b;
  }

  private blendAngles(a: number, b: number, t: number): number {
    const d = this.angleDelta(a, b);
    return this.normalizeDeg(a + d * t);
  }

  // ============================================================
  // UI ACTIONS
  // ============================================================
  async center() {
    if (!this.map || !this.mapReady) return;

    this.followEnabled = true;
    await this.applyMapPadding();

    const ll = this.lastCenter;
    if (ll) {
      try {
        await this.map.setCamera({
          coordinate: { lat: ll[1], lng: ll[0] },
          zoom: this.FOLLOW_ZOOM,
          bearing: this.lastBearing,
          animate: true,
        });
        return;
      } catch {}
    }

    try {
      const p = await Geolocation.getCurrentPosition(this.GEO_HIGH);
      const ll2: LonLat = [p.coords.longitude, p.coords.latitude];
      this.lastCenter = ll2;

      await this.map.setCamera({
        coordinate: { lat: ll2[1], lng: ll2[0] },
        zoom: this.FOLLOW_ZOOM,
        bearing: this.lastBearing,
        animate: true,
      });
    } catch (e) {
      this.warn('center() getCurrentPosition failed:', e);
    }
  }

  pauseOrResume() {
    const st = this.state();

    if (st === 'recording') {
      this.zone.run(() => void this.trk.pause());
      return;
    }

    if (st === 'paused') {
      this.zone.run(() => void this.trk.resume());
    }
  }

  async finalizar() {
    const { durationMs, distanceKm, avgSpeedKmh } = this.trk.getSummary();

    const modal = await this.modalCtrl.create({
      component: FinishConfirmModal,
      componentProps: {
        duration: this.msToHMS(durationMs),
        distanceKm,
        avgSpeedKmh,
      },
      breakpoints: [0, 0.6, 0.9],
      initialBreakpoint: 0.6,
      showBackdrop: true,
    });

    await modal.present();

    const { role } = await modal.onWillDismiss<{ save: boolean }>();
    if (role === 'save' || role === 'discard') {
      this.closeAndFinalize(role === 'save');
    }
  }

  private closeAndFinalize(save: boolean) {
    this.trackingActive = false;

    this.stopHeartbeat();

    if (this.watchId) {
      try { Geolocation.clearWatch({ id: this.watchId }); } catch {}
      this.watchId = undefined;
    }

    const { saved } = this.trk.finalize(save);
    if (save && saved) void this.toastMsg('Actividad guardada');

    void this.cleanupAll(true);
    this.router.navigateByUrl('/tabs/registrar');
  }

  private async toastMsg(message: string) {
    const t = await this.toast.create({ message, duration: 1800, position: 'bottom' });
    await t.present();
  }

  // ============================================================
  // RDP SIMPLIFY (Douglas–Peucker) en metros
  // ============================================================
  private simplifyRDP(points: LonLat[], epsilonMeters: number): LonLat[] {
    if (points.length < 3) return points;

    const keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;

    const stack: Array<[number, number]> = [[0, points.length - 1]];

    while (stack.length) {
      const [start, end] = stack.pop()!;
      let maxDist = -1;
      let index = -1;

      const A = points[start];
      const B = points[end];

      for (let i = start + 1; i < end; i++) {
        const P = points[i];
        const d = this.perpDistanceMeters(P, A, B);
        if (d > maxDist) {
          maxDist = d;
          index = i;
        }
      }

      if (maxDist > epsilonMeters && index !== -1) {
        keep[index] = true;
        stack.push([start, index], [index, end]);
      }
    }

    const out: LonLat[] = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
    return out;
  }

  private perpDistanceMeters(p: LonLat, a: LonLat, b: LonLat): number {
    const ax = a[0], ay = a[1];
    const bx = b[0], by = b[1];
    const px = p[0], py = p[1];

    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    if (len2 === 0) return this.distMeters(a, p);

    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    const tt = Math.max(0, Math.min(1, t));
    const proj: LonLat = [ax + tt * dx, ay + tt * dy];
    return this.distMeters(proj, p);
  }

  // ============================================================
  // MATH + UTILS
  // ============================================================
  private msToHMS(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  private normalizeDeg(d: number): number {
    return (d % 360 + 360) % 360;
  }

  private angleDelta(a: number, b: number): number {
    let d = this.normalizeDeg(b) - this.normalizeDeg(a);
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  private smoothAngle(prev: number, next: number, alpha: number): number {
    return this.normalizeDeg(prev + this.angleDelta(prev, next) * alpha);
  }

  private bearing(a: LonLat, b: LonLat): number {
    const [lng1, lat1] = [a[0] * Math.PI / 180, a[1] * Math.PI / 180];
    const [lng2, lat2] = [b[0] * Math.PI / 180, b[1] * Math.PI / 180];
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
      - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  private distMeters(a: LonLat, b: LonLat): number {
    const R = 6371000;
    const dLat = (b[1] - a[1]) * Math.PI / 180;
    const dLng = (b[0] - a[0]) * Math.PI / 180;
    const lat1 = a[1] * Math.PI / 180;
    const lat2 = b[1] * Math.PI / 180;

    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

    return 2 * R * Math.asin(Math.sqrt(h));
  }
}
