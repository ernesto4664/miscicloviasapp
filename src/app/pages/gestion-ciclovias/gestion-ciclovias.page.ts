import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonHeader, IonTitle, IonToolbar, IonButtons, IonMenuButton } from '@ionic/angular/standalone';

@Component({
  selector: 'app-gestion-ciclovias',
  templateUrl: './gestion-ciclovias.page.html',
  styleUrls: ['./gestion-ciclovias.page.scss'],
  standalone: true,
  imports: [IonButtons, IonContent, IonHeader, IonTitle, IonToolbar, CommonModule, FormsModule, IonMenuButton]
})
export class GestionCicloviasPage implements OnInit {

  constructor() { }

  ngOnInit() {
  }

}
