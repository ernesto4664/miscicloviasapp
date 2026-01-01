import { Component, inject, OnInit } from '@angular/core';
import { CommonModule, NgIf } from '@angular/common';
import {
  IonApp, IonSplitPane, IonMenu, IonHeader, IonToolbar, IonTitle, IonContent,
  IonList, IonItem, IonLabel, IonButtons, IonButton, IonMenuToggle,
  IonRouterOutlet, IonNote, IonIcon, IonFooter, IonCard
} from '@ionic/angular/standalone';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { addIcons } from 'ionicons';
import {
  homeOutline, compassOutline, createOutline, calendarOutline, newspaperOutline,
  settingsOutline, logInOutline, logOutOutline, peopleOutline, layersOutline, bicycleOutline
} from 'ionicons/icons';

// 👇 habilitamos/gestionamos el menú por id
import { MenuController } from '@ionic/angular';

@Component({
  standalone: true,
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  imports: [
    IonCard,
    IonApp, IonSplitPane, IonMenu, IonHeader, IonToolbar, IonTitle, IonContent,
    IonList, IonItem, IonLabel, IonButtons, IonButton, IonMenuToggle,
    IonRouterOutlet, IonNote, IonIcon, IonFooter,
    CommonModule, NgIf,
    RouterLink, RouterOutlet
  ]
})
export class AppComponent implements OnInit {
  private readonly _auth = inject(AuthService);
  private router = inject(Router);

  // 👇 inyección del controlador del menú
  private menu = inject(MenuController);

  get isAuth()  { return this._auth.isLoggedIn(); }
  get isAdmin() { return this._auth.hasAnyAdminRole(); }

  constructor() {
    addIcons({
      homeOutline, compassOutline, createOutline, calendarOutline, newspaperOutline,
      settingsOutline, logInOutline, logOutOutline, peopleOutline, layersOutline, bicycleOutline
    });
  }

  async ngOnInit() {
    await this._auth.resolveRedirectLoginIfNeeded();

    // 👇 habilita explícitamente el menú por id para evitar que quede deshabilitado
    await this.menu.enable(true, 'main-menu');
  }

  async logout() {
    await this._auth.logout();
    this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}
