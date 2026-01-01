import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

export interface Recorrido {
  id: number | string;
  titulo: string;
  fecha?: string;             // ISO
  distancia_km?: number;      // 25.1
  desnivel_m?: number;        // 159
  mini_mapa_url?: string;     // imagen/thumbnail
}

const API = environment.apiUrl;
const PLACEHOLDER_RIDE = 'assets/placeholder-ride.jpg';

@Injectable({ providedIn: 'root' })
export class MisRecorridosService {

  private token(): string | null {
    try { return localStorage.getItem('mc_token'); } catch { return null; }
  }

  private async _fetch<T>(url: string): Promise<T> {
    const h: Record<string,string> = { 'Accept': 'application/json' };
    const t = this.token();
    if (t) h['Authorization'] = `Bearer ${t}`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(()=> '')}`);
    return res.json() as Promise<T>;
  }

  private abs(url?: string, fallback = PLACEHOLDER_RIDE) {
    if (!url) return fallback;
    try { return new URL(url).toString(); }
    catch {
      if (url.startsWith('assets/')) return url;
      if (url.startsWith('/')) return new URL(url, API).toString();
      return new URL('/' + url, API).toString();
    }
  }

  private map(r: any): Recorrido & { cover: string } {
    return {
      id: r.id ?? '',
      titulo: r.titulo ?? r.nombre ?? 'Recorrido',
      fecha: r.fecha ?? r.iniciado_en ?? r.created_at,
      distancia_km: Number(r.distancia_km ?? r.distancia) || undefined,
      desnivel_m: Number(r.desnivel_m ?? r.elevacion) || undefined,
      mini_mapa_url: r.mini_mapa_url ?? r.thumbnail_url,
      cover: this.abs(r.mini_mapa_url ?? r.thumbnail_url)
    };
  }

  /** Últimos del usuario autenticado (para el Home) */
  async getUltimosDelUsuario(limit = 10): Promise<(Recorrido & { cover: string })[]> {
    // adapta a tu API real:
    // /recorridos/mios?limit=10&sort=-fecha
    const url = `${API}/recorridos/mios?limit=${limit}&sort=-fecha`;
    const raw = await this._fetch<any>(url);
    const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
    return list.map((x: any) => this.map(x));
  }
}
