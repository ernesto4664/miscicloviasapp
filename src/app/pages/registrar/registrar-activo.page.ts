import {
  Component, AfterViewInit, OnDestroy, ElementRef, ViewChild,
  inject, computed, signal, effect, EffectRef, NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ToastController, Platform, ModalController } from '@ionic/angular';
import { Router } from '@angular/router';
import { Geolocation, Position } from '@capacitor/geolocation';
import { TrackService } from '../../core/services/track.service';
import { FinishConfirmModal } from './finish-confirm.modal';

import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Position as GPos } from 'geojson';
import { environment } from '../../../environments/environment';

// === Tipos auxiliares ===
type LonLat = [number, number];

interface SnapResult {
  coord: LonLat;
  snapped: boolean;
  segBearing?: number;
}

interface SnapFull extends SnapResult {
  /** Identificador estable de la calle (source-id + feature-id + layer) */
  featureKey?: string;
  /** Geometría aplanada de la calle en WGS84 (LineString único) */
  line?: LonLat[];
  /** Índice del segmento más cercano en 'line' */
  segIdx?: number;
  /** Parámetro 0..1 dentro del segmento segIdx */
  segT?: number;
}

interface FollowInfo {
  snapped?: boolean;
  segBearing?: number;
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

  private lastSnapFull?: SnapFull;
  private streetGeomCache = new Map<string, LonLat[]>(); // featureKey -> line
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

  // ====== MapLibre ======
  private map!: maplibregl.Map;
  private animFollow = true;                // la cámara sigue en vivo
  private marker?: maplibregl.Marker;       // instancia del marker
  private markerEl?: HTMLDivElement;        // su elemento DOM (para fallback de rotación)
  private headingDeg = 0;
  private lastBearing = 0;

  private _lastFollowTs?: number;
  private _followAlpha = 0.22;
  private userInteracting = false; // setéalo a true en handlers de pan/zoom si lo usas

