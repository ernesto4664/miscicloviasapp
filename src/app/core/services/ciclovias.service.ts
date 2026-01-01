import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

export type GeoJsonFC = { type: 'FeatureCollection'; features: any[] };

@Injectable({ providedIn: 'root' })
export class CicloviasService {
  private API = environment.apiUrl; // p.ej. http://localhost:8000/api/v1

  /** GeoJSON con la base de ciclovías. */
  async getBase(): Promise<GeoJsonFC> {
    const url = `${this.API}/map/ciclovias`;
    console.log('[CicloviasService] GET', url);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Ciclovías HTTP ${res.status}`);
    return res.json() as Promise<GeoJsonFC>;
  }
}
