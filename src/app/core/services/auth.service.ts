import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, of, tap } from 'rxjs';

import { environment } from '../../../environments/environment';

export interface LoginPayload {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  name: string;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/auth`;

  readonly currentUser = signal<LoginResponse | null>(null);

  login(payload: LoginPayload): Observable<LoginResponse> {
    // Placeholder — real authentication endpoint will be wired later.
    // For now returns a mock response so the UI can be developed in isolation.
    const mock: LoginResponse = {
      token: 'mock-token',
      name: payload.email.split('@')[0],
      email: payload.email
    };
    return of(mock).pipe(tap((user) => this.currentUser.set(user)));
  }

  logout(): void {
    this.currentUser.set(null);
  }

  isAuthenticated(): boolean {
    return this.currentUser() !== null;
  }
}
