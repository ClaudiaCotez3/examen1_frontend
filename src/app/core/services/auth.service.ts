import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthUser, LoginRequest, LoginResponse, RoleName } from '../models/auth.model';

/**
 * localStorage is used (not sessionStorage) so the session survives page
 * refreshes and new tabs — operators often juggle multiple browser tabs while
 * working cases. The token has a short server-side expiration (24h) and the
 * interceptor clears it on any 401, which covers the security downside.
 */
const TOKEN_KEY = 'workflow.auth.token';
const USER_KEY = 'workflow.auth.user';

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
    const token = this.getToken();
    const raw = localStorage.getItem(USER_KEY);
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
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this._currentUser.set(null);
  }

  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
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
    localStorage.setItem(TOKEN_KEY, response.token);
    localStorage.setItem(USER_KEY, JSON.stringify(response.user));
    this._currentUser.set(response.user);
  }
}
