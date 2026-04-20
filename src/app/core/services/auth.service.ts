import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthUser, LoginRequest, LoginResponse, RoleName } from '../models/auth.model';

/**
 * sessionStorage is used (not localStorage) so the session lifetime is bound
 * to the browser tab: refresh keeps the user signed in, but closing the tab
 * or window forces a fresh login. This matches the security expectations for
 * an internal workflow tool where leaving an unattended logged-in session
 * persisted across browser restarts is unacceptable.
 *
 * Note: each tab gets its own sessionStorage, so signing in on one tab does
 * not authenticate other tabs — that is intentional.
 */
const TOKEN_KEY = 'workflow.auth.token';
const USER_KEY = 'workflow.auth.user';

/**
 * Legacy storage cleanup: remove any session left in localStorage by older
 * builds that stored the token there. Without this, users who logged in
 * before this change would auto-sign-in on first visit until they manually
 * cleared their browser storage.
 */
function purgeLegacyLocalStorageSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* private browsing / storage disabled — nothing to do */
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly baseUrl = `${environment.apiBaseUrl}/auth`;

  private readonly _currentUser = signal<AuthUser | null>(null);
  readonly currentUser = this._currentUser.asReadonly();
  readonly isLoggedIn = computed(() => this._currentUser() !== null);

  /** Restore the session from storage. Called once on app startup. */
  restoreSession(): void {
    purgeLegacyLocalStorageSession();
    const token = this.getToken();
    const raw = sessionStorage.getItem(USER_KEY);
    if (!token || !raw) {
      this.clearSession();
      return;
    }
    try {
      this._currentUser.set(JSON.parse(raw) as AuthUser);
    } catch {
      this.clearSession();
    }
  }

  login(payload: LoginRequest): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.baseUrl}/login`, payload).pipe(
      tap((response) => this.persistSession(response))
    );
  }

  logout(redirect = true): void {
    this.clearSession();
    if (redirect) {
      this.router.navigate(['/login']);
    }
  }

  /** Called by the interceptor on 401 to drop the stale session. */
  clearSession(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    this._currentUser.set(null);
  }

  getToken(): string | null {
    return sessionStorage.getItem(TOKEN_KEY);
  }

  getCurrentUser(): AuthUser | null {
    return this._currentUser();
  }

  isAuthenticated(): boolean {
    return this.getToken() !== null && this._currentUser() !== null;
  }

  hasRole(role: string): boolean {
    const user = this._currentUser();
    return !!user && user.roles.includes(role);
  }

  hasAnyRole(roles: string[]): boolean {
    if (!roles || roles.length === 0) return true;
    const user = this._currentUser();
    return !!user && user.roles.some((r) => roles.includes(r));
  }

  /** Resolves the landing route for the current user's primary role. */
  resolveLandingRoute(user: AuthUser): string {
    if (user.roles.includes(RoleName.ADMIN)) return '/admin';
    if (user.roles.includes(RoleName.SUPERVISOR)) return '/consultation';
    if (user.roles.includes(RoleName.OPERATOR)) return '/operator';
    if (user.roles.includes(RoleName.CONSULTATION)) return '/consultation';
    return '/login';
  }

  private persistSession(response: LoginResponse): void {
    sessionStorage.setItem(TOKEN_KEY, response.token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(response.user));
    this._currentUser.set(response.user);
  }
}
