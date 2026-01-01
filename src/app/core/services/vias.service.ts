import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ViasService {
  private API = environment.apiUrl;

  /** GeoJSON con la base de vías (calles/avenidas/autopistas). */
  async getBase(): Promise<any> {
    const url = `${this.API}/vias/base`;
    console.log('[ViasService] GET', url);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Vías HTTP ${res.status}`);
    return res.json();
  }
}
