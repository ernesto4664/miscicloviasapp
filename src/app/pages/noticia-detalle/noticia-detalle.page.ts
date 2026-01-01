import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CommonModule, NgIf } from '@angular/common';
import {
  IonContent, IonHeader, IonTitle, IonToolbar, IonButtons, IonMenuButton,
  IonImg, IonButton, IonIcon
} from '@ionic/angular/standalone';
import { NoticiasService, Noticia } from '../../core/services/noticias.service';
import { addIcons } from 'ionicons';
import { chevronBackOutline } from 'ionicons/icons';

@Component({
  standalone: true,
  selector: 'app-noticia-detalle',
  templateUrl: './noticia-detalle.page.html',
  styleUrls: ['./noticia-detalle.page.scss'],
  imports: [
    IonContent, IonHeader, IonTitle, IonToolbar, IonButtons, IonMenuButton,
    IonImg, IonButton, IonIcon, CommonModule, NgIf, RouterLink
  ]
})
export class NoticiaDetallePage {
  private route = inject(ActivatedRoute);
  private srv = inject(NoticiasService);

  noticia?: Noticia & { cover: string };
  loading = true; error: string | null = null;

  constructor() {
    addIcons({ chevronBackOutline });
    const id = this.route.snapshot.paramMap.get('id')!;
    this.load(id);
  }

  async load(id: string) {
    this.loading = true; this.error = null;
    try { this.noticia = await this.srv.getById(id); }
    catch (e:any) { this.error = e?.message || 'No fue posible cargar la noticia.'; }
    finally { this.loading = false; }
  }

  onImgError(ev: Event) { (ev.target as HTMLImageElement).src = 'assets/placeholder-news.jpg'; }

  fechaLarga(iso?: string) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('es-CL',{ weekday:'long', year:'numeric', month:'long', day:'numeric' });
  }
}
