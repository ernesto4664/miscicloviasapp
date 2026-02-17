import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map, shareReplay } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export type CierreStatus = 'active' | 'resolved' | 'cancelled';

export interface Cierre {
  id: number;
  titulo: string;
  motivo?: string;
  desde: string;
  hasta: string;
  target: 'ciclovia' | 'via';
  feature_id?: number;
  feature_label?: string;
  geometry?: any;
  status: CierreStatus;
  activo: boolean;
}

@Injectable({ providedIn: 'root' })
export class CierresService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiUrl;

  private cache = new Map<string, Observable<Cierre[]>>();

  getCierresActivos(target: 'ciclovia' | 'via'): Observable<Cierre[]> {
    const key = `activos:${target}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const params = new HttpParams().set('target', target).set('only_active', 'true');

    const req$ = this.http.get<Cierre[]>(`${this.baseUrl}/cierres`, { params }).pipe(
      map(items =>
        (Array.isArray(items) ? items : []).filter(c => {
          const esActivo = c.activo === true || c.status === 'active';
          const now = Date.now();
          const desdeOk = !c.desde || Date.parse(c.desde) <= now;
          const hastaOk = !c.hasta || Date.parse(c.hasta) >= now;
          return esActivo && desdeOk && hastaOk && c.target === target;
        })
      ),
      // cachea la misma respuesta si se suscriben 2 veces casi juntas
      shareReplay({ bufferSize: 1, refCount: true, windowTime: 3000 })
    );

    this.cache.set(key, req$);
    // limpia el cache después de 3s para que el poll sí refresque
    setTimeout(() => this.cache.delete(key), 3000);

    return req$;
  }
}
