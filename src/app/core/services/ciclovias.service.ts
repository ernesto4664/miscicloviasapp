import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, defer, throwError } from 'rxjs';
import { catchError, shareReplay, tap } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export type GeoJsonFC = { type: 'FeatureCollection'; features: any[] };

@Injectable({ providedIn: 'root' })
export class CicloviasService {
  private http = inject(HttpClient);
  private API = environment.apiUrl; // p.ej. http://localhost:8000/api/v1

  private base$?: Observable<GeoJsonFC>;

  /** GeoJSON con la base de ciclovías (cacheado). */
  getBase$(): Observable<GeoJsonFC> {
    if (!this.base$) {
      const url = `${this.API}/map/ciclovias`;

      this.base$ = defer(() => {
        console.log('[CicloviasService] GET', url);
        return this.http.get<GeoJsonFC>(url, {
          headers: { Accept: 'application/json' },
        });
      }).pipe(
        tap(fc => console.log('[CicloviasService] OK features:', fc?.features?.length ?? 0)),
        shareReplay({ bufferSize: 1, refCount: true }),
        catchError(err => {
          console.error('[CicloviasService] ERROR', err);
          // si falló, permite reintentar en el próximo getBase$()
          this.base$ = undefined;
          return throwError(() => err);
        })
      );
    }

    return this.base$;
  }

  /** Fuerza recarga de la base (por si quieres un botón “Actualizar base”). */
  refreshBase(): void {
    this.base$ = undefined;
  }
}
