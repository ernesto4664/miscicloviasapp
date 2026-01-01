import { Component, OnInit, OnDestroy, AfterViewInit, inject, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as L from 'leaflet';
import { forkJoin, from, fromEvent, of, Subscription, timer } from 'rxjs';
import { catchError, mapTo, switchMap, tap } from 'rxjs/operators';
import { CicloviasService, GeoJsonFC } from '../../core/services/ciclovias.service';
import { CierresService, Cierre } from '../../core/services/cierres.service';
import { ViasService } from '../../core/services/vias.service';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';


// Fix iconos Leaflet (rutas desde assets/)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'assets/leaflet/marker-icon-2x.png',
  iconUrl:       'assets/leaflet/marker-icon.png',
  shadowUrl:     'assets/leaflet/marker-shadow.png',
});

@Component({
  standalone: true,
  selector: 'app-mapa-ciclovias',
  imports: [CommonModule],
  template: `
    <div class="map-wrap">
      <div #mapEl id="map"></div>
      <button class="locate" (click)="centerOnUser()" title="Mi ubicación">◎</button>
      <div class="legend">
        <b>Leyenda</b>
        <div><span class="swatch" style="background:#2e7d32"></span> Ciclovías disponibles</div>
        <div><span class="swatch" style="background:#d32f2f"></span> Cierres ciclovías</div>
        <div><span class="swatch" style="background:#ff6f00"></span> Cierres vías</div>
      </div>
    </div>
  `,
  styles: [`
    :host{display:block}
    .map-wrap{position:relative;height:calc(100dvh - 150px);min-height:420px;padding:10px}
    #map{height:100%;width:100%;border-radius:14px;background:#f4f5f7;box-shadow:0 2px 10px rgba(0,0,0,.08)}
    .legend{position:absolute;right:14px;bottom:14px;background:#fff;padding:.6rem .8rem;border-radius:.6rem;box-shadow:0 1px 3px rgba(0,0,0,.18);font-size:.9rem;z-index:1000}
    .legend b{display:block;margin-bottom:.35rem}
    .legend .swatch{display:inline-block;width:18px;height:4px;margin-right:.5rem;border-radius:2px;vertical-align:middle}
    .locate{position:absolute;left:14px;bottom:14px;border:none;background:#fff;border-radius:999px;width:44px;height:44px;box-shadow:0 1px 3px rgba(0,0,0,.25);font-size:20px;z-index:1000}
  `]
})
export class MapaCicloviasComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;

  private cicSrv  = inject(CicloviasService);
  private cierSrv = inject(CierresService);
  private viasSrv = inject(ViasService);

  private map!: L.Map;
  private baseCic?: L.GeoJSON<any>;
  private baseVias?: L.GeoJSON<any>;
  private overlayCic?: L.LayerGroup;
  private overlayVias?: L.LayerGroup;

  // sets con los IDs cerrados (string para fácil comparación)
  private closedCicIds = new Set<string>();
  private closedViaIds = new Set<string>();

  private ro?: ResizeObserver;
  private resizeSub?: Subscription;
  private pollSub?: Subscription;

  ngOnInit() {}

  ngAfterViewInit() {
    this.initMap();
    setTimeout(() => this.map.invalidateSize(true), 0);

    if ('ResizeObserver' in window) {
      this.ro = new ResizeObserver(() => this.map.invalidateSize({ debounceMoveend: true } as any));
      this.ro.observe(this.mapEl.nativeElement);
    } else {
      this.resizeSub = fromEvent(window, 'resize').subscribe(() => this.map.invalidateSize());
    }

    this.centerOnUser();
    this.loadBases();

    // 🔁 refresco automático: arranca inmediato y luego cada 10s
    this.pollSub = timer(0, 10000).pipe(
      switchMap(() => this.refreshCierres())
    ).subscribe();
  }

  ngOnDestroy() {
    this.ro?.disconnect();
    this.resizeSub?.unsubscribe();
    this.pollSub?.unsubscribe();
    this.map?.remove();
  }

  private initMap() {
    this.map = L.map(this.mapEl.nativeElement, {
      center: L.latLng(-33.45, -70.66),
      zoom: 12,
      renderer: L.canvas({ padding: 0.5 })
    });

    this.map.createPane('base');          this.map.getPane('base')!.style.zIndex = '400';
    this.map.createPane('base-vias');     this.map.getPane('base-vias')!.style.zIndex = '500';
    this.map.createPane('closures-vias'); this.map.getPane('closures-vias')!.style.zIndex = '640';
    this.map.createPane('closures');      this.map.getPane('closures')!.style.zIndex = '650';

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(this.map);
  }

  async centerOnUser() {
    try {
      if (Capacitor.isNativePlatform()) {
        const perm = await Geolocation.checkPermissions();
        if (perm.location !== 'granted') await Geolocation.requestPermissions();
      }
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
      const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
      this.map.setView(ll, 14, { animate: true });
      L.marker(ll).addTo(this.map);
    } catch {/* noop */}
  }

    private loadBases() {
    const cic$  = from(this.cicSrv.getBase()).pipe(
        tap((fc: GeoJsonFC) => this.renderBaseCiclovias(fc)),
        mapTo(true),
        catchError(e => { console.error('[Mapa] base ciclovías', e); return of(false); })
    );

    const vias$ = from(this.viasSrv.getBase()).pipe(
        tap((fc: any) => this.renderBaseVias(fc)),
        mapTo(true),
        catchError(e => { console.error('[Mapa] base vías', e); return of(false); })
    );

    forkJoin([cic$, vias$]).subscribe(([okCic, okVias]) => {
        if (okCic && okVias) this.refreshCierres().subscribe();
    });
    }

  private renderBaseCiclovias(fc: GeoJsonFC) {
    this.baseCic?.remove();
    this.baseCic = L.geoJSON(fc as any, {
      pane: 'base',
      style: (f:any) => this.styleCiclovia(f),
      onEachFeature: (f:any, layer:any) => {
        const p = f.properties ?? {};
        const title = p.EJE_VIA ?? p.NOM_PROYECTO ?? 'Ciclovía';
        const comuna = p.COMUNA ? `<br><small>${p.COMUNA}</small>` : '';
        layer.bindPopup(`<b>${title}</b>${comuna}`);
      }
    }).addTo(this.map);

    const b = this.baseCic.getBounds();
    if (b.isValid()) this.map.fitBounds(b, { padding: [20,20] });
  }

  private renderBaseVias(fc: any) {
    this.baseVias?.remove();
    this.baseVias = L.geoJSON(fc as any, {
      pane: 'base-vias',
      style: (f:any) => {
        const fid = String(f.properties?.osm_id ?? f.properties?.id ?? f.id ?? '');
        const closed = fid && this.closedViaIds.has(fid);
        return { color: '#ff6f00', weight: closed ? 6 : 0, opacity: closed ? 0.95 : 0 };
      }
    }).addTo(this.map);
  }

  private styleCiclovia(f:any): L.PathOptions {
    const fid = String(f.properties?.id ?? f.properties?.OBJECTID ?? f.id ?? '');
    const closed = fid && this.closedCicIds.has(fid);
    return { color: closed ? '#d32f2f' : '#2e7d32', weight: closed ? 5 : 4, opacity: 1 };
  }

  /** Trae cierres activos (target: ciclovia/via), re-estila y pinta overlays. */
  private refreshCierres() {
    return forkJoin([
      // CICLOVÍAS
      this.cierSrv.getCierresActivos('ciclovia').pipe(tap((items:Cierre[]) => {
        console.log('[Mapa] cierres ciclovía activos:', items.length);
        // set para estilar base
        this.closedCicIds = new Set(
          items.map(c => String(c.feature_id ?? '')).filter(Boolean)
        );
        // reestilo base
        this.baseCic?.eachLayer((l:any) => {
          const f = l?.feature; if (f) (l as L.Path).setStyle(this.styleCiclovia(f));
        });
        // overlay punteado
        this.overlayCic?.remove();
        this.overlayCic = this.drawOverlay(items, 'closures', '#d32f2f');
      })),

      // VÍAS
      this.cierSrv.getCierresActivos('via').pipe(tap((items:Cierre[]) => {
        console.log('[Mapa] cierres vías activos:', items.length);
        this.closedViaIds = new Set(
          items.map(c => String(c.feature_id ?? '')).filter(Boolean)
        );
        // reestilo base
        this.baseVias?.eachLayer((l:any) => {
          const f = l?.feature; if (!f) return;
          const fid = String(f.properties?.osm_id ?? f.properties?.id ?? f.id ?? '');
          const closed = fid && this.closedViaIds.has(fid);
          (l as L.Path).setStyle({ color:'#ff6f00', weight: closed ? 6 : 0, opacity: closed ? 0.95 : 0 });
        });
        // overlay punteado
        this.overlayVias?.remove();
        this.overlayVias = this.drawOverlay(items, 'closures-vias', '#ff6f00');
      }))
    ]).pipe(mapTo(void 0));
  }

  private drawOverlay(items: Cierre[], pane: string, color: string) {
    const group = L.layerGroup();
    for (const c of items) {
      if (!c.geometry) continue;
      L.geoJSON(c.geometry as any, {
        pane,
        style: { color, weight: 6, opacity: 0.95, dashArray: '4,4' }
      }).addTo(group);
    }
    return group.addTo(this.map);
  }
}
