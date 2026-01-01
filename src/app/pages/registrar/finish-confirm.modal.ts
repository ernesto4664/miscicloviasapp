import { Component, inject, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonHeader, IonToolbar, IonTitle, IonButtons, IonButton,
  IonContent, IonIcon
} from '@ionic/angular/standalone';
import { ModalController } from '@ionic/angular';

@Component({
  standalone: true,
  selector: 'app-finish-confirm',
  imports: [CommonModule, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonIcon],
  template: `
  <ion-header translucent>
    <ion-toolbar color="primary">
      <ion-title>Finalizar recorrido</ion-title>
      <ion-buttons slot="end">
        <ion-button (click)="close('cancel')" fill="clear">Cerrar</ion-button>
      </ion-buttons>
    </ion-toolbar>
  </ion-header>

  <ion-content [fullscreen]="true">
    <div class="wrap">
      <div class="summary">
        <div class="row"><ion-icon name="time-outline"></ion-icon><b>Duración:</b><span>{{ duration }}</span></div>
        <div class="row"><ion-icon name="swap-vertical-outline"></ion-icon><b>Distancia:</b><span>{{ distanceKm | number:'1.2-2' }} km</span></div>
        <div class="row"><ion-icon name="speedometer-outline"></ion-icon><b>Velocidad media:</b><span>{{ avgSpeedKmh | number:'1.1-1' }} km/h</span></div>
      </div>

      <div class="question">
        ¿Deseas <b>guardar</b> o <b>descartar</b> esta actividad?
      </div>

      <div class="actions">
        <ion-button expand="block" color="medium" (click)="close('discard')">Descartar</ion-button>
        <ion-button expand="block" color="success" (click)="close('save')">Guardar actividad</ion-button>
      </div>
    </div>
  </ion-content>
  `,
  styles: [`
    .wrap{ display:grid; gap:16px; }
    .summary{ background: var(--ion-color-light, #f4f5f8); border-radius:12px; padding:12px; }
    .row{ display:grid; grid-template-columns: 22px auto 1fr; align-items:center; gap:8px; padding:6px 0; }
    .row ion-icon{ opacity:.75; }
    .row b{ font-weight:600; }
    .row + .row{ border-top: 1px solid rgba(0,0,0,.06); }
    .question{ text-align:left; line-height:1.4; }
    .actions{ display:grid; gap:10px; }
  `]
})
export class FinishConfirmModal {
  private modal = inject(ModalController);

  @Input() duration = '00:00:00';
  @Input() distanceKm = 0;
  @Input() avgSpeedKmh = 0;

  close(role: 'cancel'|'discard'|'save') {
    const payload = { save: role === 'save' };
    this.modal.dismiss(payload, role);
  }
}
