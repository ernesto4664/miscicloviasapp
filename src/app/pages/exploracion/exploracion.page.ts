import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonContent, IonHeader, IonTitle, IonToolbar, IonButtons, IonMenuButton } from '@ionic/angular/standalone';
import { MapaCicloviasComponent } from './mapa-ciclovias.component';

@Component({
  selector: 'app-exploracion',
  templateUrl: './exploracion.page.html',
  styleUrls: ['./exploracion.page.scss'],
  standalone: true,
  imports: [CommonModule, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar, IonMenuButton, MapaCicloviasComponent]
})
export class ExploracionPage {}
