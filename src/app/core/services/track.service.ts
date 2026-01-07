// src/app/core/services/track.service.ts
import { Injectable, signal, inject } from '@angular/core';
import * as L from 'leaflet';
import { ActivitiesApi, PointIn } from './activities.api';

const LS_KEY_ACTIVE = 'mc_track_active';
const LS_KEY_SAVED  = 'mc_track_saved';

// Persistir el activo como mucho cada N ms (evita escribir en cada punto)
const PERSIST_EVERY_MS = 5000;

// ✅ Umbral de precisión aceptable (m) — 65 era MUY agresivo en ciudad
const MAX_ACCURACY_M = 200;

export type TrackState = 'idle' | 'recording' | 'paused';

export interface TrackPoint { lat: number; lng: number; ts: number; speed?: number; acc?: number; }
export interface TrackSegment { points: TrackPoint[]; }
export interface TrackSaved {
  id: string;
  startedAt: number;
  durationMs: number;
  distanceKm: number;
  segments: TrackSegment[];
}
export interface TrackSummary { durationMs: number; distanceKm: number; avgSpeedKmh: number; }

@Injectable({ providedIn: 'root' })
export class TrackService {
  // ======= Estado reactivo expuesto =======
  stateSig = signal<TrackState>('idle');
  distanceKmSig = signal(0);
  speedKmhSig = signal(0);
  startedAtSig = signal<number>(0);
  pausedAccumMsSig = signal(0);
  pauseStartedAtSig = signal<number>(0);

  // ======= Datos internos =======
  private segments: TrackSegment[] = [];
  private get currentSeg(): TrackSegment {
    if (this.segments.length === 0) this.segments.push({ points: [] });
    return this.segments[this.segments.length - 1];
  }

  // Filtros / umbrales
  private minMoveMeters = 5;                   // descartamos jitter < 5 m
  private autoPauseSpeedKmh = 1.0;             // < 1 km/h durante autoPauseAfterMs → pausa
  private autoPauseAfterMs = 9000;             // 9 s
  private maxStopMsNewSegment = 3 * 60 * 1000; // >3 min parado → nuevo segmento

  // ✅ anti “saltos GPS”
  private maxJumpMeters = 80;                  // si salto > 80 m en un tick, no suma (pero guarda punto)

  // Estado auxiliar
  private idleSinceTs = 0;
  private lastPersistMs = 0;

  // Suavizado de velocidad
  private speedSmoothKmh = 0;
  private readonly speedAlpha = 0.35;

  // ======= Sincronización con API =======
  private api = inject(ActivitiesApi);

  // number = creada, undefined = no sincroniza
  private activityId?: number | null;

  private pendingBatch: PointIn[] = [];
  private batchTimer?: any;
  private readonly BATCH_MS = 3500;

  // ======= Snapshot para persistencia/UI =======
  get activeSnapshot() {
    return {
      state: this.stateSig(),
      distanceKm: this.distanceKmSig(),
      speedKmh: this.speedKmhSig(),
      startedAt: this.startedAtSig(),
      pausedAccumMs: this.pausedAccumMsSig(),
      pauseStartedAt: this.pauseStartedAtSig(),
      segments: this.segments,

      // ✅ NUEVO: para no perder sync si la app se cierra y vuelve
      activityId: (typeof this.activityId === 'number' ? this.activityId : null),
    };
  }

