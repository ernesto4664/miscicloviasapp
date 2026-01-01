// src/app/core/auth/register.page.ts
import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  IonContent, IonHeader, IonTitle, IonToolbar,
  IonItem, IonLabel, IonInput, IonButton, IonList, IonText, IonSpinner
} from '@ionic/angular/standalone';
import { AuthService } from '../services/auth.service';
import { CommonModule } from '@angular/common';

@Component({
  standalone: true,
  selector: 'app-register',
  imports: [
    CommonModule, ReactiveFormsModule, RouterLink,
    IonContent, IonHeader, IonTitle, IonToolbar,
    IonItem, IonLabel, IonInput, IonButton, IonList, IonText, IonSpinner
  ],
  template: `
<ion-header>
  <ion-toolbar><ion-title>Crear cuenta</ion-title></ion-toolbar>
</ion-header>

<ion-content class="ion-padding">
  <form [formGroup]="form" (ngSubmit)="onSubmit()">
    <ion-list>
      <ion-item>
        <ion-label position="stacked">Email</ion-label>
        <ion-input type="email" formControlName="email"></ion-input>
      </ion-item>
      <ion-item>
        <ion-label position="stacked">Contraseña</ion-label>
        <ion-input type="password" formControlName="password"></ion-input>
      </ion-item>
    </ion-list>

    <div class="actions">
      <ion-button expand="block" type="submit" [disabled]="form.invalid || loading">
        <ng-container *ngIf="!loading; else spin">Registrarme</ng-container>
      </ion-button>
      <ng-template #spin><ion-spinner name="dots"></ion-spinner></ng-template>

      <ion-text>
        <a routerLink="/login">¿Ya tienes cuenta? Inicia sesión</a>
      </ion-text>
    </div>
  </form>

  <ion-text color="danger" *ngIf="error" class="mt-2">{{ error }}</ion-text>
</ion-content>
  `,
  styles: [`.actions{margin-top:16px;display:grid;gap:12px}.mt-2{margin-top:8px;display:block}`]
})
export class RegisterPage {
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
      await this.auth.register(email!, password!);
      this.router.navigateByUrl('/tabs/home', { replaceUrl: true });
    } catch (e: any) {
      this.error = e?.message || 'No se pudo registrar';
    } finally { this.loading = false; }
  }
}
