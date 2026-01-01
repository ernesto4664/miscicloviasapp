// src/app/core/services/activities.api.ts
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { environment } from '../../../environments/environment';

export interface StartOut { id: number; started_at: string; }
export interface PointIn {
  ts: number; lat: number; lng: number;
  accuracy_m?: number; speed_mps?: number;
}
export interface FinishIn {
  elapsed_ms: number; distance_m: number; avg_speed_kmh: number; save: boolean;
}

/** GeoJSON LineString minimal */
export type LngLat = [number, number];                  // [lng, lat]
export interface GeoLineString { type: 'LineString'; coordinates: LngLat[]; }
export interface GeoFeatureLine {
  type: 'Feature';
  geometry: GeoLineString;
  properties?: Record<string, any>;
}

@Injectable({ providedIn: 'root' })
export class ActivitiesApi {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private base = `${environment.apiUrl}/api/v1/activities`;

  private headers() {
    const token = this.auth.getToken();
    return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  }
  private canCall(): boolean {
    return !!this.auth.getToken() && !!environment.apiUrl;
  }

  async start(): Promise<StartOut | null> {
    if (!this.canCall()) return null;
    return await firstValueFrom(this.http.post<StartOut>(`${this.base}/start`, {}, this.headers()));
  }
  async pushPoints(activityId: number, batch: PointIn[]): Promise<void> {
    if (!this.canCall() || !batch.length) return;
    await firstValueFrom(this.http.post<void>(`${this.base}/${activityId}/points/batch`, batch, this.headers()));
  }
  async pause(activityId: number): Promise<void> {
    if (!this.canCall()) return;
    await firstValueFrom(this.http.post<void>(`${this.base}/${activityId}/pause`, {}, this.headers()));
  }
  async resume(activityId: number): Promise<void> {
    if (!this.canCall()) return;
    await firstValueFrom(this.http.post<void>(`${this.base}/${activityId}/resume`, {}, this.headers()));
  }
  async finish(activityId: number, payload: FinishIn): Promise<void> {
    if (!this.canCall()) return;
    await firstValueFrom(this.http.post(`${this.base}/${activityId}/finish`, payload, this.headers()));
  }

  /** NUEVO: map-matching; save=true para que persista en DB si tu backend lo permite */
  async mapmatch(activityId: number, save = true): Promise<GeoFeatureLine | null> {
    if (!this.canCall()) return null;
    return await firstValueFrom(
      this.http.post<GeoFeatureLine>(`${this.base}/${activityId}/mapmatch?save=${save}`, {}, this.headers())
    );
  }
}
