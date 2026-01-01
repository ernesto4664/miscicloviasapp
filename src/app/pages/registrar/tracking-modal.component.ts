import {
  AfterViewInit, Component, OnDestroy, ElementRef, ViewChild,
  computed, inject, signal, effect, EffectRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonHeader, IonToolbar, IonTitle, IonButtons, IonButton,
  IonContent, IonFab, IonFabButton, IonIcon, IonFooter
} from '@ionic/angular/standalone';
import { ToastController, AlertController, Platform, ModalController } from '@ionic/angular';

import { Geolocation, Position } from '@capacitor/geolocation';
import * as L from 'leaflet';
import { TrackService } from '../../core/services/track.service';
import { FinishConfirmModal } from './finish-confirm.modal';

@Component({
  standalone: true,
  selector: 'app-tracking-modal',
  templateUrl: './tracking-modal.component.html',
  styleUrls: ['./tracking-modal.component.scss'],
  imports: [
    CommonModule,
    IonHeader, IonToolbar, IonTitle, IonButtons, IonButton,
    IonContent, IonFab, IonFabButton, IonIcon, IonFooter
  ],
})
export class TrackingModalComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;

  private toast = inject(ToastController);
  private alert = inject(AlertController);
  private platform = inject(Platform);
  private trk = inject(TrackService);
  private modalCtrl = inject(ModalController);

  // Leaflet
  private map!: L.Map;
  private marker?: L.Marker;
  private accuracy?: L.Circle;
  private path?: L.Polyline;          // traza azul
  private watchId?: string;
  private headingDeg = 0;

  // ====== TICK REACTIVO PARA EL CRONÓMETRO ======
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

  // ====== estado expuesto por tu servicio ======
  state = this.trk.stateSig;
  distanceKm = this.trk.distanceKmSig;
  speedKmh = this.trk.speedKmhSig;

  // Cronómetro (HH:mm:ss) – depende de tick()
  timeStr = computed(() => {
    this.tick(); // recalcula cada segundo cuando está "recording"
    const state = this.state();
    const start = this.trk.startedAtSig();
    if (state === 'idle' || !start) return '00:00:00';
    const nowOrPaused = (state === 'paused' ? this.trk.pauseStartedAtSig() : Date.now());
    const ms = (nowOrPaused || Date.now()) - start - this.trk.pausedAccumMsSig();
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  });

  private onResize = () => setTimeout(() => this.map?.invalidateSize(true), 180);

  // ---------- Constantes/filtros de calidad ----------
  private readonly ACC_GOOD   = 20;  // m: excelente
  private readonly ACC_OK     = 50;  // m: aceptable para mover mapa
  private readonly MIN_STEP_M = 3;   // m: paso mínimo para dibujar

  // ---------- Suavizado EMA ----------
  private emaLat?: number; private emaLng?: number;
  private ema(alpha: number, lat: number, lng: number): L.LatLng {
    this.emaLat = (this.emaLat === undefined) ? lat : (alpha*lat + (1-alpha)*this.emaLat);
    this.emaLng = (this.emaLng === undefined) ? lng : (alpha*lng + (1-alpha)*this.emaLng);
    return L.latLng(this.emaLat, this.emaLng);
  }

  // ---------- Distancia Haversine ----------
  private distMeters(a: L.LatLng, b: L.LatLng): number {
    const R = 6371000, dLat = (b.lat - a.lat) * Math.PI/180, dLng = (b.lng - a.lng) * Math.PI/180;
    const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
    const t = s1*s1 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*s2*s2;
    return 2*R*Math.asin(Math.min(1, Math.sqrt(t)));
  }

  // ---------- Helpers para un primer fix más robusto ----------
  private async ensurePerms(): Promise<boolean> {
    try {
      const p = await Geolocation.checkPermissions();
      if (p.location === 'granted') return true;
      const r = await Geolocation.requestPermissions();
      return r.location === 'granted';
    } catch {
      return false;
    }
  }

  private firstFixFromWatch(ms = 15000): Promise<import('@capacitor/geolocation').GeolocationPosition> {
    return new Promise((resolve, reject) => {
      let cleared = false;
      let watchId: string | undefined;

      const timer = setTimeout(() => {
        if (cleared) return;
        cleared = true;
        if (watchId) Geolocation.clearWatch({ id: watchId });
        reject(new Error('watch timeout'));
      }, ms);

      Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 0, timeout: ms },
        (pos, err) => {
          if (cleared) return;
          if (err || !pos) return; // seguir esperando
          cleared = true;
          clearTimeout(timer);
          if (watchId) Geolocation.clearWatch({ id: watchId });
          resolve(pos);
        }
      ).then(id => (watchId = id!));
    });
  }

  // Espera el primer punto que llegue por watchPosition (con timeout)
  private async firstFixOrTimeout(ms = 15000): Promise<Position> {
    return new Promise<Position>((resolve, reject) => {
      let cleared = false;
      let watchId: string | undefined;

      const timer = setTimeout(() => {
        if (cleared) return;
        cleared = true;
        if (watchId) Geolocation.clearWatch({ id: watchId });
        reject(new Error('timeout'));
      }, ms);

      const cb = (pos: Position | null, err?: any) => {
        if (cleared) return;
        if (err || !pos) return;          // sigue esperando
        cleared = true;
        clearTimeout(timer);
        if (watchId) Geolocation.clearWatch({ id: watchId });
        resolve(pos as Position);
      };

      // compat: algunas versiones devuelven string y otras Promise<string>
      const maybeId = Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 0, timeout: ms },
        cb
      ) as unknown;

      if (maybeId && typeof (maybeId as any).then === 'function') {
        (maybeId as Promise<string>).then(id => (watchId = id));
      } else {
        watchId = maybeId as string;
      }
    });
  }

  // -------- Best-of-N: colecciona lecturas y elige la de menor accuracy --------
  private collectPositions(windowMs = 3500, perPosTimeout = 10000): Promise<import('@capacitor/geolocation').GeolocationPosition> {
    return new Promise(async (resolve, reject) => {
      const picks: import('@capacitor/geolocation').GeolocationPosition[] = [];
      let watchId: string | undefined;

      const timer = setTimeout(async () => {
        if (watchId) await Geolocation.clearWatch({ id: watchId });
        if (picks.length) {
          picks.sort((a,b) => (a.coords.accuracy ?? 1e9) - (b.coords.accuracy ?? 1e9));
          resolve(picks[0]);
        } else {
          reject(new Error('no-fix'));
        }
      }, windowMs);

      watchId = await Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 0, timeout: perPosTimeout },
        (pos, err) => { if (pos) picks.push(pos as import('@capacitor/geolocation').GeolocationPosition); }
      );
    });
  }

  // -------- Estrategia para la posición inicial (warm-up + best-of-N + fallback) --------
  private async getBestInitialPosition(): Promise<import('@capacitor/geolocation').GeolocationPosition> {
    // 1) Asegura permisos
    const ok = await this.ensurePerms();
    if (!ok) throw new Error('perm-denied');

    // 2) Carrera: best-of-N (3.5s) vs getCurrentPosition (7s)
    const race1 = Promise.race([
      this.collectPositions(3500, 12000),
      Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }),
    ]);
    try { return await race1 as import('@capacitor/geolocation').GeolocationPosition; } catch {}

    // 3) Segundo intento, ventana algo mayor
    const race2 = Promise.race([
      this.collectPositions(6000, 15000),
      Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }),
    ]);
    try { return await race2 as import('@capacitor/geolocation').GeolocationPosition; } catch {}

    // 4) Fallback a menor precisión (para centrar mientras llega el fix fino)
    try {
      return await Geolocation.getCurrentPosition({
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 60_000,
      });
    } catch {}

    // 5) Último recurso
    await this.toastMsg('No pudimos obtener tu ubicación a tiempo. Revisa GPS/precisión.');
    return {
      coords: {
        latitude: -33.45,
        longitude: -70.66,
        accuracy: 9999,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    };
  }

  // ------------------------------------------------------------

  async ngAfterViewInit() {
    // mapa base
    this.map = L.map(this.mapEl.nativeElement, { zoom: 16, zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '&copy; OpenStreetMap, © CARTO',
    }).addTo(this.map);
    setTimeout(() => this.map.invalidateSize(true), 200);

    // permisos
    const ok = await this.ensurePerms();
    if (!ok) {
      await this.toastMsg('Necesitamos permisos de ubicación para iniciar.');
    }

    // primer centrado robusto (warm-up + best-of-N + fallback)
    const pos = await this.getBestInitialPosition();
    const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
    this.ensureMarker(ll, pos.coords.accuracy ?? 0);
    this.map.setView(ll, 17);

    // watch continuo para el tracking (ajustes finos para reducir timeouts)
    this.watchId = await Geolocation.watchPosition(
      {
        enableHighAccuracy: true,
        maximumAge: 250,      // pequeño caché ayuda a no timeoutear
        timeout: 12000
      },
      (p: Position | null, err) => this.onPosition(p ?? undefined, err)
    );

    // ajustes visuales
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);

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
    this.map?.remove();
  }

  private onPosition(pos?: Position, err?: any) {
    if (err || !pos) return;

    const { latitude, longitude, speed, accuracy, heading } = pos.coords;
    const raw = L.latLng(latitude, longitude);
    const acc = accuracy ?? 9999;

    // 1) Filtro de calidad: no muevo mapa/marker si es muy mala (pero sí registro en servicio)
    const canMoveMap = acc <= this.ACC_OK;

    // 2) Suavizado: si accuracy es bueno, aplico EMA suave; si es mediocre, suavizo más
    const alpha = (acc <= this.ACC_GOOD) ? 0.35 : (acc <= this.ACC_OK ? 0.25 : 0.15);
    const smooth = this.ema(alpha, raw.lat, raw.lng);

    // 3) Debounce de movimiento: ignora jitter < max(accuracy/2, MIN_STEP_M)
    const last = this.getLastLatLng();
    const stepThresh = Math.max(acc/2, this.MIN_STEP_M);
    if (last && this.distMeters(last, smooth) < stepThresh) {
      // aun así informa al servicio para cálculo de velocidad con tu lógica
      this.trk.onPosition(latitude, longitude, pos.timestamp || Date.now(), speed ?? undefined, accuracy ?? undefined);
      return;
    }

    if (typeof heading === 'number' && !Number.isNaN(heading)) this.headingDeg = heading;

    // Notifica a tu servicio (mantén tu lógica de distancia/velocidad/estado)
    this.trk.onPosition(
      latitude,
      longitude,
      pos.timestamp || Date.now(),
      speed ?? undefined,
      accuracy ?? undefined
    );

    // Dibujo (solo si la calidad lo amerita)
    if (canMoveMap) {
      this.ensureMarker(smooth, acc);
      if (!this.path) {
        this.path = L.polyline([smooth], { color: '#2b8cff', weight: 5, opacity: 0.9 }).addTo(this.map);
      } else {
        const pts = this.path.getLatLngs() as L.LatLng[];
        pts.push(smooth);
        this.path.setLatLngs(pts);
      }
      // pan suave pero no en cada tick: solo si nos alejamos lo suficiente
      if (!last || this.distMeters(last, smooth) > 8) {
        this.map.panTo(smooth, { animate: true });
      }
    } else {
      // Actualiza solo círculo de precisión si existe; evita mareo con lecturas malas
      const ll = last ?? raw;
      this.ensureMarker(ll, acc);
    }
  }

  center() {
    const last = this.getLastLatLng();
    if (last) this.map.setView(last, 17, { animate: true });
  }

  pauseOrResume() {
    if (this.state() === 'recording') this.trk.pause();
    else if (this.state() === 'paused') this.trk.resume();
    const ll = this.getLastLatLng(); if (ll) this.ensureMarker(ll);
  }

  async finalizar() {
    const { durationMs, distanceKm, avgSpeedKmh } = this.trk.getSummary();
    const durStr = this.msToHMS(durationMs);

    const modal = await this.modalCtrl.create({
      component: FinishConfirmModal,
      componentProps: { duration: durStr, distanceKm, avgSpeedKmh },
      breakpoints: [0, 0.5, 0.9],
      initialBreakpoint: 0.5,
      showBackdrop: true
    });
    await modal.present();

    const { role } = await modal.onWillDismiss();
    if (role === 'save' || role === 'discard') {
      await this.closeAndFinalize(role === 'save'); // deja el modal abierto listo para iniciar otra
    }
  }

  /** Limpia overlays/cronómetro visuales pero deja el modal abierto en estado idle */
  private resetVisuals() {
    if (this.path) { this.map.removeLayer(this.path); this.path = undefined; }
    this.tick.update(v => v + 1); // fuerza repaint a 00:00:00
  }

  /** Finaliza (guardar/descartar) y prepara para iniciar otra actividad SIN cerrar el modal */
  private async closeAndFinalize(save: boolean) {
    if (this.watchId) { Geolocation.clearWatch({ id: this.watchId }); this.watchId = undefined; }
    const { saved } = this.trk.finalize(save); // pone state='idle'
    this.resetVisuals();
    if (save && saved) this.toastMsg('Actividad guardada. Puedes iniciar otra.');
    else this.toastMsg('Actividad descartada. Puedes iniciar otra.');
  }

  /** Arranca una nueva actividad dentro del mismo modal */
  async startNew() {
    // “calienta” un poco para evitar timeout
    await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000 }).catch(() => null);

    if (!this.watchId) {
      this.watchId = await Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 250, timeout: 12000 },
        (pos, err) => this.onPosition(pos ?? undefined, err)
      );
    }

    this.trk.start();
    this.toastMsg('Grabando… ¡buen viaje!');
  }

  close() {
    if (this.watchId) { Geolocation.clearWatch({ id: this.watchId }); this.watchId = undefined; }
    this.modalCtrl.dismiss(null, 'cancel'); // aquí sí se cierra el modal
  }

  private ensureMarker(ll: L.LatLng, accuracy = 0) {
    const stateCls = this.state() === 'paused' ? 'paused' : 'recording';
    const html = `<div class="arrow ${stateCls}" style="transform: rotate(${this.headingDeg}deg)"></div>`;
    const icon = L.divIcon({ className: 'user-arrow', html, iconSize: [32, 32], iconAnchor: [16, 16] });

    if (!this.marker) this.marker = L.marker(ll, { icon }).addTo(this.map);
    else { this.marker.setLatLng(ll); (this.marker as any).setIcon(icon); }

    if (!this.accuracy) this.accuracy = L.circle(ll, { radius: accuracy, color: '#2b8cff', weight: 1, fillOpacity: 0.15 }).addTo(this.map);
    else { this.accuracy.setLatLng(ll); this.accuracy.setRadius(accuracy); }
  }

  private getLastLatLng(): L.LatLng | null {
    const snap = this.trk.activeSnapshot;
    const seg = snap?.segments?.[snap.segments.length - 1];
    const p = seg?.points?.[seg.points.length - 1];
    return p ? L.latLng(p.lat, p.lng) : null;
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
