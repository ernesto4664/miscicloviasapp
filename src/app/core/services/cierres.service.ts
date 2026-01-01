import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';

export type CierreStatus = 'active' | 'resolved' | 'cancelled';

export interface Cierre {
  id: number;
  titulo: string;
  motivo?: string;
  desde: string;              // ISO
  hasta: string;              // ISO
  target: 'ciclovia' | 'via'; // << mismo nombre que en el admin
  feature_id?: number;
  feature_label?: string;
  geometry?: any;             // GeoJSON
  status: CierreStatus;
  activo: boolean;            // derivado por el backend
}

@Injectable({ providedIn: 'root' })
export class CierresService {
  private http = inject(HttpClient);
  private baseUrl = environment.apiUrl; // ej: http://localhost:8000

  /**
   * Devuelve SOLO cierres activos para el target indicado,
   * usando el mismo contrato que el front administrativo.
   */
  getCierresActivos(target: 'ciclovia' | 'via'): Observable<Cierre[]> {
    const params = new HttpParams()
      .set('target', target)
      .set('only_active', 'true');

    return this.http
      .get<Cierre[]>(`${this.baseUrl}/cierres`, { params })
      .pipe(
        // Defensa adicional por si el backend no filtró algo:
        map(items =>
          (Array.isArray(items) ? items : []).filter(c => {
            const esActivo = c.activo === true || c.status === 'active';
            // ventanas de tiempo (por si viniera algo raro)
            const now = Date.now();
            const desdeOk = !c.desde || Date.parse(c.desde) <= now;
            const hastaOk = !c.hasta || Date.parse(c.hasta) >= now;
            return esActivo && desdeOk && hastaOk && c.target === target;
          })
        )
      );
  }
}
