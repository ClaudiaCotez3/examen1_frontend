import { Injectable, signal } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';

import {
  FormCatalogCreate,
  FormCatalogEntry,
  FormCatalogUpdate
} from '../models/form-catalog.model';

const STORAGE_KEY = 'workflow.form-catalog.v1';

/**
 * CRUD facade for the reusable form catalog.
 *
 * The catalog is the source of truth for *form definitions*; activities only
 * keep a `formId` reference. This decouples form authoring from the BPMN
 * editor and lets the same form be reused across many activities.
 *
 * Storage strategy
 * -----------------
 * The current implementation is **localStorage-backed** so the module works
 * end-to-end without a dedicated backend collection. The API exposes
 * Observables (matching the rest of the codebase) so swapping to an HTTP
 * backend is a one-line change per method — replace the local read/write with
 * `http.get/post/put/delete`. The shape of `FormCatalogEntry` is already what
 * a REST endpoint would return.
 *
 * Reactive layer
 * --------------
 * `entries` is a signal that any component can subscribe to. The management
 * view binds directly to it so create/edit/delete propagate without manual
 * refresh logic.
 */
@Injectable({ providedIn: 'root' })
export class FormCatalogService {
  /** Live, sorted-by-updatedAt-desc snapshot of the catalog. */
  readonly entries = signal<FormCatalogEntry[]>([]);

  constructor() {
    this.entries.set(this.readAll());
  }

  /** Returns the full catalog as an Observable. */
  list(): Observable<FormCatalogEntry[]> {
    return of(this.entries());
  }

  /** Returns a single form by id, or 404-style error. */
  get(id: string): Observable<FormCatalogEntry> {
    const found = this.entries().find((e) => e.id === id);
    return found ? of(found) : throwError(() => new Error(`Form ${id} not found`));
  }

  /** Creates a new form and returns the persisted entry. */
  create(payload: FormCatalogCreate): Observable<FormCatalogEntry> {
    const now = new Date().toISOString();
    const entry: FormCatalogEntry = {
      id: this.generateId(),
      name: payload.name.trim(),
      description: payload.description?.trim() || undefined,
      formDefinition: payload.formDefinition,
      createdAt: now,
      updatedAt: now
    };
    const next = [entry, ...this.entries()];
    this.persist(next);
    return of(entry);
  }

  /** Updates an existing form by id. Throws if not found. */
  update(id: string, patch: FormCatalogUpdate): Observable<FormCatalogEntry> {
    const current = this.entries();
    const idx = current.findIndex((e) => e.id === id);
    if (idx === -1) {
      return throwError(() => new Error(`Form ${id} not found`));
    }
    const updated: FormCatalogEntry = {
      ...current[idx],
      ...patch,
      name: (patch.name ?? current[idx].name).trim(),
      description: (patch.description ?? current[idx].description)?.trim() || undefined,
      updatedAt: new Date().toISOString()
    };
    const next = [...current];
    next[idx] = updated;
    this.persist(next);
    return of(updated);
  }

  /** Deletes a form by id. Returns void on success. */
  delete(id: string): Observable<void> {
    const next = this.entries().filter((e) => e.id !== id);
    this.persist(next);
    return of(void 0);
  }

  /** Synchronous lookup used by the Policy Designer at save time. */
  getSync(id: string): FormCatalogEntry | null {
    return this.entries().find((e) => e.id === id) ?? null;
  }

  // ── persistence ────────────────────────────────────────────────────────

  private readAll(): FormCatalogEntry[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as FormCatalogEntry[];
      return Array.isArray(parsed) ? this.sortByRecency(parsed) : [];
    } catch {
      return [];
    }
  }

  private persist(entries: FormCatalogEntry[]): void {
    const sorted = this.sortByRecency(entries);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
    this.entries.set(sorted);
  }

  private sortByRecency(entries: FormCatalogEntry[]): FormCatalogEntry[] {
    return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `form_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
