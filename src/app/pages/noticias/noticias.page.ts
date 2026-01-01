import { Component, inject } from '@angular/core';
import { CommonModule, NgIf, NgFor } from '@angular/common';
import {
  IonContent, IonHeader, IonTitle, IonToolbar, IonButtons, IonMenuButton,
  IonList, IonItem, IonLabel, IonIcon, IonButton, IonImg
} from '@ionic/angular/standalone';
import { RouterLink } from '@angular/router';
import { NoticiasService, Noticia } from '../../core/services/noticias.service';
import { addIcons } from 'ionicons';
import { newspaperOutline, chevronBackOutline, chevronForwardOutline } from 'ionicons/icons';

@Component({
  selector: 'app-noticias',
  templateUrl: './noticias.page.html',
  styleUrls: ['./noticias.page.scss'],
  standalone: true,
  imports: [
    IonButtons, IonContent, IonHeader, IonTitle, IonToolbar, IonMenuButton,
    IonList, IonItem, IonLabel, IonIcon, IonButton, IonImg,
    CommonModule, NgIf, NgFor, RouterLink
  ]
})
export class NoticiasPage {
  private srv = inject(NoticiasService);

  paged?: { data: (Noticia & { cover: string })[]; page:number; perPage:number; total:number; lastPage:number };
  loading = true; error: string | null = null;

  constructor() {
    addIcons({ newspaperOutline, chevronBackOutline, chevronForwardOutline });
    this.load(1);
  }

  async load(page: number) {
    this.loading = true; this.error = null;
    try { this.paged = await this.srv.getListado(page, 15); }
    catch (e:any) { this.error = e?.message || 'No fue posible cargar las noticias.'; }
    finally { this.loading = false; }
  }

  fecha(iso?: string) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('es-CL',{ year:'numeric', month:'short', day:'2-digit' });
  }

  onImgError(ev: Event) { (ev.target as HTMLImageElement).src = 'assets/placeholder-news.jpg'; }
}
