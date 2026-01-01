import {
  Component, inject, AfterViewInit, OnDestroy,
  ViewChildren, ElementRef, QueryList
} from '@angular/core';
import { CommonModule, NgIf, NgFor } from '@angular/common';
import {
  IonContent, IonHeader, IonTitle, IonToolbar,
  IonIcon, IonCard, IonCardHeader, IonCardTitle, IonButtons, IonMenuButton } from '@ionic/angular/standalone';
import { RouterLink } from '@angular/router';
import { addIcons } from 'ionicons';
import { bicycleOutline, newspaperOutline } from 'ionicons/icons';
import { NoticiasService, Noticia } from '../../core/services/noticias.service';

@Component({
  standalone: true,
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  imports: [IonButtons, IonMenuButton,
    CommonModule, NgIf, NgFor, RouterLink,
    IonContent, IonHeader, IonTitle, IonToolbar,
    IonIcon, IonCard, IonCardHeader, IonCardTitle
  ]
})
export class HomePage implements AfterViewInit, OnDestroy {
  private noticiasSrv = inject(NoticiasService);

  // ← ARRAY normal (NO signals)
  news: (Noticia & { cover: string; publishedAt: string | null })[] = [];
  loadingNews = true;
  errorNews: string | null = null;

  @ViewChildren('newsCard') newsCards!: QueryList<ElementRef<HTMLElement>>;
  activeNews = 0;
  private ioNews?: IntersectionObserver;

  private readonly NEWS_FALLBACK =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(`
      <svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'>
        <rect width='100%' height='100%' fill='#eef1f4'/>
        <g fill='#c2c8d0'><rect x='100' y='120' width='1000' height='560' rx='16'/></g>
        <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
          font-family='Arial, sans-serif' font-size='28' fill='#8a94a6'>Sin imagen</text>
      </svg>`);

  constructor() {
    addIcons({ bicycleOutline, newspaperOutline });
    this.cargarNoticias();
  }

  ngAfterViewInit() {
    this.newsCards?.changes?.subscribe(() => this.observeNews());
    setTimeout(() => this.observeNews(), 0);
  }
  ngOnDestroy() { this.ioNews?.disconnect(); }

  async cargarNoticias() {
    this.loadingNews = true; this.errorNews = null;
    try {
      const ultimas = await this.noticiasSrv.getUltimas(10);
      console.log('[HomePage] Noticias mapeadas:', ultimas);
      this.news = ultimas;
      setTimeout(() => this.observeNews(), 0);
    } catch (e:any) {
      console.error('[HomePage] error noticias:', e);
      this.errorNews = e?.message || 'No fue posible cargar las noticias.';
      this.news = [];
    } finally { this.loadingNews = false; }
  }

  onImgError(ev: Event) {
    const img = ev.target as HTMLImageElement;
    if ((img as any).__fallbackApplied) return;
    (img as any).__fallbackApplied = true;
    img.src = this.NEWS_FALLBACK;
    img.onerror = null;
  }

  fechaDMY(entrada?: string | null) {
    if (!entrada) return '';
    if (/^\d{2}-\d{2}-\d{4}$/.test(entrada)) return entrada;
    const d = new Date(entrada);
    if (!isNaN(d.getTime())) {
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const yyyy = d.getFullYear();
      return `${dd}-${mm}-${yyyy}`;
    }
    return entrada;
  }

  private observeNews() {
    this.ioNews?.disconnect();
    if (!this.newsCards || this.newsCards.length <= 1) {
      this.activeNews = 0;
      return;
    }
    const root = document.querySelector('.carousel.news') as HTMLElement;
    this.ioNews = new IntersectionObserver((entries) => {
      const best = entries.filter(e => e.isIntersecting)
                          .sort((a,b)=> b.intersectionRatio - a.intersectionRatio)[0];
      if (!best) return;
      const idx = this.newsCards.toArray().findIndex(c => c.nativeElement === best.target);
      if (idx >= 0) this.activeNews = idx;
    }, { root, threshold: 0.6 });
    this.newsCards.forEach(c => this.ioNews!.observe(c.nativeElement));
  }
}