  restoreIfAny(): boolean {
    const raw = localStorage.getItem(LS_KEY_ACTIVE);
    if (!raw) return false;

    try {
      const o = JSON.parse(raw);

      const state: TrackState = (o.state === 'recording' || o.state === 'paused') ? o.state : 'idle';
      const segments: TrackSegment[] = Array.isArray(o.segments) ? o.segments : [{ points: [] }];
      if (segments.length === 0) segments.push({ points: [] });

      this.stateSig.set(state);
      this.distanceKmSig.set(Number(o.distanceKm) || 0);
      this.speedKmhSig.set(Number(o.speedKmh) || 0);
      this.startedAtSig.set(Number(o.startedAt) || 0);
      this.pausedAccumMsSig.set(Number(o.pausedAccumMs) || 0);
      this.pauseStartedAtSig.set(Number(o.pauseStartedAt) || 0);
      this.segments = segments;

      this.speedSmoothKmh = this.speedKmhSig();

      // ✅ NUEVO: restaurar activityId y rearmar batching si aplica
      this.activityId = (typeof o.activityId === 'number') ? o.activityId : undefined;

      this.pendingBatch = [];
      if (this.batchTimer) { clearInterval(this.batchTimer); this.batchTimer = undefined; }

      if (typeof this.activityId === 'number') {
        this.batchTimer = setInterval(() => this.flushBatch(), this.BATCH_MS);
      }

      return true;
    } catch {
      return false;
    }
  }

  // ======= Ciclo de vida del tracking =======
  async start() {
    // ✅ NUEVO: idempotencia real (evita doble start por taps, reentradas, etc.)
    if (this.stateSig() !== 'idle') return;

    // limpiar timers previos por si acaso
    if (this.batchTimer) { clearInterval(this.batchTimer); this.batchTimer = undefined; }

    this.segments = [{ points: [] }];
    this.distanceKmSig.set(0);
    this.speedKmhSig.set(0);
    this.speedSmoothKmh = 0;
    this.startedAtSig.set(Date.now());
    this.pausedAccumMsSig.set(0);
    this.pauseStartedAtSig.set(0);
    this.idleSinceTs = 0;

    this.activityId = undefined;
    this.pendingBatch = [];

    this.stateSig.set('recording');
    this.persistActive(true);

    try {
      const res = await this.api.start();
      this.activityId = res?.id ?? undefined;
    } catch {
      this.activityId = undefined;
    }

    if (typeof this.activityId === 'number' && !this.batchTimer) {
      this.batchTimer = setInterval(() => this.flushBatch(), this.BATCH_MS);
    }

    // persiste con activityId
    this.persistActive(true);
  }

  startNew() { void this.start(); }

  private pauseLocal(now = Date.now()) {
    if (this.stateSig() !== 'recording') return;
    this.stateSig.set('paused');
    this.pauseStartedAtSig.set(now);
    this.persistActive(false);
  }

  private resumeLocal(now = Date.now()) {
    if (this.stateSig() !== 'paused') return;
    const pauseStarted = this.pauseStartedAtSig();
    if (pauseStarted) {
      this.pausedAccumMsSig.set(this.pausedAccumMsSig() + Math.max(0, now - pauseStarted));
    }
    this.pauseStartedAtSig.set(0);
    this.idleSinceTs = 0;
    this.stateSig.set('recording');
    this.persistActive(false);
  }

  async pause(manual = true) {
    if (this.stateSig() !== 'recording') return;
    this.pauseLocal(Date.now());
    this.persistActive(manual);

    await this.flushBatch();
    if (typeof this.activityId === 'number') {
      try { await this.api.pause(this.activityId); } catch {}
    }
  }

  async resume(manual = true) {
    if (this.stateSig() !== 'paused') return;
    this.resumeLocal(Date.now());
    this.persistActive(manual);

    if (typeof this.activityId === 'number') {
      try { await this.api.resume(this.activityId); } catch {}
    }
  }

  getSummary(): TrackSummary {
    const start = this.startedAtSig() || Date.now();
    const end = (this.stateSig() === 'paused'
      ? (this.pauseStartedAtSig() || Date.now())
      : Date.now());
    const durationMs = Math.max(0, end - start - this.pausedAccumMsSig());
    const distanceKm = this.distanceKmSig();
    const hours = durationMs / 3_600_000;
    const avgSpeedKmh = hours > 0 ? distanceKm / hours : 0;
    return { durationMs, distanceKm, avgSpeedKmh };
  }

