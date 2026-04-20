import { Injectable, signal } from '@angular/core';

/**
 * localStorage slot where the policy designer persists its in-progress draft.
 * A single slot is intentional: the designer edits one policy at a time and
 * we want to survive page reloads / navigation without confusing the user
 * with multiple half-finished versions.
 */
const STORAGE_KEY = 'policy-designer:draft:v1';

/**
 * Snapshot of everything the Policy Designer needs to restore an editing
 * session: the BPMN XML (authoritative for diagram geometry) plus the
 * sidebar maps keyed by element id.
 *
 * We persist the sidebar maps alongside the XML because the custom metadata
 * (form ids, assignees, requirements) is also written into the XML, but the
 * in-memory signals are the fast path the UI reads from. Keeping them in
 * sync on reload means no flash of empty fields before the XML re-hydrates.
 */
export interface DiagramDraft {
  name: string;
  description: string;
  xml: string;
  formIds: Record<string, string | null>;
  assignedUserIds: Record<string, string[]>;
  requirements: Record<string, string[]>;
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
      // Quota or private-mode failure: degrade to in-memory only so the rest
      // of the app keeps working; the user simply loses persistence.
      console.warn('[DiagramStateService] Failed to persist draft', err);
    }
  }

  /** Read the draft, or null if nothing has been saved (or it was cleared). */
  load(): DiagramDraft | null {
    const raw = this.readRaw();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as DiagramDraft;
      // Minimal shape check so a corrupt/older entry doesn't crash restore.
      if (!parsed || typeof parsed.xml !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Drop the draft. Only called when the user explicitly chooses
   * "Nuevo diagrama" or after a successful backend save, so we never lose
   * work silently.
   */
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
