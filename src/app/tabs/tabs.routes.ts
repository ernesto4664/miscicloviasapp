// src/app/tabs/tabs.routes.ts
import { Routes } from '@angular/router';
import { TabsPage } from './tabs.page';

export const routes: Routes = [
  {
    path: 'tabs',
    component: TabsPage,
    children: [
      { path: 'home', loadComponent: () => import('../pages/home/home.page').then(m => m.HomePage) },
      { path: 'exploracion', loadComponent: () => import('../pages/exploracion/exploracion.page').then(m => m.ExploracionPage) },

      {
        path: 'registrar',
        children: [
          {
            path: '',
            pathMatch: 'full',
            loadComponent: () => import('../pages/registrar/registrar.page').then(m => m.RegistrarPage),
          },
          {
            path: 'activo',
            loadComponent: () => import('../pages/registrar/registrar-activo.page')
              .then(m => m.RegistrarActivoPage),
          },
        ],
      },

      { path: 'planificacion', loadComponent: () => import('../pages/planificacion/planificacion.page').then(m => m.PlanificacionPage) },

      // 👇 este redirect DEBE ir al final de los children
      { path: '', pathMatch: 'full', redirectTo: 'home' },
    ],
  },

  // 👇 y este también al final del arreglo principal
  { path: '', pathMatch: 'full', redirectTo: 'tabs/home' },
];
