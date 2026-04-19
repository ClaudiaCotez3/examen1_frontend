import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';

import { AuthService } from '../services/auth.service';

/**
 * Permits the route only if the current user has at least one of the required
 * roles declared via `data.roles`. Falls back to the user's landing route when
 * denied so people do not bounce to /login while already signed in.
 *
 * Usage:
 *   { path: 'admin', canActivate: [authGuard, roleGuard], data: { roles: ['ADMIN'] } }
 */
export const roleGuard: CanActivateFn = (route): boolean | UrlTree => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const required = (route.data?.['roles'] as string[] | undefined) ?? [];
  if (required.length === 0) {
    return true;
  }

  if (auth.hasAnyRole(required)) {
    return true;
  }

  const user = auth.getCurrentUser();
  if (!user) {
    return router.createUrlTree(['/login']);
  }
  return router.createUrlTree([auth.resolveLandingRoute(user)]);
};
