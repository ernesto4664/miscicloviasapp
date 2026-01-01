import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import {
  IonContent, IonButton, IonList, IonItem, IonLabel, IonInput, IonTitle
} from '@ionic/angular/standalone';
import { AuthService } from '../services/auth.service';

@Component({
  standalone: true,
  selector: 'app-reset',
  templateUrl: './reset.page.html',
  imports: [CommonModule, FormsModule, RouterModule,
    IonContent, IonButton, IonList, IonItem, IonLabel, IonInput, IonTitle]
})
export class ResetPage {
  private auth = inject(AuthService);
  email = ''; done = false; error = ''; loading = false;

  async send() {
    try {
      this.loading = true; this.error = '';
      await this.auth.sendReset(this.email);
      this.done = true;
    } catch {
      this.error = 'No se pudo enviar el correo';
    } finally {
      this.loading = false;
    }
  }
}
