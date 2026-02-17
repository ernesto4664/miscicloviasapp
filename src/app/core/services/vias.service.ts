import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, defer, throwError } from 'rxjs';
import { catchError, shareReplay, tap } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ViasService {
  private http = inject(HttpClient);
  private API = environment.apiUrl;

  private base$?: Observable<any>;

  /** GeoJSON con la base de vías (cacheado). */
  getBase$(): Observable<any> {
    if (!this.base$) {
      const url = `${this.API}/vias/base`;

      this.base$ = defer(() => {
        console.log('[ViasService] GET', url);
        return this.http.get<any>(url, {
          headers: { Accept: 'application/json' },
        });
      }).pipe(
        tap(fc => console.log('[ViasService] OK features:', fc?.features?.length ?? 0)),
        shareReplay({ bufferSize: 1, refCount: true }),
        catchError(err => {
          console.error('[ViasService] ERROR', err);
          this.base$ = undefined;
          return throwError(() => err);
        })
      );
    }
    return this.base$;
  }

  refreshBase(): void {
    this.base$ = undefined;
  }
}