  reset() {
    localStorage.removeItem(LS_KEY_ACTIVE);

    this.stateSig.set('idle');
    this.distanceKmSig.set(0);
    this.speedKmhSig.set(0);
    this.startedAtSig.set(0);
    this.pausedAccumMsSig.set(0);
    this.pauseStartedAtSig.set(0);

    this.segments = [{ points: [] }];
    this.idleSinceTs = 0;
    this.speedSmoothKmh = 0;
    this.lastPersistMs = 0;

    if (this.batchTimer) { clearInterval(this.batchTimer); this.batchTimer = undefined; }
    this.activityId = undefined;
    this.pendingBatch = [];
  }

  finalize(save: boolean): { saved: TrackSaved | null; summary: TrackSummary } {
    if (this.stateSig() === 'paused') {
      this.resumeLocal(Date.now());
    }

    const summary = this.getSummary();
    let saved: TrackSaved | null = null;

    if (save) {
      saved = {
        id: `trk_${this.startedAtSig()}`,
        startedAt: this.startedAtSig(),
        durationMs: summary.durationMs,
        distanceKm: summary.distanceKm,
        segments: this.segments,
      };
      const list: TrackSaved[] = JSON.parse(localStorage.getItem(LS_KEY_SAVED) || '[]');
      list.unshift(saved);
      localStorage.setItem(LS_KEY_SAVED, JSON.stringify(list));
    }

    const actId = this.activityId;

    this.flushBatch().finally(() => {
      if (typeof actId === 'number') {
        this.api.finish(actId, {
          elapsed_ms: summary.durationMs,
          distance_m: summary.distanceKm * 1000,
          avg_speed_kmh: summary.avgSpeedKmh,
          save,
        }).catch(() => {});
      }
    });

    this.reset();
    return { saved, summary };
  }

  getSaved(): TrackSaved[] {
    const list: TrackSaved[] = JSON.parse(localStorage.getItem(LS_KEY_SAVED) || '[]');
    return list.sort((a, b) => b.startedAt - a.startedAt);
  }

  deleteSaved(id: string) {
    const list: TrackSaved[] = JSON.parse(localStorage.getItem(LS_KEY_SAVED) || '[]');
    localStorage.setItem(LS_KEY_SAVED, JSON.stringify(list.filter(t => t.id !== id)));
  }

  clearSaved() {
    localStorage.removeItem(LS_KEY_SAVED);
  }

