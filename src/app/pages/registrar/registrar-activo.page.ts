// =========================
// registrar-activo.page.ts (Google Maps Capacitor + Web)
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

// === Tipos auxiliares ===
type LonLat = [number, number];

interface FollowInfo {
  spKmh?: number;
  hasHeading?: boolean;
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

  // ====== estado expuesto por el servicio ======
  state = this.trk.stateSig;
  distanceKm = this.trk.distanceKmSig;
  speedKmh = this.trk.speedKmhSig;

  // ====== Cronómetro en vivo ======
  private tick = signal(0);
  private tickTimer?: any;
  private tickEff: EffectRef = effect(() => {
    const s = this.state();
    if (s === 'recording') {
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
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  });

  // ====== Google Map ======
  private map?: GoogleMap;
  private mapReady = false;

  // cámara / navegación
  private animFollow = true;
  private userInteracting = false;
  private lastCenter: LonLat | null = null;
  private lastBearing = 0;
  private headingDeg = 0;

  private readonly FOLLOW_ZOOM = 18;
  private readonly FOLLOW_TILT = 60;
  private readonly MOVE_MIN_KMH = 2.2;

  // ====== Geoloc / tracking ======
  private watchId?: string;
  private firstFixOk = false;

  // EMA para suavizar GPS
  private emaLat?: number;
  private emaLng?: number;
  private ema(alpha: number, lat: number, lng: number): LonLat {
    this.emaLat = (this.emaLat === undefined) ? lat : (alpha * lat + (1 - alpha) * this.emaLat);
    this.emaLng = (this.emaLng === undefined) ? lng : (alpha * lng + (1 - alpha) * this.emaLng);
    return [this.emaLng, this.emaLat]; // [lng, lat]
  }

  // ====== Polylines por segmentos ======
  private activeLineId?: string;
  private activePath: LonLat[] = [];
  private segmentLines: { id: string; path: LonLat[] }[] = [];

  // ====== Marker del usuario ======
  private userMarkerId?: string;

  // ====== Auto pausa / reanudar ======
  private readonly auto = { stopSpeedKmh: 1.0, stopGraceMs: 10000, resumeSpeedKmh: 2.0, resumeGraceMs: 3000 };
  private stillSince?: number;
  private movingSince?: number;

  // Pausa inteligente: si se mueve mucho en pausa, cortamos trazo
  private pausedAt?: LonLat | null;
  private pendingResumeCheck = false;
  private readonly GAP_IF_MOVED_OVER_M = 20;

  // thresholds visuales
  private readonly ACCEPT_ACC = 65;
  private readonly IGNORE_ACC = 200;

  // =========================
  // LIFECYCLE
  // =========================
  async ngAfterViewInit() {
    await this.initMap();

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);

    await this.initPositioning();

    if (this.platform.is('android') || this.platform.is('ios')) {
      this.toastMsg('Para mejor precisión: GPS en alta y sin ahorro de batería.');
    }
  }

  ngOnDestroy() {
    if (this.watchId) Geolocation.clearWatch({ id: this.watchId });
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
    this.tickEff.destroy();

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);

