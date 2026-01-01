// src/app/core/auth/login.page.ts
import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  IonContent, IonHeader, IonTitle, IonToolbar,
  IonItem, IonLabel, IonInput, IonButton, IonList, IonText, IonSpinner,
  IonCard, IonCardContent
} from '@ionic/angular/standalone';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth.service';

@Component({
  standalone: true,
  selector: 'app-login',
  imports: [
    CommonModule, ReactiveFormsModule, RouterLink,
    IonContent, IonHeader, IonTitle, IonToolbar,
    IonItem, IonLabel, IonInput, IonButton, IonList, IonText, IonSpinner,
    IonCard, IonCardContent
  ],
  template: `
<ion-header>
  <ion-toolbar>
    <ion-title>Iniciar sesión</ion-title>
  </ion-toolbar>
</ion-header>

<ion-content>
  <div class="login-wrap">
    <ion-card class="auth-card">
      <ion-card-content>
        <form [formGroup]="form" (ngSubmit)="onSubmit()">
          <ion-list lines="none">
            <ion-item>
              <ion-label position="stacked">Email</ion-label>
              <ion-input type="email" formControlName="email" autocomplete="email"></ion-input>
            </ion-item>

            <ion-item>
              <ion-label position="stacked">Contraseña</ion-label>
              <ion-input type="password" formControlName="password" autocomplete="current-password"></ion-input>
            </ion-item>
          </ion-list>

          <div class="actions">
            <ion-button expand="block" type="submit" [disabled]="form.invalid || loading">
              <ng-container *ngIf="!loading; else spin">Entrar</ng-container>
            </ion-button>
            <ng-template #spin><ion-spinner name="dots"></ion-spinner></ng-template>

            <!-- quitar outline para que se vea "lleno" -->
            <ion-button expand="block" color="tertiary" (click)="loginGoogle()" [disabled]="loading">
              Continuar con Google
            </ion-button>

            <ion-text color="medium" class="mt-2">
              <a (click)="reset()">¿Olvidaste tu contraseña?</a>
            </ion-text>

            <ion-text class="mt-2">
              <a routerLink="/register">Crear cuenta</a>
            </ion-text>
          </div>

          <ion-text color="danger" *ngIf="error" class="mt-2">{{ error }}</ion-text>
        </form>
      </ion-card-content>
    </ion-card>
  </div>
</ion-content>
  `,
  styles: [`
/* centramos la tarjeta en pantalla y damos respiración */
.login-wrap {
  padding: 16px;
  max-width: 520px;
  margin: 0 auto;
}
.auth-card {
  border-radius: 16px;
  box-shadow: 0 10px 30px rgba(0,0,0,.08);
}
.actions { margin-top: 16px; display: grid; gap: 12px; }
.mt-2 { margin-top: 8px; display:block; }
a { cursor: pointer; }
  `]
})
export class LoginPage {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);

  loading = false;
  error = '';

  form = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  async onSubmit() {
    this.error = ''; this.loading = true;
    try {
      const { email, password } = this.form.getRawValue();
      await this.auth.login(email!, password!);
      this.router.navigateByUrl('/tabs/home', { replaceUrl: true });
    } catch (e: any) {
      this.error = e?.message || 'No se pudo iniciar sesión';
    } finally { this.loading = false; }
  }

  async loginGoogle() {
    this.error = ''; this.loading = true;
    try {
      await this.auth.googleLogin();
      // En web navegamos enseguida
      this.router.navigateByUrl('/tabs/home', { replaceUrl: true });
    } catch (e: any) {
      this.error = e?.message || 'No se pudo iniciar con Google';
    } finally { this.loading = false; }
  }

  async reset() {
    const email = this.form.controls.email.value;
    if (!email) { this.error = 'Ingresa tu email para enviar el enlace de restablecimiento.'; return; }
    this.error = ''; this.loading = true;
    try {
      await this.auth.sendReset(email);
      alert('Te enviamos un correo para restablecer la contraseña.');
    } catch (e: any) {
      this.error = e?.message || 'No se pudo enviar el correo de restablecimiento';
    } finally { this.loading = false; }
  }
}
