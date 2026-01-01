import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonHeader, IonTitle, IonToolbar, IonButtons, IonMenuButton } from '@ionic/angular/standalone';

@Component({
  selector: 'app-gestion-calles-avenidas',
  templateUrl: './gestion-calles-avenidas.page.html',
  styleUrls: ['./gestion-calles-avenidas.page.scss'],
  standalone: true,
  imports: [IonButtons, IonContent, IonHeader, IonTitle, IonToolbar, CommonModule, FormsModule, IonMenuButton]
})
export class GestionCallesAvenidasPage implements OnInit {

  constructor() { }

  ngOnInit() {
  }

}
