import { Injectable, signal } from '@angular/core';

import { AssignmentType } from '../models/policy.model';

/**
 * localStorage slot where the policy designer persists its in-progress draft.
 * A single slot is intentional: the designer edits one process at a time and
 * we want to survive page reloads / navigation without confusing the user
 * with multiple half-finished versions.
 *
 * The `:v3` suffix is a schema marker. Bump it whenever the starter diagram
 * or persisted shape changes so stale drafts from earlier builds (e.g. the
 * pre-seeded "Inicio → Actividad 1 → Fin" skeleton) get dropped on load.
 */
const STORAGE_KEY = 'policy-designer:draft:v3';

/**
 * Snapshot of everything the Policy Designer needs to restore an editing
 * session: the BPMN XML (authoritative for diagram geometry) plus the
 * sidebar maps keyed by element id.
 */
export interface DiagramDraft {
  name: string;
  description: string;
  /** Process-level prerequisites — not per-activity. */
  prerequisites: string[];
  xml: string;
  formIds: Record<string, string | null>;
  assignedUserIds: Record<string, string[]>;
  /** How each activity assigns work at runtime. */
  assignmentTypes: Record<string, AssignmentType>;
  updatedAt: number;
}

@Injectable({ providedIn: 'root' })
export class DiagramStateService {
  /** Reactive flag so the UI can show a "draft restored" indicator if wanted. */
  readonly hasDraft = signal(this.readRaw() !== null);

  /** Timestamp of the last successful save; used by the UI as "guardado hace X". */
  readonly lastSavedAt = signal<number | null>(this.loadMeta()?.updatedAt ?? null);

  /**
   * Overwrite the stored draft. Cheap enough to call on every auto-save tick
   * because localStorage writes are synchronous and small (a few KB of XML).
   */
  save(draft: Omit<DiagramDraft, 'updatedAt'>): void {
    const full: DiagramDraft = { ...draft, updatedAt: Date.now() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(full));
      this.hasDraft.set(true);
      this.lastSavedAt.set(full.updatedAt);
    } catch (err) {
      console.warn('[DiagramStateService] Failed to persist draft', err);
    }
  }

  /** Read the draft, or null if nothing has been saved (or it was cleared). */
  load(): DiagramDraft | null {
    const raw = this.readRaw();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as DiagramDraft;
      if (!parsed || typeof parsed.xml !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } finally {
      this.hasDraft.set(false);
      this.lastSavedAt.set(null);
    }
  }

  private loadMeta(): Pick<DiagramDraft, 'updatedAt'> | null {
    return this.load();
  }

  private readRaw(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }
}
