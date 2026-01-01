// src/app/app.routes.ts
import { Routes } from '@angular/router';
import { canMatchAdmin } from './core/guards/admin-role.guard';
import { canMatchAuth } from './core/guards/auth.guard';

export const routes: Routes = [
  // =============================
  // Redirección inicial
  // =============================
  { path: '', redirectTo: 'tabs/home', pathMatch: 'full' },

  // =============================
  // Tabs principales (públicas y privadas)
  // =============================
  {
    path: 'tabs',
    loadComponent: () => import('./layout/tabs.page').then(m => m.TabsPage),
    children: [
      {
        path: 'home',
        loadComponent: () => import('./pages/home/home.page').then(m => m.HomePage),
        title: 'Inicio'
      },
      {
        path: 'exploracion',
        loadComponent: () => import('./pages/exploracion/exploracion.page').then(m => m.ExploracionPage),
        title: 'Exploración'
      },
      {
        path: 'registrar',
        loadComponent: () => import('./pages/registrar/registrar.page').then(m => m.RegistrarPage),
        title: 'Registrar'
      },
      // Página dedicada del tracking en curso (antes era modal)
      {
        path: 'registrar/activo',
        loadComponent: () => import('./pages/registrar/registrar-activo.page')
          .then(m => m.RegistrarActivoPage),
        title: 'Registro en curso'
      },
      {
        path: 'planificacion',
        loadComponent: () => import('./pages/planificacion/planificacion.page').then(m => m.PlanificacionPage),
        canMatch: [canMatchAuth],
        title: 'Planificación'
      },

      // Redirect por defecto dentro de tabs
      { path: '', redirectTo: 'home', pathMatch: 'full' }
    ]
  },

  // =============================
  // Noticias (listado y detalle) y sección personal
  // =============================
  {
    path: 'noticias',
    loadComponent: () => import('./pages/noticias/noticias.page').then(m => m.NoticiasPage),
    title: 'Noticias'
  },
  {
    // detalle por id o slug (p.ej. /noticias/123 o /noticias/mi-slug)
    path: 'noticias/:id',
    loadComponent: () => import('./pages/noticia-detalle/noticia-detalle.page').then(m => m.NoticiaDetallePage),
    title: 'Detalle de noticia'
  },
  {
    path: 'tu',
    loadComponent: () => import('./pages/tu/tu.page').then(m => m.TuPage),
    canMatch: [canMatchAuth],
    title: 'Mi perfil'
  },

  // =============================
  // Gestión (solo roles Admin/Editor/Corresponsal)
  // =============================
  {
    path: 'gestion-ciclovias',
    loadComponent: () => import('./pages/gestion-ciclovias/gestion-ciclovias.page').then(m => m.GestionCicloviasPage),
    canMatch: [canMatchAdmin],
    title: 'Gestión Ciclovías'
  },
  {
    path: 'gestion-calles-avenidas',
    loadComponent: () => import('./pages/gestion-calles-avenidas/gestion-calles-avenidas.page').then(m => m.GestionCallesAvenidasPage),
    canMatch: [canMatchAdmin],
    title: 'Gestión Calles y Avenidas'
  },
  {
    path: 'gestion-noticias',
    loadComponent: () => import('./pages/gestion-noticias/gestion-noticias.page').then(m => m.GestionNoticiasPage),
    canMatch: [canMatchAdmin],
    title: 'Gestión Noticias'
  },
  {
    // alias para coincidir con el enlace que pusiste en Home (/admin/noticias)
    path: 'admin/noticias',
    loadComponent: () => import('./pages/gestion-noticias/gestion-noticias.page').then(m => m.GestionNoticiasPage),
    canMatch: [canMatchAdmin],
    title: 'Gestión Noticias'
  },

  // =============================
  // Recorridos: vista 3D con map-matching (NUEVO)
  // =============================
  {
    path: 'actividades/:id/mapmatch',
    loadComponent: () => import('./pages/actividades/ver-actividad-mapmatch.page')
      .then(m => m.VerActividadMapmatchPage),
    canMatch: [canMatchAuth],
    title: 'Recorrido 3D'
  },

  // =============================
  // Autenticación
  // =============================
  {
    path: 'login',
    loadComponent: () => import('./core/auth/login.page').then(m => m.LoginPage),
    title: 'Iniciar sesión'
  },
  {
    path: 'register',
    loadComponent: () => import('./core/auth/register.page').then(m => m.RegisterPage),
    title: 'Registrarse'
  },

  // =============================
  // Ruta por defecto (catch-all)
  // =============================
  { path: '**', redirectTo: 'tabs/home' }
];