  // Ya tienes lastCenter/lastBearing/lastZoom, pero asegúrate que existan:
  private lastCenter: LonLat | null = null;
  private lastZoom: number | null = null;
  // GeoJSON para el trazo (múltiples segmentos)
  private trackFC: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };

  private get currentCoords(): GPos[] {
    if (this.trackFC.features.length === 0) {
      this.trackFC.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} });
    }
    return (this.trackFC.features[this.trackFC.features.length - 1].geometry as LineString).coordinates;
  }

  private updateTrackSource() {
    const src = this.map.getSource('track') as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(this.trackFC);
  }

  // ====== Geoloc y dibujo ======
  private watchId?: string;
  private lastDrawn?: [number, number] | null; // [lng, lat]
  private drawGapOnNextPoint = false;

  // Filtros/perfiles (más permisivos)
  private readonly ACCEPT_ACC = 65;     // pinta si accuracy ≤ 65 m
  private readonly IGNORE_ACC = 200;    // si accuracy > 200 m ni mover ni pintar
  private readonly BAD_ACC_GRACE_MS = 12000; // tolerancia a accuracy mala
  private lastEntryAlignTs?: number;
  private readonly ENTRY_ALIGN_MS = 1200; // ventana de prioridad para el giro de salida
  private readonly FOLLOW_ZOOM = 17;
  private readonly FOLLOW_PITCH = 60;
  private readonly LOOKAHEAD_EXTRA_PX = 46;   // empuje extra hacia adelante
  private readonly MAX_TURN_PER_FRAME = 16;   // límite de giro por update
  private readonly MOVE_MIN_KMH = 2.2;        // umbral moverse/quieto
  // paso mínimo dinámico según velocidad
  private stepMin(spKmh: number) {
    // 1.5 m parado, hasta 5 m a ~10+ km/h
    return Math.max(1.5, Math.min(5, spKmh / 2.0));
  }

  // Auto pausa / reanudar
  private readonly auto = { stopSpeedKmh: 1.0, stopGraceMs: 10000, resumeSpeedKmh: 2.0, resumeGraceMs: 3000 };
  private stillSince?: number;
  private movingSince?: number;

  // Pausa inteligente
  private pausedAt?: [number, number] | null;
  private pendingResumeCheck = false;
  private readonly GAP_IF_MOVED_OVER_M = 20;

  // Accuracy mala sostenida
  private badAccSince?: number;
  private lastGoodLL?: [number, number] | null;

  // EMA
  private emaLat?: number; private emaLng?: number;
  private ema(alpha: number, lat: number, lng: number): [number, number] {
    this.emaLat = (this.emaLat === undefined) ? lat : (alpha*lat + (1-alpha)*this.emaLat);
    this.emaLng = (this.emaLng === undefined) ? lng : (alpha*lng + (1-alpha)*this.emaLng);
    return [this.emaLng, this.emaLat]; // [lng, lat]
  }

  private onResize = () => setTimeout(() => this.map?.resize(), 180);
  private lastSnap?: { coord: [number, number]; segBearing?: number; ts: number };

  // punto previo usado para calcular bearing entre muestras
  private lastForBearing?: [number, number];
  private readonly MIN_MOVE_FOR_BEARING_M = 3;
  private _insideBuilding?: boolean;

  // Ajustes para navegación
  private lastCamTs = 0;
  private readonly CAM_OFFSET_PX: [number, number] = [0, 200]; // ajusta si quieres
  private readonly MAX_BEARING_STEP = 18;     // máx grados por frame
  private readonly SWITCH_HYSTERESIS_KMH = 2; // evita saltos entre segBearing/heading
  private firstFixOk = false;

  private compassHeadingDeg?: number;      // 0..360 (0 = Norte)
  private compassAvailable = false;
  private lastCompassTs = 0;               // para saber si es reciente
  private readonly COMPASS_STALE_MS = 3000; // descarta si viejo

  // --- Anti-jitter compás ---
  private compEMA?: number;              // filtro exponencial (envolvente angular)
  private compHist: number[] = [];       // ventana mediana
  private lastCompTs = 0;                // throttle
  private readonly COMP_ALPHA = 0.10;    // suavizado (0.07–0.15 va bien)
  private readonly COMP_MED_WIN = 5;     // tamaño ventana mediana (3 o 5)
  private readonly COMP_DEADBAND = 3;    // grados mínimos para “mover”
  private readonly COMP_MIN_INTERVAL = 120; // ms entre lecturas aplicadas

  // follow-camera.ts (método dentro del componente)
  private lastSpeedKmh = 0;
  private lastBearingSource: 'heading' | 'segment' | 'point' | null = null;

  async ngAfterViewInit() {
    const styleUrl =
      `https://api.maptiler.com/maps/basic-v2-dark/style.json?key=${environment.maptilerKey}`;

    // 1) Crear mapa ligero y sin transiciones iniciales
    this.map = new maplibregl.Map({
      container: this.mapEl.nativeElement,
      style: styleUrl,
      center: [-70.66, -33.45],
      zoom: 14,
      pitch: 0,
      bearing: 0,
      fadeDuration: 0,
      attributionControl: false,
      renderWorldCopies: false,
      cooperativeGestures: true
    });

    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    // 2) Espera a que el estilo quede estable para montar capas y recién ahí posicionar
    this.map.once('idle', async () => {
      this.map.resize();
      this.addTrackLayers();
      this.initHeadingDotsLayer();

      const isIOS = this.platform.is('ios');
      if (!isIOS && this.map.getSource('openmaptiles')) {
        this.addBuildings3DWhenClose();
      }

      // Sube el pitch ya con primer frame mostrado
      this.map.easeTo({ pitch: 60, duration: 500 });

      // Activa brújula (si el navegador lo permite sin gesto). Si requiere permiso,
      // también la llamamos desde el botón "centrar".
      this.enableCompassIfNeeded();

      // 👉 aquí, y SOLO aquí, empezamos la geolocalización para evitar “saltos”
      await this.initPositioning();
    });

    // 3) Un resize extra para asegurar que el canvas ocupe bien
    requestAnimationFrame(() => this.map.resize());

    // 4) Listeners de ventana
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);

    // 5) Mensaje de recomendación
    if (this.platform.is('android') || this.platform.is('ios')) {
      this.toastMsg('Para mejor precisión: GPS en alta y sin ahorro de batería.');
    }
  }

    /** Crea una clave única y estable para un feature de calle. */
  private featureKeyOf(f: maplibregl.MapGeoJSONFeature): string {
    const src = f.source as string;
    const lyr = (f as any)['sourceLayer'] || (f as any)['source-layer'] || '';
    const id  = (f.id != null ? String(f.id) : JSON.stringify(f.properties ?? {}));
    return `${src}::${lyr}::${id}`;
  }

  /** Aplana LineString/MultiLineString a un único array de [lng,lat]. */
  private flattenLineCoords(geom: GeoJSON.Geometry): LonLat[] | null {
    if (geom.type === 'LineString') {
      return (geom.coordinates as number[][]).map(c => [c[0], c[1]]) as LonLat[];
    }
    if (geom.type === 'MultiLineString') {
      const out: LonLat[] = [];
      for (const line of geom.coordinates as number[][][]) {
        for (const c of line) out.push([c[0], c[1]]);
      }
      return out;
    }
    return null;
  }

  /** Punto más cercano sobre AB + t (0..1) */
  private nearestPointOnSegmentT(
    p: LonLat, a: LonLat, b: LonLat
  ): { ll: LonLat; t: number } {
    const pa = this.map.project(p);
    const aa = this.map.project(a);
    const bb = this.map.project(b);

    const abx = bb.x - aa.x, aby = bb.y - aa.y;
    const apx = pa.x - aa.x, apy = pa.y - aa.y;
    const ab2 = abx*abx + aby*aby || 1;
    const t = Math.max(0, Math.min(1, (apx*abx + apy*aby) / ab2));

    const projX = aa.x + abx * t;
    const projY = aa.y + aby * t;
    const ll = this.map.unproject([projX, projY]) as maplibregl.LngLat;
    return { ll: [ll.lng, ll.lat], t };
  }

  /** Construye el camino sobre 'line' entre (idxA,tA) y (idxB,tB), respetando dirección. */
  private streetPathBetween(line: LonLat[], idxA: number, tA: number, idxB: number, tB: number): LonLat[] {
    if (!line?.length) return [];

    const lerp = (a: LonLat, b: LonLat, t: number): LonLat => [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t];

    const forward = (idxA < idxB) || (idxA === idxB && tA <= tB);

    const out: LonLat[] = [];
    const clampIdx = (i: number) => Math.max(0, Math.min(line.length - 1, i));

    if (forward) {
      // arranque parcial desde (idxA,tA)
      const a0 = clampIdx(idxA), a1 = clampIdx(idxA + 1);
      const start = lerp(line[a0], line[a1], tA);
      out.push(start);

      // segmentos completos intermedios
      for (let i = idxA + 1; i <= idxB; i++) {
        const i0 = clampIdx(i);
        out.push(line[i0]);
      }

      // reemplaza el último punto por el parcial final si el último tramo no era exacto
      if (idxB < line.length - 1) {
        out[out.length - 1] = lerp(line[idxB], line[idxB + 1], tB);
      }
    } else {
      // Vamos “hacia atrás”
      const b0 = clampIdx(idxA), b1 = clampIdx(idxA + 1);
      const start = lerp(line[b0], line[b1], tA);
      out.push(start);

      for (let i = idxA; i > idxB; i--) {
        const i0 = clampIdx(i);
        out.push(line[i0 - 1]); // retrocede nodos
      }

      // final parcial
      const e0 = clampIdx(idxB), e1 = clampIdx(idxB + 1);
      const end = lerp(line[e0], line[e1], tB);
      out.push(end);
    }

    // Limpieza: quita duplicados consecutivos
    const cleaned: LonLat[] = [];
    for (const p of out) {
      const last = cleaned[cleaned.length - 1];
      if (!last || this.haversineMeters(last, p) > 0.2) cleaned.push(p);
    }
    return cleaned;
  }

    private async enableCompassIfNeeded() {
    try {
      const anyDO = (window as any).DeviceOrientationEvent;
      if (!anyDO) return;

      // iOS 13+: exige requestPermission y GESTO del usuario
      if (typeof anyDO.requestPermission === 'function') {
        const state = await anyDO.requestPermission();
        if (state !== 'granted') return;
      }
      // suscríbete una sola vez
      if (!this.compassAvailable) {
        window.addEventListener('deviceorientation', this.onDeviceOrientation, { passive: true });
        // algunos navegadores emiten "absolute" separado:
        window.addEventListener('deviceorientationabsolute', this.onDeviceOrientation, { passive: true } as any);
        this.compassAvailable = true;
        this.toastMsg('Brújula activada. El cursor girará aunque estés quieto.');
      }
    } catch { /* ignora */ }
  }

  private onDeviceOrientation = (ev: any) => {
    const ts = Date.now();
    if (ts - this.lastCompTs < this.COMP_MIN_INTERVAL) return;

    // 1) Obtener heading (grados 0..360). iOS usa webkitCompassHeading.
    let h: number | null = null;
    if (typeof (ev as any).webkitCompassHeading === 'number') {
      // iOS: 0 = Norte, crece en sentido horario.
      h = (ev as any).webkitCompassHeading as number;
    } else if (typeof ev.alpha === 'number') {
      // Estimación a partir de alpha (no perfecto, pero sirve para Android sin absolute)
      h = 360 - (ev.alpha as number);
    }
    if (h == null || Number.isNaN(h)) return;

    h = this.normalizeDeg(h);

    // 2) EMA con envolvente angular (suaviza sin saltos 359->0)
    this.compEMA = this.compEMA == null ? h : this.smoothAngle(this.compEMA, h, this.COMP_ALPHA);

    // 3) Mediana (quita outliers ocasionales)
    this.compHist.push(this.compEMA);
    if (this.compHist.length > this.COMP_MED_WIN) this.compHist.shift();
    const filtered = this.medianAngle(this.compHist);

    // 4) Deadband: ignora micro-cambios
    if (typeof this.headingDeg === 'number') {
      const d = Math.abs(this.angleDelta(this.headingDeg, filtered));
      if (d < this.COMP_DEADBAND) return;
    }

    // 5) Aplica
    this.headingDeg = filtered;
    this.lastCompTs = ts;

    // Si estás quieto, solo rota el puck (no muevas cámara para evitar “bailoteo”).
    if (this.speedKmh() < 2) {
      this.rotateMarker(this.headingDeg);
      this.lastBearing = this.headingDeg;
    }
  }

    private medianAngle(arr: number[]): number {
    if (!arr.length) return 0;
    // Proyecta a unit circle y promedia (aprox mediana robusta para ventanas cortas)
    let x = 0, y = 0;
    for (const a of arr) {
      const r = a * Math.PI / 180;
      x += Math.cos(r);
      y += Math.sin(r);
    }
    return this.normalizeDeg(Math.atan2(y, x) * 180 / Math.PI);
  }

    private getBottomUiHeight(): number {
    // Ajusta/añade selectores si tu HTML usa otros nombres
    const sels = [
      '#regHud',                // pon este id al contenedor de tus cards/cronómetro
      '.register-hud',
      '.stats-wrapper',
      'ion-tab-bar',            // tab bar inferior de Ionic
    ];

    let h = 0;
    for (const s of sels) {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // Cuenta solo lo que está “dentro” de la ventana (por seguridad)
      h += Math.max(0, Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top));
    }

    // Fallback razonable si no se encontró nada
    if (!h) h = 160;
    return h;
  }

  /** Offset en píxeles para que el puck quede centrado en el área libre (arriba del HUD). */
  private computeCamOffset(): [number, number] {
    // Altura real ocupada por HUD/tabbar para empujar el puck hacia abajo
    const tab = document.querySelector('ion-tab-bar') as HTMLElement | null;
    const hud = document.querySelector('#regHud, .register-hud, .stats-wrapper') as HTMLElement | null;
    const header = document.querySelector('ion-header, .toolbar-container') as HTMLElement | null;

    const hTabs = tab?.offsetHeight ?? 0;
    const hHud  = hud?.offsetHeight ?? 0;
    const hHead = header?.offsetHeight ?? 0;

    // Área libre ~ ventana menos lo ocupado arriba/abajo
    const topBlocked = hHead;
    const bottomBlocked = hTabs + hHud;

    // Queremos ver por delante del puck: medio diferencial + extra
    const halfDiff = (bottomBlocked - topBlocked) / 2;
    const y = Math.max(0, Math.round(halfDiff + this.LOOKAHEAD_EXTRA_PX));
    return [0, y];
  }

  private async initPositioning() {
    // por si llegas a llamarla más de una vez
    if (this.watchId) {
      await Geolocation.clearWatch({ id: this.watchId });
      this.watchId = undefined;
    }

    try {
      const p = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0
      });

      const ll: [number, number] = [p.coords.longitude, p.coords.latitude];
      this.ensureMarker(ll);

      // Primer encuadre sin offset, para “clavar” la cámara en tu ubicación
      this.map.jumpTo({ center: ll, zoom: 17, bearing: 0, pitch: 60 });
      this.lastGoodLL = ll;
    } catch {
      const ll: [number, number] = [-70.66, -33.45];
      this.ensureMarker(ll);
      const off = this.getFollowOffsetPx();
      this.map.easeTo({ center: ll, zoom: 17, bearing: 0, pitch: 60, duration: 0, offset: off });
      this.lastGoodLL = ll;
    }

    // Crea UN solo watch
    this.watchId = await Geolocation.watchPosition(
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      (pos, err) => this.onPosition(pos ?? undefined, err)
    );
  }

  /** Crea (si no existen) la fuente y las capas del trazo de forma diferida. */
  private addTrackLayers() {
    if (!this.map.getSource('track')) {
      this.map.addSource('track', { type: 'geojson', data: this.trackFC });
    }
    if (!this.map.getLayer('track-casing')) {
      this.map.addLayer({
        id: 'track-casing',
        type: 'line',
        source: 'track',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0a3e7a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 18, 14],
          'line-opacity': 0.55
        }
      });
    }
    if (!this.map.getLayer('track-line')) {
      this.map.addLayer({
        id: 'track-line',
        type: 'line',
        source: 'track',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#2b9bff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 18, 10],
          'line-opacity': 0.98
        }
      });
    }
  }

  /** Agrega edificios 3D sólo cuando el usuario ya está cerca (zoom ≥ 16). */
  private addBuildings3DWhenClose() {
    const add = () => {
      if (this.map.getLayer('buildings-3d')) return;
      const labelLayerId = this.map.getStyle().layers?.find(l => /label/i.test(l.id))?.id;
      this.map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 16, // << más tarde
        paint: {
          'fill-extrusion-color': '#2b2b32',
          'fill-extrusion-height': ['coalesce', ['to-number', ['get', 'height']], 12],
          'fill-extrusion-base':   ['coalesce', ['to-number', ['get', 'min_height']], 0],
          'fill-extrusion-opacity': 0.9
        }
      }, labelLayerId);
    };

    // Si ya está cerca, agrega; si no, espera a que se aproxime
    if (this.map.getZoom() >= 16) add();
    this.map.on('zoomend', () => { if (this.map.getZoom() >= 16) add(); });
  }

  ngOnDestroy() {
    if (this.watchId) Geolocation.clearWatch({ id: this.watchId });
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = undefined; }
    this.tickEff.destroy();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.map?.remove();
  }

  // === Geoloc → Dibujo + AutoPause + Follow 3D ===
  private onPosition(pos?: Position, err?: any) {
    if (err || !pos) return;

    const { latitude, longitude, speed, accuracy, heading } = pos.coords;
    const acc = typeof accuracy === 'number' ? accuracy : 9999;

    // ========== Primer fix: centra UNA sola vez con offset (look-ahead) ==========
    if (!this.firstFixOk) {
      if (acc <= this.IGNORE_ACC) {
        this.firstFixOk = true;
        const ll: [number, number] = [longitude, latitude];
        this.ensureMarker(ll);
        this.lastGoodLL = ll;
        // Reencuadre inicial con la cámara detrás del puck
        this.map.stop();
        this.map.easeTo({
          center: ll,
          zoom: this.FOLLOW_ZOOM,
          pitch: this.FOLLOW_PITCH,
          bearing: this.lastBearing || 0,
          offset: this.computeCamOffset(),
          duration: 0
        });
      } else {
        // Muestra “vida” sin animar cámara
        this.ensureMarker([longitude, latitude]);
        return;
      }
    }

    // ---- Suavizado (EMA) del GPS ----
    const alpha = acc <= 25 ? 0.40 : acc <= 65 ? 0.30 : 0.18;
    const [lngSmooth, latSmooth] = this.ema(alpha, latitude, longitude);

    // Punto REAL (lng, lat) para el trazo
    const ll: [number, number] = [lngSmooth, latSmooth];

    // ---- Velocidad efectiva (km/h) ----
    let spKmh = (typeof speed === 'number' && !Number.isNaN(speed)) ? speed * 3.6 : this.speedKmh();
    const prevLL = this.lastDrawn;
    if ((!speed || Number.isNaN(speed)) && prevLL) {
      const d = this.distMetersLL(prevLL, ll);
      const dt = 1; // ~1s
      spKmh = (d / dt) * 3.6;
    }

    // ---- Heading fusionado (compás + trayectoria) ----
    this.headingDeg = this.fusedHeading({
      gpsHeading: (typeof heading === 'number' && !Number.isNaN(heading)) ? heading : null,
      prev: prevLL,
      curr: ll,
      spKmh
    });

    // ---- Alimenta métricas del servicio ----
    this.trk.onPosition(
      latitude,
      longitude,
      pos.timestamp || Date.now(),
      (typeof speed === 'number' && !Number.isNaN(speed)) ? speed : undefined,
      (typeof accuracy === 'number') ? accuracy : undefined
    );

    // ---- Política VISUAL con señal muy mala ----
    if (acc > this.IGNORE_ACC) {
      const snapBad = this.snapToStreetIfClose(ll, acc) as SnapFull;
      const vis = this.lastGoodLL ?? snapBad.coord;

      this.ensureMarker(vis);
      const hasHeading = (typeof this.headingDeg === 'number' && !Number.isNaN(this.headingDeg));
      this.followCamera(vis, {
        snapped: !!snapBad.snapped,
        segBearing: snapBad.segBearing,
        spKmh,
        hasHeading
      });

      // Dots solo si estás dentro (raw→snap)
      const distRawSnap = this.distMetersLL(ll, snapBad.coord);
      if (snapBad.snapped && distRawSnap >= 6) {
        this.drawHeadingDotsRawToSnap(ll, snapBad.coord, distRawSnap);
        this.lastEntryAlignTs = Date.now(); // prioridad al bearing del segmento
      } else {
        (this.map.getSource('heading-dots') as maplibregl.GeoJSONSource)
          ?.setData({ type: 'FeatureCollection', features: [] });
      }
      return;
    }

    // ---- Señal mediocre: no dibujar trazo pero sí cursor/cámara snapeados ----
    if (acc > this.ACCEPT_ACC) {
      const snapMed = this.snapToStreetIfClose(ll, acc) as SnapFull;
      const visMed = snapMed.coord;

      this.ensureMarker(visMed);
      const hasHeading = (typeof this.headingDeg === 'number' && !Number.isNaN(this.headingDeg));
      this.followCamera(visMed, {
        snapped: !!snapMed.snapped,
        segBearing: snapMed.segBearing,
        spKmh,
        hasHeading
      });

      const distRawSnap = this.distMetersLL(ll, visMed);
      if (snapMed.snapped && distRawSnap >= 6) {
        this.drawHeadingDotsRawToSnap(ll, visMed, distRawSnap);
        this.lastEntryAlignTs = Date.now();
      } else {
        (this.map.getSource('heading-dots') as maplibregl.GeoJSONSource)
          ?.setData({ type: 'FeatureCollection', features: [] });
      }

      this.lastGoodLL = visMed;
      return;
    }

    // ---- Punto VISUAL (snapeado) para cursor/cámara con buena precisión ----
    const snap = this.snapToStreetIfClose(ll, acc) as SnapFull;
    const visLL = snap.coord;

    // ---- Auto-pausa / Auto-reanudar ----
    const now = Date.now();
    if (this.state() === 'recording') {
      if (spKmh <= this.auto.stopSpeedKmh) {
        this.stillSince = this.stillSince ?? now;
        if (now - this.stillSince >= this.auto.stopGraceMs) {
          this.zone.run(() => {
            this.trk.pause();
            this.pausedAt = this.getLastLngLat() ?? ll;
            this.pendingResumeCheck = true;
            this.lastDrawn = null;
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
          this.zone.run(() => this.trk.resume());
          this.movingSince = this.stillSince = undefined;
        }
      } else {
        this.movingSince = undefined;
      }
    }

    // ¿Cortar trazo al reanudar?
    if (this.pendingResumeCheck && this.state() === 'recording') {
      this.pendingResumeCheck = false;
      if (this.pausedAt) {
        const moved = this.distMetersLL(this.pausedAt, ll);
        this.drawGapOnNextPoint = moved > this.GAP_IF_MOVED_OVER_M;
      }
      this.pausedAt = null;
    }

    // ---- DIBUJO DEL TRAZO (con cosido sobre calle si aplica) ----
    if (this.state() === 'recording') {
      if (this.drawGapOnNextPoint || this.currentCoords.length === 0) {
        this.trackFC.features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [] },
          properties: {}
        });
        this.drawGapOnNextPoint = false;
        this.lastDrawn = null;
      }

      const prev = this.lastDrawn;
      const d = prev ? this.distMetersLL(prev, ll) : Infinity;
      const minStep = this.stepMin(spKmh);

      if (!prev || d >= minStep) {
        const prevSnap = this.lastSnapFull;   // snap del ciclo anterior (guardado en snapToStreetIfClose)
        const currSnap = snap;                // snap actual

        const sameStreet =
          prevSnap?.snapped && currSnap?.snapped &&
          prevSnap.featureKey && currSnap.featureKey &&
          prevSnap.featureKey === currSnap.featureKey &&
          prevSnap.line && currSnap.line &&
          prevSnap.segIdx != null && prevSnap.segT != null &&
          currSnap.segIdx != null && currSnap.segT != null;

        if (sameStreet) {
          // Construye camino sobre la geometría de la calle entre ambos snaps
          const stitched = this.streetPathBetween(
            currSnap.line!,               // misma referencia compartida
            prevSnap.segIdx!, prevSnap.segT!,
            currSnap.segIdx!, currSnap.segT!
          );

          // Si hay hueco grande entre último punto y primer cosido, subdivide
          const lastReal = prev ?? this.currentCoords[this.currentCoords.length - 1] as LonLat | undefined;
          if (lastReal && stitched.length) {
            const dd = this.distMetersLL(lastReal, stitched[0]);
            if (dd > 10) {
              const steps = Math.ceil(dd / 5);
              for (let i = 1; i < steps; i++) {
                const t = i / steps;
                const x = lastReal[0] + (stitched[0][0] - lastReal[0]) * t;
                const y = lastReal[1] + (stitched[0][1] - lastReal[1]) * t;
                this.currentCoords.push([x, y]);
              }
            }
          }

          for (const p of stitched) this.currentCoords.push(p);
          this.updateTrackSource();
          this.lastDrawn = stitched[stitched.length - 1] ?? ll;
        } else {
          // Fallback: recta subdividida (como tenías)
          if (prev && d > 10) {
            const steps = Math.ceil(d / 5);
            for (let i = 1; i < steps; i++) {
              const t = i / steps;
              const x = prev[0] + (ll[0] - prev[0]) * t;
              const y = prev[1] + (ll[1] - prev[1]) * t;
              this.currentCoords.push([x, y]);
            }
          }
          this.currentCoords.push(ll);
          this.updateTrackSource();
          this.lastDrawn = ll;
        }
      }
    }

    // ---- Cursor & cámara SIEMPRE con el VISUAL snapeado ----
    this.ensureMarker(visLL);
    const hasHeading = (typeof this.headingDeg === 'number' && !Number.isNaN(this.headingDeg));
    this.followCamera(visLL, {
      snapped: !!snap.snapped,
      segBearing: snap.segBearing,
      spKmh,
      hasHeading,
      prev: this.lastCenter
    });

    // Dots solo si estás dentro (raw→snap)
    const distRawSnap = this.distMetersLL(ll, visLL);
    if (snap.snapped && distRawSnap >= 6) {
      this.drawHeadingDotsRawToSnap(ll, visLL, distRawSnap);
      this.lastEntryAlignTs = Date.now();
    } else {
      (this.map.getSource('heading-dots') as maplibregl.GeoJSONSource)
        ?.setData({ type: 'FeatureCollection', features: [] });
    }

    this.lastGoodLL = visLL;
  }



  // helper de heading fusionado

  private fusedHeading(params: {
    gpsHeading: number | null;
    prev: [number, number] | null | undefined;
    curr: [number, number];
    spKmh: number;
   }): number {
    const { gpsHeading, prev, curr, spKmh } = params;

    // En movimiento → rumbo de trayectoria manda
    if (spKmh >= this.MOVE_MIN_KMH && prev) {
      const moveBear = this.bearing(prev, curr);
      const base = (typeof this.lastBearing === 'number') ? this.lastBearing : moveBear;
      const a = Math.max(0.15, Math.min(0.45, spKmh / 20));
      const fused = this.smoothAngle(base, moveBear, a);
      this.lastBearing = fused;
      return fused;
    }

    // Quieto → brújula filtrada si está disponible
    if (typeof this.headingDeg === 'number' && !Number.isNaN(this.headingDeg)) {
      const base = (typeof this.lastBearing === 'number') ? this.lastBearing : this.headingDeg;
      const target = this.headingDeg;
      const sm = this.smoothAngle(base, target, 0.12);
      const delta = this.angleDelta(base, sm);
      const clamp = Math.max(-this.MAX_TURN_PER_FRAME, Math.min(this.MAX_TURN_PER_FRAME, delta));
      const fused = this.normalizeDeg(base + clamp);
      this.lastBearing = fused;
      return fused;
    }

    // Fallback: gpsHeading si vino
    if (typeof gpsHeading === 'number' && !Number.isNaN(gpsHeading)) {
      const comp = this.normalizeDeg(gpsHeading);
      const base = (typeof this.lastBearing === 'number') ? this.lastBearing : comp;
      const fused = this.smoothAngle(base, comp, 0.20);
      this.lastBearing = fused;
      return fused;
    }

    // Último recurso
    this.lastBearing = (typeof this.lastBearing === 'number') ? this.lastBearing : 0;
    return this.lastBearing;
  }

    private getFollowOffsetPx(): [number, number] {
    // Contenedores (ajusta los selectores a los tuyos)
    const mapRect = this.mapEl?.nativeElement.getBoundingClientRect();
    if (!mapRect) return [0, 0];

    const header = document.querySelector('.toolbar-container, ion-header') as HTMLElement | null;
    const hud    = document.querySelector('.stats-hud, .registrar-hud') as HTMLElement | null; // cronómetro+stats
    const tabs   = document.querySelector('ion-tab-bar') as HTMLElement | null;

    const hHeader = header?.offsetHeight ?? 0;
    const hHud    = hud?.offsetHeight ?? 0;
    const hTabs   = tabs?.offsetHeight ?? 0;

    // Queremos ver más “hacia delante”: empujo el puck hacia abajo lo mismo que ocupa el HUD
    // y compenso header/tabs para que quede visualmente centrado en el área libre.
    // Convención MapLibre: +y desplaza el objetivo hacia abajo en pantalla.
    const topBlocked    = hHeader;
    const bottomBlocked = hHud + hTabs;

    // Muevo el objetivo la mitad de la diferencia (área libre centrada) + un pequeño plus (look-ahead)
    const halfDiff = (bottomBlocked - topBlocked) / 2;

    // Pequeño plus de look-ahead para conducción/carrera
    const lookAhead = 30; // px

    const y = Math.round(halfDiff + lookAhead);
    return [0, Math.max(0, y)];
  }

  /** Cámara en modo navegación + rotación del cursor.
   *  - Snapea el centro visual a calle (si aplica).
   *  - Usa heading fusionado si existe; si no, el bearing del segmento; si no, punto-a-punto.
   *  - Ya NO dibuja puntitos aquí (eso se hace en onPosition con rawLL→snapLL).
   */
  private followCamera(centerRaw: LonLat, info?: FollowInfo) {
    if (!this.animFollow || !this.map) return;

    // 1) Snap visual (ya robustece y guarda lastSnapFull)
    const snap = this.snapToStreetIfClose(centerRaw) as SnapFull;
    const center = snap.coord;

    // 2) Bearing a usar con prioridad condicionada
    let useBearing: number | null = null;
    const now = Date.now();
    const entryPriority = this.lastEntryAlignTs && (now - this.lastEntryAlignTs <= this.ENTRY_ALIGN_MS);

    // a) si estamos saliendo de edificio hacia calle o con velocidad baja, prioriza segmento
    if (entryPriority && snap.segBearing != null) {
      useBearing = this.normalizeDeg(snap.segBearing);
      this.lastBearingSource = 'segment';
    }

    // b) si no hubo prioridad anterior, intenta heading de brújula/trayectoria
    if (useBearing == null && typeof this.headingDeg === 'number' && !Number.isNaN(this.headingDeg)) {
      useBearing = this.normalizeDeg(this.headingDeg);
      this.lastBearingSource = 'heading';
    }

    // c) si no, bearing del segmento si existe
    if (useBearing == null && snap.segBearing != null) {
      useBearing = this.normalizeDeg(snap.segBearing);
      this.lastBearingSource = 'segment';
    }

    // d) fallback punto-a-punto
    const prev = info?.prev ?? this.lastCenter;
    if (useBearing == null && prev && (prev[0] !== center[0] || prev[1] !== center[1])) {
      useBearing = this.bearingBetween(prev, center);
      this.lastBearingSource = 'point';
    }

    // e) último recurso
    if (useBearing == null && typeof this.lastBearing === 'number') useBearing = this.lastBearing;
    if (useBearing == null) useBearing = 0;

    // 3) Suavizados + límite de giro si vas lento
    const dt = this._lastFollowTs ? Math.max(16, Math.min(200, now - this._lastFollowTs)) : 50;
    this._lastFollowTs = now;

    const alphaPos = this._followAlpha; // 0.22 por defecto
    const smoothCenter = this.lastCenter
      ? this.smoothPos(this.lastCenter, center, alphaPos)
      : center;

    let smoothBearing = this.lastBearing == null
      ? useBearing
      : this.smoothAngle(this.lastBearing, useBearing, 0.16); // un poco más suave

    const spKmh = info?.spKmh ?? 0;
    if (spKmh < this.MOVE_MIN_KMH) {
      // Quieto/casi quieto → limita giro por frame
      const delta = this.angleDelta(this.lastBearing ?? smoothBearing, smoothBearing);
      const clamp = Math.max(-this.MAX_TURN_PER_FRAME, Math.min(this.MAX_TURN_PER_FRAME, delta));
      smoothBearing = this.normalizeDeg((this.lastBearing ?? smoothBearing) + clamp);
    }

    // 4) Si el usuario está mirando el mapa, no recentrar (pero sí recordamos últimos)
    if (this.userInteracting) {
      this.lastCenter = smoothCenter;
      this.lastBearing = smoothBearing;
      return;
    }

    // 5) Cámara “pegada” detrás del puck (look-ahead) con offset dinámico
    const offsetPx = this.computeCamOffset();
    const mustMove =
      !this.lastCenter ||
      this.haversineMeters(this.lastCenter, smoothCenter) > 0.6 ||
      Math.abs(this.angleDelta(this.lastBearing ?? smoothBearing, smoothBearing)) > 1.2;

    if (mustMove) {
      this.map.easeTo({
        center: smoothCenter,
        bearing: smoothBearing,
        zoom: this.FOLLOW_ZOOM,
        pitch: this.FOLLOW_PITCH,
        offset: offsetPx,
        duration: 320,
        easing: (t) => t * (2 - t)
      });
    }

    // 6) Guarda últimos y rota el marker
    this.lastCenter = smoothCenter;
    this.lastBearing = smoothBearing;
    this.rotateMarker(smoothBearing);
  }

  /* ------------------ helpers ------------------ */

  // Exponential smoothing of position: prev + alpha*(target-prev)
  private smoothPos(prev: [number, number], target: [number, number], alpha: number): [number, number] {
    return [
      prev[0] + (target[0] - prev[0]) * alpha,
      prev[1] + (target[1] - prev[1]) * alpha
    ];
  }

  // simple bearing between two lon/lat points (degrees)
  private bearingBetween(a: [number, number], b: [number, number]): number {
    const toRad = (x: number) => x * Math.PI / 180;
    const toDeg = (x: number) => x * 180 / Math.PI;
    const [lon1, lat1] = a;
    const [lon2, lat2] = b;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return this.normalizeDeg(toDeg(Math.atan2(y, x)));
  }

  // haversine distance approx in meters between two lon/lat pairs
  private haversineMeters(a: [number, number], b: [number, number]): number {
    if (!a || !b) return 0;
    const R = 6371000;
    const toRad = (x: number) => x * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const sinDlat = Math.sin(dLat / 2);
    const sinDlon = Math.sin(dLon / 2);
    const aa = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon * sinDlon;
    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
    return R * c;
  }
    private recenterNow(duration = 0) {
    const ll = this.getLastLngLat() || this.lastGoodLL;
    if (!ll) return;
    this.map.stop();
    this.map.easeTo({
      center: ll,
      bearing: this.lastBearing || this.map.getBearing(),
      pitch: 60,
      offset: this.getFollowOffsetPx(),
      duration
    });
  }
  
  private drawHeadingDotsRawToSnap(rawLL: [number, number], snapLL: [number, number], distM: number) {
    if (!this.map) return;
    const MIN_SHOW = 4;    // antes 6
    const MAX_SHOW = 70;   // antes 45
    const src = this.map.getSource('heading-dots') as maplibregl.GeoJSONSource;
    if (!src || distM < MIN_SHOW || distM > MAX_SHOW) {
      src?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const bearing = this.bearing(rawLL, snapLL);
    const DOT_COUNT = 3;
    const STEP_M = Math.max(5, Math.min(14, distM / (DOT_COUNT + 1)));

    const coords: [number, number][] = [];
    let p = rawLL;
    for (let i = 1; i <= DOT_COUNT; i++) {
      p = this.offsetByBearing(p, bearing, STEP_M);
      coords.push(p);
    }

    src.setData({ type: 'FeatureCollection', features: [{
      type: 'Feature',
      geometry: { type: 'MultiPoint', coordinates: coords },
      properties: {}
    }]});
  }

  private rotateMarker(bearingDeg: number) {
    this.lastBearing = bearingDeg;
    const anyMarker: any = this.marker;

    if (anyMarker?.setRotation) {
      // rotationAlignment:'map' hace que “arriba” del SVG sea “adelante” del mapa
      anyMarker.setRotation(bearingDeg);
      return;
    }
    if (this.markerEl) {
      // Fallback DOM: rota relativo al bearing del mapa
      const relative = bearingDeg - this.map.getBearing();
      const r = Math.round(((relative % 360) + 360) % 360 * 10) / 10;
      this.markerEl.style.transform = `rotate(${r}deg)`;
    }
  }

  // === Acciones UI ===
  center() {
    const ll = this.getLastLngLat();
    if (ll) this.map.easeTo({ center: ll, duration: 600 });
  }

  pauseOrResume() {
    if (this.state() === 'recording') {
      this.zone.run(() => {
        this.trk.pause();
        this.pausedAt = this.getLastLngLat();
        this.pendingResumeCheck = true;
        this.lastDrawn = null;
      });
    } else if (this.state() === 'paused') {
      this.zone.run(() => this.trk.resume());
    }
    const ll = this.getLastLngLat(); if (ll) this.ensureMarker(ll);
    // si hay brújula, re-apunta el puck
    if (this.compassHeadingDeg != null) this.rotateMarker(this.compassHeadingDeg);
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

    const { role } = await modal.onWillDismiss<{save:boolean}>();
    if (role === 'save' || role === 'discard') this.closeAndFinalize(role === 'save');
  }

  private closeAndFinalize(save: boolean) {
    if (this.watchId) { Geolocation.clearWatch({ id: this.watchId }); this.watchId = undefined; }
    const { saved } = this.trk.finalize(save);
    if (save && saved) this.toastMsg('Actividad guardada');
    this.router.navigateByUrl('/tabs/registrar');
  }

  // === Helpers ===
  private ensureMarker(ll: [number, number]) {
    const paused = this.state() === 'paused';
    const SIZE = 44;
    const stroke = 'rgba(0,0,0,.45)';
    const fill = paused ? '#ffb703' : '#00d2ff';

    if (!this.markerEl) {
      // Contenedor del marker
      this.markerEl = document.createElement('div');
      this.markerEl.className = 'user-nav-icon';

      // === Ajustes finos de render/animación ===
      this.markerEl.style.willChange = 'transform';
      this.markerEl.style.transformOrigin = '50% 50%';         // rotación desde el centro
      this.markerEl.style.backfaceVisibility = 'hidden';       // evita “parpadeos” al rotar
      this.markerEl.style.pointerEvents = 'none';              // no captura clicks
      this.markerEl.style.contain = 'layout paint style';      // aisla el render
      // Opcional (si notas tearing en Android muy antiguos):
      // this.markerEl.style.transform = 'translateZ(0)';

      // SVG del puck (flecha dentro de círculo sutil)
      const svg = `
      <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg"
          shape-rendering="geometricPrecision">
        <defs>
          <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1.2" stdDeviation="1.4" flood-color="rgba(0,0,0,.35)"/>
          </filter>
        </defs>
        <g filter="url(#shadow)">
          <circle cx="22" cy="22" r="13" fill="rgba(0,0,0,0.10)"/>
          <g transform="translate(22,22)">
            <!-- Flecha apuntando hacia ARRIBA; la rotamos por CSS/MapLibre -->
            <path d="M0,-14 L9,6 L0,2 L-9,6 Z"
                  fill="${fill}"
                  stroke="${stroke}"
                  stroke-width="1.8"
                  stroke-linejoin="round"/>
          </g>
        </g>
      </svg>`.trim();

      this.markerEl.innerHTML = svg;

      // Marker MapLibre (alineado al mapa para rotar con el bearing)
      this.marker = new maplibregl.Marker({
        element: this.markerEl,
        rotationAlignment: 'map',
        pitchAlignment: 'map',
        anchor: 'center'
      })
        .setLngLat(ll)
        .addTo(this.map);
    } else {
      // Actualiza color si cambia de estado (paused/recording)
      const path = this.markerEl.querySelector('path');
      if (path) (path as SVGPathElement).setAttribute('fill', fill);
      this.marker!.setLngLat(ll);
    }
  }

  /** Intenta “encajar” visualmente el punto a la calle más cercana.
 *  Usa queryRenderedFeatures contra capas de transporte del estilo.
 *  Solo hace snap si está a <= 18 m de una calle y la precisión no es pésima.
 *  Devuelve coord (lng,lat) para MAPA y un bearing sugerido del segmento. */
  private snapToStreetIfClose(
    rawLL: LonLat,
    accuracyOrOpts?: number | { maxDistanceMeters?: number }
  ): SnapFull {
    if (!this.map || !this.map.isStyleLoaded()) {
      return { coord: rawLL, snapped: false };
    }

    const accuracyM = typeof accuracyOrOpts === 'number' ? accuracyOrOpts : undefined;
    const maxDist = typeof accuracyOrOpts === 'number'
      ? undefined
      : accuracyOrOpts?.maxDistanceMeters ?? 12;

    if (typeof accuracyM === 'number' && accuracyM > 250) {
      return { coord: rawLL, snapped: false };
    }

    // Reusar último snap si estamos muy cerca (suaviza)
    if (this.lastSnapFull?.coord) {
      const dStick = this.distMetersLL(rawLL, this.lastSnapFull.coord);
      const keepTol = (accuracyM ?? 999) > 40 ? 50 : 30;
      if (dStick <= keepTol) return { ...this.lastSnapFull, snapped: true };
    }

    const pt = this.map.project(rawLL);
    const roadLayers = this.roadLayerIds();

    const z = this.map.getZoom();
    const base = z >= 18 ? 65 : z >= 16 ? 85 : 110;
    const bonus = (accuracyM ?? 0) > 60 ? 35 : 0;
    const RADII = [base, base + 35 + bonus, base + 70 + bonus];

    let feats: maplibregl.MapGeoJSONFeature[] = [];
    const tryCollect = (layers?: string[]) => {
      for (const r of RADII) {
        const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
          new maplibregl.Point(pt.x - r, pt.y - r),
          new maplibregl.Point(pt.x + r, pt.y + r),
        ];
        const fs = this.map.queryRenderedFeatures(
          bbox,
          layers?.length ? { layers } : undefined
        ) as maplibregl.MapGeoJSONFeature[];
        if (fs.length) { feats = fs; return true; }
      }
      return false;
    };

    let ok = roadLayers.length ? tryCollect(roadLayers) : false;
    if (!ok) ok = tryCollect();

    if (!ok || !feats.length) return { coord: rawLL, snapped: false };

    // filtra a geometrías lineales no-building
    feats = feats.filter(f => {
      const g = f.geometry as GeoJSON.Geometry;
      const isLine = g.type === 'LineString' || g.type === 'MultiLineString';
      const srcLayer = (f as any)['sourceLayer'] || (f as any)['source-layer'] || '';
      const isBuilding = typeof srcLayer === 'string' ? /building/i.test(srcLayer) : false;
      return isLine && !isBuilding;
    });
    if (!feats.length) return { coord: rawLL, snapped: false };

    const heading = (typeof this.headingDeg === 'number' && !Number.isNaN(this.headingDeg)) ? this.headingDeg : null;

    let bestScore = Number.POSITIVE_INFINITY;
    let best: {
      feature: maplibregl.MapGeoJSONFeature;
      line: LonLat[];
      segIdx: number;
      segT: number;
      near: LonLat;
      segBear?: number;
      dist: number;
    } | null = null;

    for (const f of feats) {
      const key = this.featureKeyOf(f);
      let line = this.streetGeomCache.get(key);
      if (!line) {
        const flat = this.flattenLineCoords(f.geometry as any);
        if (!flat || flat.length < 2) continue;
        line = flat;
        this.streetGeomCache.set(key, line);
      }

      // Busca el segmento más cercano
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        const proj = this.nearestPointOnSegmentT(rawLL, a, b);
        const d = this.distMetersLL(rawLL, proj.ll);
        const segBear = this.bearing(a, b);
        const ang = heading == null ? 0 : Math.min(Math.abs(segBear - heading), 360 - Math.abs(segBear - heading));
        const score = d + (heading == null ? 0 : ang * 0.30);
        if (score < bestScore) {
          bestScore = score;
          best = { feature: f, line, segIdx: i, segT: proj.t, near: proj.ll, segBear, dist: d };
        }
      }
    }

    const MAX_SNAP_M = typeof maxDist === 'number' ? maxDist : 70;
    if (!best || best.dist > MAX_SNAP_M) return { coord: rawLL, snapped: false };

    const res: SnapFull = {
      coord: best.near,
      snapped: true,
      segBearing: best.segBear,
      featureKey: this.featureKeyOf(best.feature),
      line: best.line,
      segIdx: best.segIdx,
      segT: best.segT
    };
    this.lastSnapFull = res;
    return res;
  }

  // ==== Helpers de ángulos (pegar dentro de la clase) ====
  private normalizeDeg(d: number): number {
    return (d % 360 + 360) % 360;
  }
  private angleDelta(a: number, b: number): number {
    // diferencia mínima a->b en [-180,180]
    let d = this.normalizeDeg(b) - this.normalizeDeg(a);
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }
  private smoothAngle(prev: number, next: number, alpha: number): number {
    const d = this.angleDelta(prev, next);
    return this.normalizeDeg(prev + d * alpha);
  }

  /** IDs de capas de transporte del estilo (MapTiler streets v2) */
  private roadLayerIds(): string[] {
    const st = this.map.getStyle();
    if (!st?.layers) return [];

    // Coincidencias amplias por id y por source-layer
    const ID_RE = /(transport|road|highway|street|motorway|primary|secondary|tertiary)/i;
    const SL_RE = /(transportation|road|highway|street)/i;

    const ids = st.layers
      .filter(l =>
        l.type === 'line' && (
          ID_RE.test(l.id) ||
          (typeof (l as any)['source-layer'] === 'string' && SL_RE.test((l as any)['source-layer']))
        )
      )
      .map(l => l.id);

    return ids;
  }

  /** Punto más cercano sobre el segmento AB a la ubicación P. */
  private nearestPointOnSegment(
    p: [number, number], a: [number, number], b: [number, number]
  ): [number, number] {
    const pa = this.map.project(p);
    const aa = this.map.project(a);
    const bb = this.map.project(b);

    const abx = bb.x - aa.x, aby = bb.y - aa.y;
    const apx = pa.x - aa.x, apy = pa.y - aa.y;
    const ab2 = abx*abx + aby*aby || 1;
    const t = Math.max(0, Math.min(1, (apx*abx + apy*aby) / ab2));
    const projX = aa.x + abx * t;
    const projY = aa.y + aby * t;

    const ll = this.map.unproject([projX, projY]) as maplibregl.LngLat;
    return [ll.lng, ll.lat];
  }

    private initHeadingDotsLayer() {
      if (!this.map.getSource('heading-dots')) {
        this.map.addSource('heading-dots', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        this.map.addLayer({
          id: 'heading-dots-layer',
          type: 'circle',
          source: 'heading-dots',
          paint: {
            'circle-color': '#ffffff',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 3.5],
            'circle-opacity': 0.85
          }
        });
      }
    }

  /** Puntos de referencia entre el GPS crudo (rawLL) y el snap en calle (snapLL).
   *  - Se muestran SOLO si estás "dentro" (distancia raw↔snap por encima del umbral).
   *  - Apuntan SIEMPRE desde el edificio hacia la calle (interpolando el segmento raw→snap).
   *  - Desaparecen automáticamente al quedar frente a la calle (histéresis).
   *  - Si la precisión es mala, no se dibujan.
   */
  private drawHeadingDots(center: [number, number], bearing: number) {
    if (!this.map) return;

    const DOT_COUNT = 3;
    const STEP_M = 8;
    const rad = (bearing * Math.PI) / 180;
    const coords: [number, number][] = [];

    for (let i = 1; i <= DOT_COUNT; i++) {
      const fwd = this.destinationLL(center, STEP_M * i, rad);
      coords.push(fwd);
    }

    const feature: GeoJSON.Feature = {
      type: 'Feature',
      geometry: {
        type: 'MultiPoint',
        coordinates: coords
      },
      properties: {}
    };

    (this.map.getSource('heading-dots') as maplibregl.GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: [feature]
    });
  }

  private destinationLL(center: [number, number], distM: number, rad: number): [number, number] {
  const R = 6371000; // radio terrestre en m
  const lat1 = center[1] * Math.PI / 180;
  const lng1 = center[0] * Math.PI / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distM / R) +
    Math.cos(lat1) * Math.sin(distM / R) * Math.cos(rad)
  );

  const lng2 = lng1 + Math.atan2(
    Math.sin(rad) * Math.sin(distM / R) * Math.cos(lat1),
    Math.cos(distM / R) - Math.sin(lat1) * Math.sin(lat2)
  );

  return [lng2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

  /** Desplaza un punto (lng,lat) “distM” metros en rumbo “bearingDeg”. */
  private offsetByBearing(center: [number, number], bearingDeg: number, distM: number): [number, number] {
    const R = 6371000;
    const br = bearingDeg * Math.PI/180;
    const lat1 = center[1] * Math.PI/180;
    const lng1 = center[0] * Math.PI/180;

    const lat2 = Math.sin(lat1)*Math.cos(distM/R) + Math.cos(lat1)*Math.sin(distM/R)*Math.cos(br);
    const lat  = Math.asin(lat2);
    const lng  = lng1 + Math.atan2(
      Math.sin(br)*Math.sin(distM/R)*Math.cos(lat1),
      Math.cos(distM/R) - Math.sin(lat1)*Math.sin(lat)
    );

    return [ lng*180/Math.PI, lat*180/Math.PI ];
  }

  //helpers...........
  private getLastLatLng(): [number, number] | null {
    const snap = this.trk.activeSnapshot;
    const seg = snap?.segments?.[snap.segments.length - 1];
    const p = seg?.points?.[seg.points.length - 1];
    return p ? [p.lng, p.lat] : null;
  }

  private getAllLngLatsFromActive(): [number, number][] {
    const snap = this.trk.activeSnapshot;
    if (!snap?.segments?.length) return [];
    const arr: [number, number][] = [];
    for (const s of snap.segments) for (const p of (s.points || [])) arr.push([p.lng, p.lat]);
    return arr;
  }

  private getLastLngLat(): [number, number] | null {
    const last = this.currentCoords[this.currentCoords.length - 1];
    return last ? [last[0] as number, last[1] as number] : null;
  }

  private distMetersLL(a: [number, number], b: [number, number]): number {
    const R = 6371000, dLat = (b[1]-a[1])*Math.PI/180, dLng=(b[0]-a[0])*Math.PI/180;
    const s1=Math.sin(dLat/2), s2=Math.sin(dLng/2);
    const t=s1*s1 + Math.cos(a[1]*Math.PI/180)*Math.cos(b[1]*Math.PI/180)*s2*s2;
    return 2*R*Math.asin(Math.min(1, Math.sqrt(t)));
  }

  private bearing(a: [number, number], b: [number, number]): number {
    const [lng1, lat1] = [a[0]*Math.PI/180, a[1]*Math.PI/180];
    const [lng2, lat2] = [b[0]*Math.PI/180, b[1]*Math.PI/180];
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
