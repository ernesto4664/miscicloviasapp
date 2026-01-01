import { Injectable } from '@angular/core';
import {
  HttpEvent, HttpHandler, HttpInterceptor, HttpRequest, HTTP_INTERCEPTORS
} from '@angular/common/http';
import { Observable } from 'rxjs';

const STORAGE_KEYS = { TOKEN: 'mc_token' };

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    const token = localStorage.getItem(STORAGE_KEYS.TOKEN);

    // No inyectar token en llamadas a Firebase ni en preflight OPTIONS
    const isFirebase = req.url.includes('googleapis.com') || req.url.includes('firebaseio.com');
    if (token && !isFirebase && req.method !== 'OPTIONS') {
      const authReq = req.clone({
        setHeaders: { Authorization: `Bearer ${token}` }
      });
      return next.handle(authReq);
    }

    return next.handle(req);
  }
}

export const AuthInterceptorProvider = {
  provide: HTTP_INTERCEPTORS,
  useClass: AuthInterceptor,
  multi: true
};
