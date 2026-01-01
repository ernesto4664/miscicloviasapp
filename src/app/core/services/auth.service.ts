// src/app/core/services/auth.service.ts
import { Injectable, inject, signal, computed } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { environment } from '../../../environments/environment';

import {
  Auth, User, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signInWithPopup, signInWithRedirect, GoogleAuthProvider, signOut
} from '@angular/fire/auth';

// Web SDK directo para eventos/redirect
import { getRedirectResult, onAuthStateChanged } from 'firebase/auth';

import { Firestore } from '@angular/fire/firestore';

const STORAGE_KEYS = { TOKEN: 'mc_token', ROLES: 'mc_roles', USER: 'mc_user' };

type BasicProfile = { name: string; email: string; avatar?: string };

@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(Auth);
  private db = inject(Firestore); // reservado si luego lees perfiles/roles desde Firestore

  private apiUrl = environment.apiUrl;

  // ====== Estado REACTIVO (signals) ======
  readonly isLoggedInSig = signal<boolean>(false);
  readonly rolesSig = signal<string[]>([]);
  readonly userSig = signal<BasicProfile | null>(null);

  /** ¿Tiene rol de administración? (admin/editor/corresponsal) */
  readonly hasAnyAdminRoleSig = computed(() =>
    this.rolesSig().some(r => ['admin', 'editor', 'corresponsal'].includes(r))
  );

  constructor() {
    // 1) Cargar estado persistido (pinta UI rápido)
    this.restoreSignalsFromStorage();

    // 2) Sincronizar con Firebase (estado real, puede llegar ms tarde)
    onAuthStateChanged(this.auth, async (fbUser) => {
      try {
        const hasLocalToken = !!localStorage.getItem(STORAGE_KEYS.TOKEN);

        if (fbUser) {
          // Si Firebase confirma sesión pero no tenemos token local, completar flujo
          if (!hasLocalToken) {
            await this.finishLoginFromFirebaseUser(fbUser);
          } else {
            // Tenemos ambos: refrescar signals desde storage por si cambiaron roles
            this.restoreSignalsFromStorage();
          }
        } else {
          // Firebase dice "no logueado": limpia si aún había token local
          if (hasLocalToken) this.clearSession();
        }
      } catch {
        // No rompas la app por un error de sincronización
      }
    });
  }

  // ---- Helpers legacy (compatibilidad con código existente) ----
  isLoggedIn(): boolean { return this.isLoggedInSig(); }

  userRoles(): string[] {
    // Prioriza signal (reactivo); si está vacío, cae a storage
    const rolesFromSig = this.rolesSig();
    if (rolesFromSig?.length) return rolesFromSig;

    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.ROLES) || '[]'); }
    catch { return []; }
  }

  getToken(): string | null {
  // mismo key que ya usas para guardar el token
  return localStorage.getItem('mc_token');
  }

  hasAnyAdminRole(): boolean {
    const roles = this.userRoles().map(r => String(r).toLowerCase());
    return roles.some(r => ['admin', 'editor', 'corresponsal'].includes(r));
  }

  getUser(): BasicProfile | null {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.USER) || 'null'); }
    catch { return null; }
  }

  /** Útil si seteas roles desde tu backend post-login */
  setRoles(roles: string[]) {
    const norm = (roles || []).map(r => String(r).toLowerCase());
    localStorage.setItem(STORAGE_KEYS.ROLES, JSON.stringify(norm));
    this.rolesSig.set(norm);
  }

  clearSession() {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.ROLES);
    localStorage.removeItem(STORAGE_KEYS.USER);
    Preferences.remove({ key: STORAGE_KEYS.TOKEN }).catch(() => {});

    this.isLoggedInSig.set(false);
    this.rolesSig.set([]);
    this.userSig.set(null);
  }

  private setSession(token: string, roles: string[], user: BasicProfile) {
    const normRoles = (roles || []).map(r => String(r).toLowerCase());

    localStorage.setItem(STORAGE_KEYS.TOKEN, token);
    localStorage.setItem(STORAGE_KEYS.ROLES, JSON.stringify(normRoles));
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
    Preferences.set({ key: STORAGE_KEYS.TOKEN, value: token }).catch(() => {});

    this.isLoggedInSig.set(true);
    this.rolesSig.set(normRoles);
    this.userSig.set(user);
  }

  private restoreSignalsFromStorage() {
    const token = localStorage.getItem(STORAGE_KEYS.TOKEN);
    const roles = (() => {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.ROLES) || '[]'); }
      catch { return []; }
    })().map((r: string) => String(r).toLowerCase());

    const user  = this.getUser();

    this.isLoggedInSig.set(!!token);
    this.rolesSig.set(roles);
    this.userSig.set(user);
  }

  // ---- Email/Password ----
  async login(email: string, password: string) {
    const cred = await signInWithEmailAndPassword(this.auth, email, password);
    await this.finishLoginFromFirebaseUser(cred.user);
  }

  async register(email: string, password: string) {
    const cred = await createUserWithEmailAndPassword(this.auth, email, password);
    await this.finishLoginFromFirebaseUser(cred.user);
  }

  async sendReset(email: string) {
    await sendPasswordResetEmail(this.auth, email);
  }

  // ---- Google ----
  async googleLogin() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    if (Capacitor.isNativePlatform()) {
      await signInWithRedirect(this.auth, provider);
    } else {
      const res = await signInWithPopup(this.auth, provider);
      await this.finishLoginFromFirebaseUser(res.user);
    }
  }

  async resolveRedirectLoginIfNeeded() {
    const res = await getRedirectResult(this.auth);
    if (res?.user) await this.finishLoginFromFirebaseUser(res.user);
  }

  async logout() {
    await signOut(this.auth).catch(() => {});
    this.clearSession();
  }

  // ---- Backend exchange ----
  private async exchangeFirebaseToken(user: User) {
    // Si no usas backend, devolvemos idToken y lo que haya guardado localmente
    if (!environment.useBackendExchange) {
      return {
        token: await user.getIdToken(),
        roles: this.userRoles(), // lo que haya en local por ahora
        user: {
          name: user.displayName || '',
          email: user.email || '',
          avatar: user.photoURL || ''
        } as BasicProfile
      };
    }

    const idToken = await user.getIdToken(true);
    const res = await fetch(`${this.apiUrl}/auth/firebase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => 'API auth failed');
      throw new Error(msg || 'API auth failed');
    }

    return res.json() as Promise<{ token: string; roles: string[]; user: BasicProfile }>;
  }

  private async finishLoginFromFirebaseUser(user: User) {
    try {
      const { token, roles, user: profile } = await this.exchangeFirebaseToken(user);
      this.setSession(token, roles || [], {
        name: profile?.name || user?.displayName || '',
        email: profile?.email || user?.email || '',
        avatar: profile?.avatar || user?.photoURL || ''
      });
    } catch (e) {
      // Fallback: no bloquees el login si el backend cayó
      const idToken = await user.getIdToken().catch(() => null);
      if (idToken) {
        this.setSession(idToken, this.userRoles(), {
          name: user?.displayName || '',
          email: user?.email || '',
          avatar: user?.photoURL || ''
        });
      } else {
        throw e; // si ni siquiera obtuvimos idToken, propaga el error
      }
    }
  }
}
