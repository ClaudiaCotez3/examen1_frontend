import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Role } from '../models/role.model';

/**
 * Read-only facade for the backend's role catalog.
 *
 * The full list is cached in a signal because:
 *   - Roles change very rarely (once per environment setup).
 *   - Multiple views need name↔id mappings on every render (User table,
 *     Policy Designer "Assign User" dropdown, role chips).
 *
 * Call {@link load} once at startup (or on demand). Subsequent reads are
 * synchronous via {@link getByName} / {@link getById}.
 */
@Injectable({ providedIn: 'root' })
export class RoleService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/roles`;

  readonly roles = signal<Role[]>([]);

  /** Fetches the role catalog and caches it. Safe to call many times. */
  load(): Observable<Role[]> {
    return this.http.get<Role[]>(this.baseUrl).pipe(
      tap((roles) => this.roles.set(roles))
    );
  }

  /** Synchronous lookup by name (e.g. 'OPERATOR'). Null if not loaded yet. */
  getByName(name: string): Role | null {
    return this.roles().find((r) => r.name === name) ?? null;
  }

  /** Synchronous lookup by ObjectId. */
  getById(id: string): Role | null {
    return this.roles().find((r) => r.id === id) ?? null;
  }

  /** Display-friendly label for a role id. Falls back to the raw id. */
  nameOf(roleId: string | null | undefined): string {
    if (!roleId) return '—';
    return this.getById(roleId)?.name ?? roleId;
  }
}
