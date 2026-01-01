// src/app/core/guards/admin-role.guard.ts
import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const canMatchAdmin: CanMatchFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const ok = auth.hasAnyAdminRole();
  return ok ? true : router.parseUrl('/tabs/home');
};
