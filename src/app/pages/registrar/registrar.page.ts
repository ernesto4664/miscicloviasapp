import { Component, OnInit, AfterViewInit, ViewChild, ElementRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// Ionic (standalone)
import {
  IonButtons, IonContent, IonHeader, IonTitle, IonToolbar,
  IonMenuButton, IonButton, IonFab, IonFabButton, IonIcon
} from '@ionic/angular/standalone';

// Servicios Ionic no-standalone
import { NavController, ToastController, Platform, ModalController } from '@ionic/angular';

import { Geolocation, Position } from '@capacitor/geolocation';
import { Router } from '@angular/router';
import * as L from 'leaflet';

import { AuthService } from '../../core/services/auth.service';
import { TrackService } from '../../core/services/track.service';
import { TrackingModalComponent } from './tracking-modal.component';


@Component({
  standalone: true,
  selector: 'app-registrar',
  templateUrl: './registrar.page.html',
  styleUrls: ['./registrar.page.scss'],
  imports: [
    IonIcon, IonFabButton, IonFab,
    IonButton, CommonModule, FormsModule,
    IonButtons, IonContent, IonHeader, IonTitle, IonToolbar, IonMenuButton
  ]
})
export class RegistrarPage implements OnInit, AfterViewInit {
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
  private starting = false;

  // ---- Calidad / suavizado (para el preview) ----
  private readonly ACC_GOOD = 20;   // m
  private readonly ACC_OK   = 50;   // m
  private emaLat?: number; private emaLng?: number;
  private ema(alpha: number, lat: number, lng: number): L.LatLng {
    this.emaLat = this.emaLat === undefined ? lat : alpha * lat + (1 - alpha) * this.emaLat;
    this.emaLng = this.emaLng === undefined ? lng : alpha * lng + (1 - alpha) * this.emaLng;
    return L.latLng(this.emaLat, this.emaLng);
  }

  ngOnInit() {}
  ngAfterViewInit() { this.initPreviewMap(); }

  // ---------- Helpers de permisos ----------
  private async ensurePerms(): Promise<boolean> {
    try {
      const perm = await Geolocation.checkPermissions();
      if (perm.location === 'granted') return true;
      const req = await Geolocation.requestPermissions();
      return req.location === 'granted';
    } catch { return false; }
  }

  // ---------- Best-of-N para primer fix (elige la mejor accuracy en una ventana corta) ----------
  private collectPositions(windowMs = 3500, perPosTimeout = 10000): Promise<import('@capacitor/geolocation').GeolocationPosition> {
    return new Promise(async (resolve, reject) => {
      const picks: import('@capacitor/geolocation').GeolocationPosition[] = [];
      let watchId: string | undefined;

      const timer = setTimeout(async () => {
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
        (pos, err) => { if (pos) picks.push(pos as import('@capacitor/geolocation').GeolocationPosition); }
      );
    });
  }

  /** Espera el PRIMER fix que llega por watchPosition (con timeout). */
  private firstFixOrTimeout(ms = 15000): Promise<Position> {
    return new Promise((resolve, reject) => {
      let cleared = false;
      let watchId: string | undefined;

      const timer = setTimeout(() => {
        if (cleared) return;
        cleared = true;
        if (watchId) Geolocation.clearWatch({ id: watchId });
        reject(new Error('timeout'));
      }, ms);

      Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 0, timeout: ms },
        (pos, err) => {
          if (cleared) return;
          if (err || !pos) return;   // seguimos esperando
          cleared = true;
          clearTimeout(timer);
          if (watchId) Geolocation.clearWatch({ id: watchId });
          resolve(pos as Position);
        }
      ).then(id => (watchId = id!));
    });
  }

  // ---------- Estrategia robusta para primer fix (race + reintento + fallback) ----------
  private async getBestInitialPosition(): Promise<import('@capacitor/geolocation').GeolocationPosition> {
    const ok = await this.ensurePerms();
    if (!ok) throw new Error('perm-denied');

    const race1 = Promise.race([
      this.collectPositions(3500, 12000),
      Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 7000, maximumAge: 0 }),
    ]);
    try { return await race1 as import('@capacitor/geolocation').GeolocationPosition; } catch {}

    const race2 = Promise.race([
      this.collectPositions(6000, 15000),
      Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }),
    ]);
    try { return await race2 as import('@capacitor/geolocation').GeolocationPosition; } catch {}

    // Fallback (centrar algo mientras tanto)
    try {
      return await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 });
    } catch {}

    // Último recurso: Santiago
    await this.showToast('No pudimos fijar tu ubicación a tiempo. Revisa GPS/precisión.');
    return {
      coords: { latitude: -33.45, longitude: -70.66, accuracy: 9999, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    };
  }

  // ----------------- flujo de inicio -----------------
  async onStart() {
    if (this.starting) return;
    this.starting = true;
    try {
      const ok = await this.ensurePerms();
      if (!ok) { await this.showToast('Necesitamos tu ubicación para iniciar.'); return; }

      // “calentamos” el GPS (rápido, no bloquea)
      Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000 }).catch(() => null);

      // arranca tracking (idempotente)
      this.trk.start();

      // navega a la página de tracking activo
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

  // ----------------- Preview Map -----------------
  private async initPreviewMap() {
    if (!this.previewMap) {
      this.previewMap = L.map(this.previewMapEl.nativeElement, { zoomControl: false, attributionControl: true });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
        maxZoom: 20, attribution: '&copy; OpenStreetMap, © CARTO'
      }).addTo(this.previewMap);
    }

    // centro por defecto
    let center = L.latLng(-33.4489, -70.6693);

    try {
      // Usa best-of-N corto para tener un preview más fino (rápido)
      const pos = await Promise.race([
        this.collectPositions(2500, 8000),
        Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }),
      ]) as import('@capacitor/geolocation').GeolocationPosition;

      const acc = pos.coords.accuracy ?? 9999;
      const base = L.latLng(pos.coords.latitude, pos.coords.longitude);
      // suaviza un poco el preview (EMA suave)
      const alpha = acc <= this.ACC_GOOD ? 0.35 : (acc <= this.ACC_OK ? 0.25 : 0.15);
      center = this.ema(alpha, base.lat, base.lng);
    } catch {
      // si falla, nos quedamos con el centro por defecto
    }

    this.previewMap.setView(center, 16);

    if (!this.previewMarker) {
      this.previewMarker = L.circleMarker(center, {
        radius: 8, color: '#2b8cff', weight: 2, fillColor: '#2b8cff', fillOpacity: 0.25
      }).addTo(this.previewMap);
    } else {
      this.previewMarker.setLatLng(center);
    }

    setTimeout(() => this.previewMap!.invalidateSize(true), 200);
  }

  async centerPreview() {
    try {
      // usa un intent rápido con alta precisión
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000, maximumAge: 250 });
      const acc = pos.coords.accuracy ?? 9999;
      const raw = L.latLng(pos.coords.latitude, pos.coords.longitude);
      const alpha = acc <= this.ACC_GOOD ? 0.35 : (acc <= this.ACC_OK ? 0.25 : 0.15);
      const ll = this.ema(alpha, raw.lat, raw.lng);

      this.previewMap?.setView(ll, Math.max(this.previewMap?.getZoom() ?? 16, 16), { animate: true });
      if (!this.previewMarker) {
        this.previewMarker = L.circleMarker(ll, {
          radius: 8, color: '#2b8cff', weight: 2, fillColor: '#2b8cff', fillOpacity: 0.25
        }).addTo(this.previewMap!);
      } else {
        this.previewMarker.setLatLng(ll);
      }
    } catch {
      // si falla, recentra al último center visible
      const center = this.previewMap?.getCenter();
      if (center) this.previewMap?.setView(center, 16, { animate: true });
    }
  }
}
