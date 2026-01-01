import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

export interface Noticia {
  id: number | string;
  titulo: string;
  resumen?: string;
  contenido?: string;
  portada_url?: string;
  imagen_url?: string;
  publicado_en?: string;
  fecha?: string;
  autor?: string;
  slug?: string;
}

// API completa (ej. http://127.0.0.1:8000/api/v1)
const API = environment.apiUrl;

// ORIGEN (ej. http://127.0.0.1:8000) para armar /uploads/...
const API_ORIGIN = (() => {
  try { return new URL(API).origin; }
  catch {
    // fallback: quita /api... si estuviera
    return API.replace(/\/api.*$/, '');
  }
})();

// Placeholder inline para evitar 404 y loops
const NEWS_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
    <svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'>
      <rect width='100%' height='100%' fill='#eef1f4'/>
      <g fill='#c2c8d0'><rect x='100' y='120' width='1000' height='560' rx='16'/></g>
      <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
        font-family='Arial, sans-serif' font-size='28' fill='#8a94a6'>Sin imagen</text>
    </svg>`);

@Injectable({ providedIn: 'root' })
export class NoticiasService {
  private token(): string | null {
    try { return localStorage.getItem('mc_token'); } catch { return null; }
  }

  private async _fetch<T>(url: string): Promise<T> {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    const t = this.token(); if (t) headers['Authorization'] = `Bearer ${t}`;

    console.log('[NoticiasService] GET', url);
    const res = await fetch(url, { headers });
    const text = await res.text();

    if (!res.ok) {
      console.error('[NoticiasService] HTTP', res.status, text);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    try {
      const json = JSON.parse(text);
      console.log('[NoticiasService] payload crudo:', json);
      return json as T;
    } catch {
      console.log('[NoticiasService] payload texto:', text);
      // @ts-ignore
      return text as T;
    }
  }

  /** Convierte ruta en absoluta según host del API */
  private toAbsolute(url?: string): string {
    if (!url) return NEWS_PLACEHOLDER;

    // Absoluta → OK
    try { return new URL(url).toString(); } catch { /* continua */ }

    // assets locales
    if (url.startsWith('assets/')) return url;

    // /uploads/... o cualquier ruta absoluta del backend
    if (url.startsWith('/')) return API_ORIGIN + url;

    // uploads/... (sin slash)
    return API_ORIGIN + '/' + url;
  }

  /** Adapta el objeto de tu API a lo que consume la UI */
  private map(n: any): Noticia & { cover: string; publishedAt: string | null } {
    // imagen puede venir con distintos nombres
    const rawImg =
      n.portada_url ?? n.imagen_url ?? n.image_url ?? n.cover_url ?? n.cover ?? null;

    // fecha publicada: varios posibles campos
    const rawFecha =
      n.publicado_en ?? n.fecha ?? n.created_at ?? n.updated_at ?? null;

    const mapped = {
      id: n.id ?? n.slug ?? '',
      titulo: n.titulo ?? '',
      resumen: n.resumen,
      contenido: n.cuerpo ?? n.contenido, // tu backend usa 'cuerpo'
      portada_url: n.portada_url,
      imagen_url: n.imagen_url,
      publicado_en: n.publicado_en,
      fecha: n.fecha,
      autor: n.autor,
      slug: n.slug,
      cover: this.toAbsolute(rawImg),
      publishedAt: rawFecha
    };

    console.log('[NoticiasService] noticia mapeada:', mapped);
    return mapped;
  }

  /** Últimas N para el Home (carrusel) */
  async getUltimas(limit = 10) {
    const url = `${API}/noticias?limit=${limit}&sort=-publicado_en`;
    const r = await this._fetch<any>(url);
    const list = Array.isArray(r) ? r : (r?.data ?? []);
    const mapped = list.map((x: any) => this.map(x));
    console.log('[NoticiasService] ultimas (mapeadas):', mapped);
    return mapped;
  }

  /** Paginado para listado */
  async getListado(page = 1, perPage = 15) {
    const url = `${API}/noticias?page=${page}&per_page=${perPage}&sort=-publicado_en`;
    const r = await this._fetch<any>(url);
    if (r?.data && r?.meta) {
      const data = r.data.map((x: any) => this.map(x));
      const pag = {
        data,
        page: r.meta.current_page ?? page,
        perPage: r.meta.per_page ?? perPage,
        total: r.meta.total ?? r.data.length,
        lastPage: r.meta.last_page ?? 1
      };
      console.log('[NoticiasService] listado (mapeado):', pag);
      return pag;
    }
    const arr = (r?.data ?? r ?? []) as any[];
    const pag = { data: arr.map((x:any)=>this.map(x)), page, perPage, total: arr.length, lastPage: 1 };
    console.log('[NoticiasService] listado (array simple):', pag);
    return pag;
  }

  /** Detalle */
  async getById(idOrSlug: string | number) {
    const url = `${API}/noticias/${idOrSlug}`;
    const r = await this._fetch<any>(url);
    const mapped = this.map(r?.data ?? r);
    console.log('[NoticiasService] detalle (mapeado):', mapped);
    return mapped;
  }
}
 