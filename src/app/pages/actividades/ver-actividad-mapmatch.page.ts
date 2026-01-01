import {
  Component, AfterViewInit, OnDestroy, ViewChild, ElementRef, inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Position } from 'geojson';
import { ActivitiesApi } from '../../core/services/activities.api';

@Component({
  standalone: true,
  selector: 'app-ver-actividad-mapmatch',
  templateUrl: './ver-actividad-mapmatch.page.html',
  styleUrls: ['./ver-actividad-mapmatch.page.scss'],
  imports: [CommonModule, IonicModule]
})
export class VerActividadMapmatchPage implements AfterViewInit, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;

  private api = inject(ActivitiesApi);
  // si pasas el id por ruta, puedes leerlo con ActivatedRoute;
  // para mantenerlo simple, usamos el hash ?id=123 en esta versión:
  private activityId!: number;

  private map!: maplibregl.Map;
  private animReq?: number;

  async ngAfterViewInit() {
    // ===== 1) Obtener id (?id=123) =====
    const url = new URL(window.location.href);
    this.activityId = Number(url.searchParams.get('id') || NaN);
    if (!Number.isFinite(this.activityId)) return;

    // ===== 2) Llamar a /mapmatch =====
    const featResp = await this.api.mapmatch(this.activityId, true).catch(() => null);
    if (!featResp || featResp.type !== 'Feature') return;

    // Nos aseguramos que sea LineString
    const feature = featResp as Feature<LineString>;
    const coords = (feature.geometry?.coordinates || []) as Position[];
    if (!coords.length) return;

    // ===== 3) Inicializar MapLibre (estilo gratis público) =====
    this.map = new maplibregl.Map({
    container: this.mapEl.nativeElement,
    style: 'https://demotiles.maplibre.org/style.json',
    center: coords[0] as [number, number],
    zoom: 15.5,
    pitch: 60,
    bearing: 30,
    
    antialias: true
    } as any);

    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    this.map.on('load', () => {
      // ===== 4) Añadir la línea (casing + línea principal) =====
      const routeFeature: Feature<LineString> = feature;
      const routeFC: FeatureCollection = { type: 'FeatureCollection', features: [routeFeature] };

      this.map.addSource('route', {
        type: 'geojson',
        data: routeFC
      });

      // casing
      this.map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': '#0d4f97',
          'line-width': 10,
          'line-opacity': 0.6
        }
      });

      // línea
      this.map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        paint: {
          'line-color': '#2b9bff',
          'line-width': 6,
          'line-opacity': 0.95
        }
      });

      // ===== 5) Marker animado recorriendo la línea =====
      const markerEl = document.createElement('div');
      markerEl.className = 'runner';
      markerEl.innerHTML = `
        <svg width="32" height="32" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
          <circle cx="22" cy="22" r="10" fill="rgba(255,255,255,0.2)"/>
          <g transform="translate(22,22)">
            <path d="M0,-12 L8,4 L0,1 L-8,4 Z" fill="#00d2ff" stroke="rgba(0,0,0,.45)" stroke-width="1.5" />
          </g>
        </svg>
      `;

      const marker = new maplibregl.Marker({ element: markerEl, rotationAlignment: 'map' })
        .setLngLat(coords[0] as [number, number])
        .addTo(this.map);

      // distancias acumuladas para animación
      const acc: number[] = [0];
      for (let i = 1; i < coords.length; i++) acc[i] = acc[i - 1] + this.haversine(coords[i - 1], coords[i]);
      const total = Math.max(acc[acc.length - 1], 1);

      let t0 = performance.now();
      const DURATION_MS = Math.min(90_000, Math.max(10_000, total * 15)); // escala por longitud

      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / DURATION_MS);
        const d = p * total;

        // localizar tramo
        let i = 0;
        while (i < acc.length - 1 && acc[i + 1] < d) i++;

        const segLen = acc[i + 1] - acc[i];
        const r = segLen > 0 ? (d - acc[i]) / segLen : 0;

        const a = coords[i] as [number, number];
        const b = (coords[i + 1] || coords[i]) as [number, number];
        const lng = a[0] + (b[0] - a[0]) * r;
        const lat = a[1] + (b[1] - a[1]) * r;

        marker.setLngLat([lng, lat]);

        if (p < 1) this.animReq = requestAnimationFrame(step);
      };

      // ajustar cámara a toda la ruta
      const bounds = new maplibregl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number]);
      for (const c of coords) bounds.extend(c as [number, number]);
      this.map.fitBounds(bounds, { padding: 40, duration: 800 });

      this.animReq = requestAnimationFrame(step);
    });
  }

  ngOnDestroy() {
    if (this.animReq) cancelAnimationFrame(this.animReq);
    this.map?.remove();
  }

  // === helpers geodésicos ===
  private haversine(a: Position, b: Position): number {
    const R = 6371000;
    const dLat = (b[1] - a[1]) * Math.PI / 180;
    const dLng = (b[0] - a[0]) * Math.PI / 180;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
    const t = s1 * s1 + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(t)));
  }
}
