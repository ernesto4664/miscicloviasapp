// =========================
// registrar-activo.page.ts (Google Maps Capacitor - NATIVE FIRST)
//  ✅ Cola de posiciones (evita lag del cursor por awaits)
//  ✅ Cronómetro no se queda corriendo al salir (Ionic cache)
//  ✅ Permisos robustos
//  ✅ Init zoom correcto + try/catch en llamadas mapa
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
  // CRONÓMETRO
  // =========================
  private tick = signal(0);
  private tickTimer?: any;

  // ✅ Ionic cache: cuando sales de la página, el component puede NO destruirse.
  // Este flag asegura que el interval no quede vivo.
  private inView = signal(false);

  private tickEff: EffectRef = effect(() => {
    // depende de state + inView
    const view = this.inView();
    const st = this.state();

    if (view && st === 'recording') {
      if (!this.tickTimer) {
        this.tickTimer = setInterval(() => this.tick.update(v => v + 1), 1000);
      }
    } else {
      if (this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = undefined;
      }
    }
  });

  timeStr = computed(() => {
    this.tick();
    const st = this.state();
    const start = this.trk.startedAtSig();
    if (st === 'idle' || !start) return '00:00:00';

    const nowOrPaused = (st === 'paused'
      ? this.trk.pauseStartedAtSig()
      : Date.now());

    const ms = (nowOrPaused || Date.now())
      - start
      - this.trk.pausedAccumMsSig();

    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  });

  // =========================
  // MAPA
  // =========================
  private map?: GoogleMap;
  private mapReady = false;

  private lastCenter: LonLat | null = null;
  private lastBearing = 0;
  private headingDeg = 0;

  private readonly FOLLOW_ZOOM = 18;
  private readonly MOVE_MIN_KMH = 0.5;
  private readonly IGNORE_ACC = 999; // (999 => no filtra casi nunca)

  private watchId?: string;

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
  // MARKER (Flecha)
  // =========================
  private userMarkerId?: string;
  private readonly NAV_ICON_URL = 'assets/icon/up-arrow.png';
  private readonly NAV_ICON_SIZE = 48;

  // =========================
  // TRAZADO (Polyline) VISUAL
  // =========================
  private activeLineId?: string;
  private activePath: LonLat[] = [];
  private readonly TRACE_MIN_METERS = 1.2;
  private readonly TRACE_MAX_POINTS = 7000;

  private lastDrawPoint: LonLat | null = null;
  private readonly MAX_JUMP_METERS = 80;

  // =========================
  // SNAP (ROADS)
  // =========================
  private snapBusy = false;
  private lastSnapAtMs = 0;
  private snapAnchor: LonLat | null = null;

  private readonly SNAP_EVERY_METERS = 250;
  private readonly SNAP_MIN_SECONDS = 12;
  private readonly SNAP_TAIL_POINTS = 90;

  // =========================
  // MAP STYLE
  // =========================
  private readonly DARK_MAP_STYLE: google.maps.MapTypeStyle[] = [
    { elementType: 'geometry', stylers: [{ color: '#121822' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#b7c7d3' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#121822' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a3440' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2b9bff' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0c1a26' }] },
  ];

  // =========================
  // DEVICE HEADING
  // =========================
  private deviceHeadingDeg: number | null = null;
  private deviceHeadingOk = false;
  private orientationHandler?: (ev: DeviceOrientationEvent) => void;

  // =========================
  // POS QUEUE (anti backlog)
  // =========================
  private posBusy = false;
  private pendingPos: Position | null = null;

  // =========================
  // LIFECYCLE
  // =========================
  async ngAfterViewInit() {
    await this.platform.ready();
  }

  private async ensurePerms(): Promise<boolean> {
    try {
      const perm = await Geolocation.checkPermissions();
      if (perm.location === 'granted') return true;
      const req = await Geolocation.requestPermissions();
      return req.location === 'granted';
    } catch {
      return false;
    }
  }

  async ionViewDidEnter() {
    this.inView.set(true);

    // 🔒 Blindado: si por cualquier motivo llegué aquí en idle, arranco igual (pero start() debe ser idempotente)
    try {
      if (this.trk.stateSig() === 'idle') {
        await this.trk.start();
      }
    } catch {}

    document.body.classList.add('gm-native-page');
    await this.platform.ready();

    await this.cleanupAll(true);
    await this.waitForLayout();

    // ✅ permisos robustos
    const ok = await this.ensurePerms();
    if (!ok) {
      await this.toastMsg('Necesitamos permisos de ubicación para registrar.');
      // vuelve atrás para no quedar en pantalla rota
      this.router.navigateByUrl('/tabs/registrar');
      return;
    }

    // ✅ robusto: obtenemos posición con reintentos + fallback (no revienta la vista)
    let ll: LonLat = this.lastCenter ?? [-70.6693, -33.4489]; // Santiago fallback

    try {
      // warmup rápido (no bloquea)
      Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }).catch(() => null);

      // intento fuerte
      const p = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
      ll = [p.coords.longitude, p.coords.latitude];
    } catch {
      try {
        // intento más permisivo
        const p2 = await Geolocation.getCurrentPosition({
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 60_000,
        });
        ll = [p2.coords.longitude, p2.coords.latitude];
      } catch {
        // nos quedamos con lastCenter o Santiago
      }
    }

    this.lastCenter = ll;
    this.snapAnchor = ll;

    await this.initMap(ll);
    await this.ensureUserMarker(ll, 0);
    await this.kickCamera(ll);

    await this.startDeviceHeading();

    // ✅ watch robusto + cola (evita lag)
    this.watchId = await Geolocation.watchPosition(
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
      pos => {
        if (!pos) return;
        this.enqueuePos(pos);
      }
    );
  }

  ionViewWillLeave() {
    this.inView.set(false);
    void this.cleanupAll(false);
    document.body.classList.remove('gm-native-page');
  }

  ngOnDestroy() {
    this.inView.set(false);
    void this.cleanupAll(false);
    this.tickEff.destroy();
    document.body.classList.remove('gm-native-page');
  }

  // =========================
  // POS QUEUE
  // =========================
  private enqueuePos(pos: Position) {
    // siempre dejamos la última (si llegan 10, procesamos 1: la más reciente)
    this.pendingPos = pos;
    if (this.posBusy) return;
    void this.drainPosQueue();
  }

  private async drainPosQueue() {
    this.posBusy = true;
    try {
      while (this.pendingPos) {
        const p = this.pendingPos;
        this.pendingPos = null;
        await this.onPosition(p);
      }
    } finally {
      this.posBusy = false;
    }
  }

  // =========================
  // INIT MAP
  // =========================
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

    try { await (this.map as any).setMyLocationEnabled(false); } catch {}
    try { await (this.map as any).enableCurrentLocation(false); } catch {}
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
    } catch {}
  }

  private async waitForLayout() {
    await new Promise(r => requestAnimationFrame(() => r(true)));
    await new Promise(r => requestAnimationFrame(() => r(true)));
    await new Promise(r => setTimeout(r, 90));
  }

  // =========================
  // CLEANUP
  // =========================
  private async cleanupAll(hard: boolean) {
    // detener cola
    this.pendingPos = null;
    this.posBusy = false;

    if (this.watchId) {
      try { await Geolocation.clearWatch({ id: this.watchId }); } catch {}
      this.watchId = undefined;
    }

    this.stopDeviceHeading();
    await this.clearPolyline();

    this.userMarkerId = undefined;

    if (this.map) {
      try { await this.map.destroy(); } catch {}
      this.map = undefined;
    }

    this.mapReady = false;

    this.snapBusy = false;
    this.lastSnapAtMs = 0;
    this.snapAnchor = null;

    if (hard) {
      this.emaLat = undefined;
      this.emaLng = undefined;
      this.activePath = [];
      this.lastDrawPoint = null;
      this.lastBearing = 0;
    }
  }

  private async clearPolyline() {
    if (this.map && this.activeLineId) {
      try { await (this.map as any).removePolylines([this.activeLineId]); } catch {}
    }
    this.activeLineId = undefined;
    this.activePath = [];
    this.lastDrawPoint = null;
  }

  // =========================
  // GEO UPDATES
  // =========================
  private async onPosition(pos: Position) {
    if (!this.mapReady || !this.map) return;

    const { latitude, longitude, speed, accuracy, heading } = pos.coords;

    const isFirst = !this.lastCenter;
    if (!isFirst && (accuracy ?? 9999) > this.IGNORE_ACC) return;

    const alpha = (accuracy ?? 9999) <= 25 ? 0.4 : 0.25;
    const ll = this.ema(alpha, latitude, longitude);
    const spKmh = (speed ?? 0) * 3.6;

    // 1) heading fusion
    this.headingDeg = this.fusedHeading({
      gpsHeading: heading ?? null,
      prev: this.lastCenter,
      curr: ll,
      spKmh,
    });

    // 2) marker flecha
    try { await this.ensureUserMarker(ll, this.headingDeg); } catch {}

    // 3) alimentar TrackService SOLO cuando grabas
    if (this.state() === 'recording') {
      this.trk.onPosition(
        latitude,
        longitude,
        pos.timestamp || Date.now(),
        (typeof speed === 'number' ? speed : undefined),
        (typeof accuracy === 'number' ? accuracy : undefined),
      );
    } else {
      // si NO grabas, solo UI
      if (this.state() === 'paused') this.trk.speedKmhSig.set(0);
      else if (typeof speed === 'number') this.trk.speedKmhSig.set(Math.max(0, speed * 3.6));
    }

    // 4) polyline VISUAL solo grabando
    if (this.state() === 'recording') {
      if (!this.lastDrawPoint) {
        this.lastDrawPoint = ll;
        if (this.activePath.length === 0) this.activePath.push(ll);
      } else {
        const d = this.distMeters(this.lastDrawPoint, ll);
        if (d >= this.TRACE_MIN_METERS && d <= this.MAX_JUMP_METERS) {
          this.lastDrawPoint = ll;
          this.activePath.push(ll);
          if (this.activePath.length > this.TRACE_MAX_POINTS) this.activePath.shift();

          try { await this.upsertTrackPolyline(); } catch {}
          void this.maybeSnapRoads(ll);
        }
      }
    }

    // 5) cámara follow
    try { await this.followCamera(ll, { spKmh, prev: this.lastCenter }); } catch {}

    this.lastCenter = ll;
  }

  // =========================
  // POLYLINE
  // =========================
  private async upsertTrackPolyline() {
    if (!this.map) return;
    if (this.activePath.length < 2) return;

    const path = this.activePath.map(p => ({ lat: p[1], lng: p[0] }));

    if (this.activeLineId) {
      try { await (this.map as any).removePolylines([this.activeLineId]); } catch {}
      this.activeLineId = undefined;
    }

    const ids = await (this.map as any).addPolylines([{
      path,
      color: '#2b9bff',
      width: 7,
      geodesic: true,
    }]);

    this.activeLineId = ids?.[0];
  }

  // =========================
  // SNAP ROADS
  // =========================
  private async maybeSnapRoads(curr: LonLat) {
    if (this.snapBusy) return;
    if (this.activePath.length < 8) return;

    const now = Date.now();
    if (now - this.lastSnapAtMs < this.SNAP_MIN_SECONDS * 1000) return;

    if (!this.snapAnchor) this.snapAnchor = curr;

    const dist = this.distMeters(this.snapAnchor, curr);
    if (dist < this.SNAP_EVERY_METERS) return;

    const tail = this.activePath.slice(-this.SNAP_TAIL_POINTS);
    if (tail.length < 2) return;

    // ✅ blindado para tu env (apiUrl puede venir con /api/v1 incluido)
    const apiBase = (environment as any).apiUrl ?? '';
    const url = apiBase
      ? `${String(apiBase).replace(/\/$/, '')}/roads/snap`
      : `/roads/snap`;

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

      if (!resp.ok) return;

      const data = await resp.json();
      const snapped: LonLat[] = (data?.points ?? [])
        .map((p: any) => [Number(p.lng), Number(p.lat)] as LonLat)
        .filter((p: LonLat) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

      if (snapped.length < 2) return;

      const keep = this.activePath.length - tail.length;
      this.activePath = [...this.activePath.slice(0, keep), ...snapped];

      await this.upsertTrackPolyline();

      this.snapAnchor = this.activePath[this.activePath.length - 1] ?? curr;
    } catch {
      // silencioso
    } finally {
      this.snapBusy = false;
    }
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

  // =========================
  // MARKER
  // =========================
  private async ensureUserMarker(ll: LonLat, bearing: number) {
    if (!this.map) return;

    const rot = this.smoothAngle(this.lastBearing, bearing, 0.25);
    this.lastBearing = rot;

    if (!this.userMarkerId) {
      const ids = await this.map.addMarkers([{
        coordinate: { lat: ll[1], lng: ll[0] },
        iconUrl: this.NAV_ICON_URL,
        iconSize: { width: this.NAV_ICON_SIZE, height: this.NAV_ICON_SIZE },
        anchor: { x: 0.5, y: 0.5 },
        rotation: rot,
      } as any]);

      this.userMarkerId = ids?.[0];
    } else {
      await (this.map as any).updateMarker({
        id: this.userMarkerId,
        coordinate: { lat: ll[1], lng: ll[0] },
        rotation: rot,
      });
    }
  }

  // =========================
  // CAMERA FOLLOW
  // =========================
  private async followCamera(center: LonLat, info?: FollowInfo) {
    if (!this.map) return;

    const sp = info?.spKmh ?? 0;
    if (sp < this.MOVE_MIN_KMH) {
      await this.map.setCamera({
        coordinate: { lat: center[1], lng: center[0] },
        zoom: this.FOLLOW_ZOOM,
        bearing: this.lastBearing,
        animate: false,
      });
      return;
    }

    const OFFSET_M = 14;
    const rad = this.lastBearing * Math.PI / 180;
    const dLat = (OFFSET_M / 6371000) * Math.cos(rad);
    const dLng = (OFFSET_M / 6371000) * Math.sin(rad) / Math.cos(center[1] * Math.PI / 180);

    await this.map.setCamera({
      coordinate: {
        lat: center[1] + dLat * 180 / Math.PI,
        lng: center[0] + dLng * 180 / Math.PI,
      },
      zoom: this.FOLLOW_ZOOM,
      bearing: this.lastBearing,
      animate: true,
    });
  }

  // =========================
  // DEVICE HEADING
  // =========================
  private async startDeviceHeading() {
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

      if (typeof w.webkitCompassHeading === 'number') {
        heading = w.webkitCompassHeading;
      } else if (typeof ev.alpha === 'number') {
        heading = 360 - ev.alpha;
      }

      if (heading === null) return;
      this.deviceHeadingDeg = this.normalizeDeg(heading);
      this.deviceHeadingOk = true;
    };

    window.addEventListener('deviceorientation', this.orientationHandler, { passive: true });
  }

  private stopDeviceHeading() {
    if (this.orientationHandler) {
      window.removeEventListener('deviceorientation', this.orientationHandler);
      this.orientationHandler = undefined;
    }
    this.deviceHeadingDeg = null;
    this.deviceHeadingOk = false;
  }

  // =========================
  // HEADING FUSION
  // =========================
  private fusedHeading(params: {
    gpsHeading: number | null;
    prev: LonLat | null | undefined;
    curr: LonLat;
    spKmh: number;
  }): number {
    const { gpsHeading, prev, curr, spKmh } = params;

    if (
      spKmh < this.MOVE_MIN_KMH &&
      this.deviceHeadingOk &&
      this.deviceHeadingDeg !== null
    ) {
      return this.smoothAngle(this.lastBearing, this.deviceHeadingDeg, 0.18);
    }

    if (spKmh >= this.MOVE_MIN_KMH && prev) {
      const moveBear = this.bearing(prev, curr);
      return this.smoothAngle(this.lastBearing, moveBear, 0.25);
    }

    if (gpsHeading !== null) {
      return this.smoothAngle(this.lastBearing, gpsHeading, 0.18);
    }

    return this.lastBearing;
  }

  // =========================
  // UI ACTIONS
  // =========================
  async center() {
    if (!this.map || !this.mapReady) return;
    const ll = this.lastCenter;
    if (!ll) return;

    try {
      await this.map.setCamera({
        coordinate: { lat: ll[1], lng: ll[0] },
        zoom: this.FOLLOW_ZOOM,
        bearing: this.lastBearing,
        animate: true,
      });
    } catch {}
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
    if (this.watchId) {
      try { Geolocation.clearWatch({ id: this.watchId }); } catch {}
      this.watchId = undefined;
    }

    const { saved } = this.trk.finalize(save);
    if (save && saved) void this.toastMsg('Actividad guardada');

    void this.clearPolyline();
    this.router.navigateByUrl('/tabs/registrar');
  }

  private async toastMsg(message: string) {
    const t = await this.toast.create({
      message,
      duration: 1800,
      position: 'bottom',
    });
    await t.present();
  }

  private msToHMS(ms: number) {
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  // =========================
  // MATH
  // =========================
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
}
