import { Injectable } from '@angular/core';

import { FormDefinition } from '../models/form.model';

/**
 * Payload exchanged between the Policy Designer and the Form Builder when
 * the admin is configuring a process-level start form.
 *
 * Flow:
 *   1. Designer calls `set({ definition, schema, returnTo, saved: false })`
 *      right before navigating to the builder.
 *   2. Builder reads the draft, loads {@link schema} into its editor, lets
 *      the user edit, and on save calls `set({ ..., saved: true })` before
 *      navigating back to {@link returnTo}.
 *   3. Designer consumes the draft on re-entry: when `saved` is true it
 *      overwrites its own start-form state with the returned values, then
 *      calls `clear()` so the slot doesn't leak into the next session.
 */
export interface StartFormDraft {
  definition: FormDefinition | null;
  /** form-js editor schema (opaque object) so the admin keeps layout. */
  schema: unknown | null;
  /** Route to navigate back to after the user closes the builder. */
  returnTo: string;
  /**
   * True when the builder has just persisted a new edit — the designer
   * should pick it up on the next `ngAfterViewInit`. False means the
   * designer pushed the current state before navigating to the builder
   * (so "cancel" round-trips without losing it).
   */
  saved: boolean;
}

@Injectable({ providedIn: 'root' })
export class StartFormDraftService {
  private static readonly KEY = 'policy-designer:start-form-draft';

  set(payload: StartFormDraft): void {
    try {
      localStorage.setItem(StartFormDraftService.KEY, JSON.stringify(payload));
    } catch {
      /* private mode / quota — degrade silently */
    }
  }

  get(): StartFormDraft | null {
    try {
      const raw = localStorage.getItem(StartFormDraftService.KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StartFormDraft;
      if (typeof parsed.returnTo !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(StartFormDraftService.KEY);
    } catch {
      /* nothing to do */
    }
  }
}