  exportGPX(track: TrackSaved): string {
    const esc = (n: number) => n.toFixed(6);
    const toIso = (ms: number) => new Date(ms).toISOString();
    const trksegs = track.segments.map(seg => `
      <trkseg>
        ${seg.points.map(p => `<trkpt lat="${esc(p.lat)}" lon="${esc(p.lng)}"><time>${toIso(p.ts)}</time></trkpt>`).join('\n')}
      </trkseg>`).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MisCiclovías" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${track.id}</name>${trksegs}</trk>
</gpx>`;
  }

  // ======= Ingesta de posiciones =======
  onPosition(lat: number, lng: number, ts: number, speed?: number, accuracy?: number) {
    if (this.stateSig() !== 'recording') return;

    const now = ts || Date.now();
    const lastPt = this.getLastPointAnySegment();
    const acc = (typeof accuracy === 'number' ? accuracy : undefined);

    let movedMeters = 0;
    if (lastPt) {
      movedMeters = L.latLng(lat, lng).distanceTo(L.latLng(lastPt.lat, lastPt.lng));
    }

    // ✅ Velocidad UI: aunque accuracy sea mala, si viene speed del GPS úsala para UI
    if (typeof speed === 'number' && !Number.isNaN(speed)) {
      const vKmh = Math.max(0, speed * 3.6);
      this.speedSmoothKmh = this.speedAlpha * vKmh + (1 - this.speedAlpha) * this.speedSmoothKmh;
      this.speedKmhSig.set(this.speedSmoothKmh);
    }

    // ✅ Decidir segmento ANTES de guardar punto:
    // Si estuvo detenido mucho y NO estamos pausados, creamos un nuevo segmento y el punto actual cae ahí.
    if (
      lastPt &&
      this.stateSig() !== 'paused' &&
      this.idleSinceTs &&
      (now - this.idleSinceTs) > this.maxStopMsNewSegment
    ) {
      this.segments.push({ points: [] });
      // no resetees idle aquí; se limpia cuando acepte movimiento real
    }

    // ✅ Siempre guardamos el punto (para no cortar track)
    const p: TrackPoint = { lat, lng, ts: now, speed, acc };
    this.currentSeg.points.push(p);

    // No hay punto previo => nada que sumar aún
    if (!lastPt) {
      this.maybeBatch(now, lat, lng, acc, speed);
      this.maybePersist();
      return;
    }

    // ✅ Reglas blindadas para sumar distancia:
    if (movedMeters < this.minMoveMeters || movedMeters > this.maxJumpMeters) {
      this.considerIdle(now, speed);
      this.maybeBatch(now, lat, lng, acc, speed);
      this.maybePersist();
      return;
    }

    const accOk = (acc == null) ? true : acc <= MAX_ACCURACY_M;

    // ✅ Accuracy mala pero movimiento real + velocidad razonable => igual aceptamos
    const speedKmhRaw = (typeof speed === 'number' ? speed * 3.6 : undefined);
    const acceptDespiteBadAcc = !accOk && (speedKmhRaw != null && speedKmhRaw >= 6);

    if (accOk || acceptDespiteBadAcc) {
      this.distanceKmSig.set(this.distanceKmSig() + (movedMeters / 1000));

      // Si NO venía speed (m/s), calcula por delta tiempo
      if (!(typeof speed === 'number' && !Number.isNaN(speed))) {
        const dt = Math.max(0.25, (now - lastPt.ts) / 1000);
        const vKmh = (movedMeters / dt) * 3.6;
        this.speedSmoothKmh = this.speedAlpha * vKmh + (1 - this.speedAlpha) * this.speedSmoothKmh;
        this.speedKmhSig.set(this.speedSmoothKmh);
      }

      // ✅ como hubo movimiento real, limpio idle
      this.idleSinceTs = 0;
    } else {
      // Accuracy mala: no sumes, pero maneja idle
      this.considerIdle(now, speed);
    }

    this.maybeBatch(now, lat, lng, acc, speed);
    this.maybePersist();
  }

  // ======= Helpers internos =======
  private getLastPointAnySegment(): TrackPoint | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const pts = this.segments[i]?.points;
      if (pts && pts.length) return pts[pts.length - 1];
    }
    return undefined;
  }

  private considerIdle(now: number, speed?: number) {
    if (!this.idleSinceTs) this.idleSinceTs = now;

    const effectiveSpeed =
      (typeof speed === 'number' && !Number.isNaN(speed))
        ? speed * 3.6
        : this.speedKmhSig();

    if (effectiveSpeed < this.autoPauseSpeedKmh && (now - this.idleSinceTs) > this.autoPauseAfterMs) {
      if (this.stateSig() === 'recording') void this.pause(false);
    }
  }

  private maybePersist() {
    const now = Date.now();
    if (now - this.lastPersistMs >= PERSIST_EVERY_MS) {
      this.persistActive(false);
      this.lastPersistMs = now;
    }
  }

  private persistActive(force: boolean) {
    const snap = this.activeSnapshot;
    localStorage.setItem(LS_KEY_ACTIVE, JSON.stringify(snap));
    if (force) this.lastPersistMs = Date.now();
  }

  private maybeBatch(now: number, lat: number, lng: number, acc?: number, speed?: number) {
    if (typeof this.activityId !== 'number') return;
    this.pendingBatch.push({
      ts: now,
      lat,
      lng,
      accuracy_m: acc,
      speed_mps: (typeof speed === 'number' ? speed : undefined),
    });
  }

  private async flushBatch() {
    if (typeof this.activityId !== 'number' || !this.pendingBatch.length) return;
    const batch = this.pendingBatch.splice(0, this.pendingBatch.length);
    try {
      await this.api.pushPoints(this.activityId, batch);
    } catch {
      this.pendingBatch.unshift(...batch);
    }
  }
}