    if (this.map) {
      this.map.destroy();
      this.map = undefined;
    }
  }

  private onResize = () => {
    setTimeout(() => { /* noop */ }, 150);
  };

  // =========================
  // MAP INIT
  // =========================
  private async initMap() {
    // IMPORTANTE:
    // - En Android/iOS la key vive en strings.xml/Info.plist + meta-data.
    // - En Web se usa apiKey aquí (pero tú dijiste que web no te importa).
    this.map = await GoogleMap.create({
      id: 'mc_registro_map',
      element: this.mapEl.nativeElement,
      apiKey: environment.googleMapsKey,
      config: {
        center: { lat: -33.45, lng: -70.66 },
        zoom: 14,
        // NO meter props web (disableDefaultUI, zoomControl, etc.) porque rompen el type del plugin
      }
    });

    this.mapReady = true;

    // Heurística de “tocó el mapa”
    try {
      const el = this.mapEl.nativeElement;
      el.addEventListener('pointerdown', () => this.userInteracting = true, { passive: true });
      const end = () => { this.userInteracting = false; };
      el.addEventListener('pointerup', end, { passive: true });
      el.addEventListener('pointercancel', end, { passive: true });
    } catch { /* ignore */ }
  }

  // =========================
  // GEOLOCATION
  // =========================
  private async initPositioning() {
    if (!this.map || !this.mapReady) return;

    if (this.watchId) {
      await Geolocation.clearWatch({ id: this.watchId });
      this.watchId = undefined;
    }

    // primer fix (rápido)
    try {
      const p = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 6000,
        maximumAge: 0
      });

      const ll: LonLat = [p.coords.longitude, p.coords.latitude];
      await this.ensureUserMarker(ll, 0);

      await this.map.setCamera({
        coordinate: { lat: ll[1], lng: ll[0] },
        zoom: this.FOLLOW_ZOOM,
        bearing: 0,
        tilt: this.FOLLOW_TILT,
        animate: false
      } as any);

      this.firstFixOk = true;
      this.lastCenter = ll;
    } catch {
      // fallback Santiago
      const ll: LonLat = [-70.66, -33.45];
      await this.ensureUserMarker(ll, 0);

      await this.map.setCamera({
        coordinate: { lat: ll[1], lng: ll[0] },
        zoom: 14,
        bearing: 0,
        tilt: 0,
        animate: false
      } as any);

      this.firstFixOk = false;
      this.lastCenter = ll;
    }

    // watch
    this.watchId = await Geolocation.watchPosition(
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      (pos, err) => this.onPosition(pos ?? undefined, err)
    );
  }

  private async onPosition(pos?: Position, err?: any) {
    if (!this.map || !this.mapReady) return;
    if (err || !pos) return;

    const { latitude, longitude, speed, accuracy, heading } = pos.coords;
    const acc = typeof accuracy === 'number' ? accuracy : 9999;

    // filtro por accuracy
    if (acc > this.IGNORE_ACC) {
      const llBad: LonLat = [longitude, latitude];
      await this.ensureUserMarker(llBad, this.lastBearing);
      return;
    }

    // EMA suave según accuracy
    const alpha = acc <= 25 ? 0.40 : acc <= 65 ? 0.30 : 0.18;
    const llSm: LonLat = this.ema(alpha, latitude, longitude);

    // velocidad efectiva
    const spKmh = (typeof speed === 'number' && !Number.isNaN(speed)) ? speed * 3.6 : this.speedKmh();

    // heading fusionado
    this.headingDeg = this.fusedHeading({
      gpsHeading: (typeof heading === 'number' && !Number.isNaN(heading)) ? heading : null,
      prev: this.lastCenter,
      curr: llSm,
      spKmh
    });

    // alimenta TrackService
    this.trk.onPosition(
      latitude,
      longitude,
      pos.timestamp || Date.now(),
      (typeof speed === 'number' && !Number.isNaN(speed)) ? speed : undefined,
      (typeof accuracy === 'number') ? accuracy : undefined
    );

    // Auto pausa / reanudar
    const now = Date.now();
    if (this.state() === 'recording') {
      if (spKmh <= this.auto.stopSpeedKmh) {
        this.stillSince = this.stillSince ?? now;
        if (now - this.stillSince >= this.auto.stopGraceMs) {
          this.zone.run(() => {
            void this.trk.pause();
            this.pausedAt = this.lastCenter ?? llSm;
            this.pendingResumeCheck = true;
          });
          this.stillSince = this.movingSince = undefined;
        }
      } else {
        this.stillSince = undefined;
      }
    } else if (this.state() === 'paused') {
      if (spKmh >= this.auto.resumeSpeedKmh) {
        this.movingSince = this.movingSince ?? now;
        if (now - this.movingSince >= this.auto.resumeGraceMs) {
          this.zone.run(() => {
            void this.trk.resume();
          });
          this.movingSince = this.stillSince = undefined;
        }
      } else {
        this.movingSince = undefined;
      }
    }

    // Corte de segmento si se movió mucho en pausa
    if (this.pendingResumeCheck && this.state() === 'recording') {
      this.pendingResumeCheck = false;
      if (this.pausedAt) {
        const moved = this.distMetersLL(this.pausedAt, llSm);
        if (moved > this.GAP_IF_MOVED_OVER_M) {
          await this.startNewPolylineSegment();
        }
      }
      this.pausedAt = null;
    }

    // Dibujar trazo solo si accuracy aceptable y grabando
    if (acc <= this.ACCEPT_ACC && this.state() === 'recording') {
      await this.appendToTrack(llSm);
    }

    // Marker + follow
    await this.ensureUserMarker(llSm, this.headingDeg);
    this.followCamera(llSm, { spKmh, hasHeading: true, prev: this.lastCenter });

    this.lastCenter = llSm;
  }

  // =========================
  // TRACK DRAW (POLYLINES)
  // =========================
  private async startNewPolylineSegment() {
    if (!this.map || !this.mapReady) return;

    // cierra el segmento actual si existe
    if (this.activeLineId) {
      this.segmentLines.push({ id: this.activeLineId, path: this.activePath });
    }

    // ✅ En v7.x: Polyline usa `points` y `strokeWidth`
    const ids = await this.map.addPolylines([{
      points: [],
      strokeColor: '#2b9bff',
      strokeWidth: 7,
      geodesic: true,
    } as any]);

    const lineId = Array.isArray(ids) ? ids[0] : (ids as any);

    this.activeLineId = lineId;
    this.activePath = [];
  }

  private async appendToTrack(ll: LonLat) {
    if (!this.map || !this.mapReady) return;

    if (!this.activeLineId) {
      await this.startNewPolylineSegment();
    }

    const last = this.activePath[this.activePath.length - 1];
    if (last) {
      const d = this.distMetersLL(last, ll);
      if (d < 1.5) return; // evita jitter
    }

    this.activePath.push(ll);

    const lineId = this.activeLineId!;
    const points = this.activePath.map(p => ({ lat: p[1], lng: p[0] }));

    // ✅ updatePolyline (si existe) usando points
    try {
      await (this.map as any).updatePolyline({
        id: lineId,
        points,
      });
    } catch {
      // fallback: remove + add
      try { await this.map.removePolylines([lineId]); } catch {}

      const newIds = await this.map.addPolylines([{
        points,
        strokeColor: '#2b9bff',
        strokeWidth: 7,
        geodesic: true,
      } as any]);

      this.activeLineId = Array.isArray(newIds) ? newIds[0] : (newIds as any);
    }
  }

  // =========================
  // MARKER + CAMERA
  // =========================
  private async ensureUserMarker(ll: LonLat, bearingDeg: number) {
    if (!this.map || !this.mapReady) return;

    const paused = this.state() === 'paused';

    if (!this.userMarkerId) {
      const ids = await this.map.addMarkers([{
        coordinate: { lat: ll[1], lng: ll[0] },
        title: 'Tú',
        // estas props pueden variar por versión, por eso any
        rotation: bearingDeg,
        anchor: { x: 0.5, y: 0.5 },
        tintColor: paused ? '#ffb703' : '#00d2ff',
      } as any]);

      this.userMarkerId = Array.isArray(ids) ? ids[0] : (ids as any);
    } else {
      const id = this.userMarkerId;
      try {
        await (this.map as any).updateMarker({
          id,
          coordinate: { lat: ll[1], lng: ll[0] },
          rotation: bearingDeg,
          tintColor: paused ? '#ffb703' : '#00d2ff',
        });
      } catch {
        try { await this.map.removeMarkers([id]); } catch {}
        this.userMarkerId = undefined;
        await this.ensureUserMarker(ll, bearingDeg);
      }
    }
  }

  private async followCamera(center: LonLat, info?: FollowInfo) {
    if (!this.map || !this.mapReady) return;
    if (!this.animFollow) return;
    if (this.userInteracting) return;

    let bearing = this.lastBearing;

    const sp = info?.spKmh ?? 0;
    if (sp >= this.MOVE_MIN_KMH && info?.prev) {
      bearing = this.bearing(info.prev, center);
    } else if (typeof this.headingDeg === 'number' && !Number.isNaN(this.headingDeg)) {
      bearing = this.headingDeg;
    }

    bearing = this.smoothAngle(this.lastBearing, bearing, 0.20);
    this.lastBearing = bearing;

    await this.map.setCamera({
      coordinate: { lat: center[1], lng: center[0] },
      zoom: this.FOLLOW_ZOOM,
      tilt: this.FOLLOW_TILT,
      bearing,
      animate: true,
    } as any);
  }

  // =========================
  // UI ACTIONS
  // =========================
  async center() {
    if (!this.map || !this.mapReady) return;
    const ll = this.lastCenter;
    if (!ll) return;

    this.userInteracting = false;
    await this.map.setCamera({
      coordinate: { lat: ll[1], lng: ll[0] },
      zoom: this.FOLLOW_ZOOM,
      tilt: this.FOLLOW_TILT,
      bearing: this.lastBearing,
      animate: true,
    } as any);
  }

  pauseOrResume() {
    if (this.state() === 'recording') {
      this.zone.run(() => {
        void this.trk.pause();
        this.pausedAt = this.lastCenter;
        this.pendingResumeCheck = true;
      });
    } else if (this.state() === 'paused') {
      this.zone.run(() => void this.trk.resume());
    }
  }

  async finalizar() {
    const { durationMs, distanceKm, avgSpeedKmh } = this.trk.getSummary();
    const modal = await this.modalCtrl.create({
      component: FinishConfirmModal,
      componentProps: { duration: this.msToHMS(durationMs), distanceKm, avgSpeedKmh },
      breakpoints: [0, 0.6, 0.9],
      initialBreakpoint: 0.6,
      showBackdrop: true
    });
    await modal.present();

    const { role } = await modal.onWillDismiss<{ save: boolean }>();
    if (role === 'save' || role === 'discard') this.closeAndFinalize(role === 'save');
  }

  private closeAndFinalize(save: boolean) {
    if (this.watchId) { Geolocation.clearWatch({ id: this.watchId }); this.watchId = undefined; }
    const { saved } = this.trk.finalize(save);
    if (save && saved) this.toastMsg('Actividad guardada');
    this.router.navigateByUrl('/tabs/registrar');
  }

  // =========================
  // HEADING / MATH HELPERS
  // =========================
  private fusedHeading(params: {
    gpsHeading: number | null;
    prev: LonLat | null | undefined;
    curr: LonLat;
    spKmh: number;
  }): number {
    const { gpsHeading, prev, curr, spKmh } = params;

    if (spKmh >= this.MOVE_MIN_KMH && prev) {
      const moveBear = this.bearing(prev, curr);
      const base = (typeof this.lastBearing === 'number') ? this.lastBearing : moveBear;
      const a = Math.max(0.15, Math.min(0.45, spKmh / 20));
      const fused = this.smoothAngle(base, moveBear, a);
      this.lastBearing = fused;
      return fused;
    }

    if (typeof gpsHeading === 'number' && !Number.isNaN(gpsHeading)) {
      const comp = this.normalizeDeg(gpsHeading);
      const base = (typeof this.lastBearing === 'number') ? this.lastBearing : comp;
      const fused = this.smoothAngle(base, comp, 0.18);
      this.lastBearing = fused;
      return fused;
    }

    return this.lastBearing || 0;
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
    const d = this.angleDelta(prev, next);
    return this.normalizeDeg(prev + d * alpha);
  }

  private distMetersLL(a: LonLat, b: LonLat): number {
    const R = 6371000;
    const dLat = (b[1] - a[1]) * Math.PI / 180;
    const dLng = (b[0] - a[0]) * Math.PI / 180;
    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLng / 2);
    const t = s1 * s1 + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(t)));
  }

  private bearing(a: LonLat, b: LonLat): number {
    const [lng1, lat1] = [a[0] * Math.PI / 180, a[1] * Math.PI / 180];
    const [lng2, lat2] = [b[0] * Math.PI / 180, b[1] * Math.PI / 180];
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  private async toastMsg(message: string) {
    const t = await this.toast.create({ message, duration: 1800, position: 'bottom' });
    await t.present();
  }

  private msToHMS(ms: number) {
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
}
