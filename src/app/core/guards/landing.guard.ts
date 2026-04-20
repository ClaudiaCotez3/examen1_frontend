import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';

import { AuthService } from '../services/auth.service';

/**
 * Resolves the empty-path route to the right destination based on the
 * current user.
 *
 *   - Not authenticated → `/login` (so deep-links to `/` always go through
 *     the login page first).
 *   - Authenticated     → the role-specific landing route returned by
 *     {@link AuthService.resolveLandingRoute}, so an OPERATOR doesn't end
 *     up on the ADMIN dashboard just because the static redirect pointed
 *     there.
 *
 * Always returns a {@link UrlTree}; the dummy component associated with
 * the empty path never renders.
 */
export const landingGuard: CanActivateFn = (): UrlTree => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login']);
  }

  const user = auth.getCurrentUser();
  if (!user) {
    return router.createUrlTree(['/login']);
  }

  return router.createUrlTree([auth.resolveLandingRoute(user)]);
};
