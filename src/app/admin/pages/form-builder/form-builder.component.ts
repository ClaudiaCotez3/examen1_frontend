import { CommonModule, Location } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  ViewEncapsulation,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { FormEditor } from '@bpmn-io/form-js-editor';
import { Form } from '@bpmn-io/form-js-viewer';

import {
  FormCatalogCreate,
  FormCatalogUpdate
} from '../../../core/models/form-catalog.model';
import { FormCatalogService } from '../../../core/services/form-catalog.service';
import {
  FormJsSchema,
  definitionToFormJsSchema,
  formJsSchemaToDefinition
} from './form-js-translator';
import { setupSpanishLocalization } from './form-js-i18n';
import { setupPaletteFilter } from './form-js-palette-filter';

/**
 * Starter schema imported into the editor when no draft exists. Includes one
 * placeholder text field so the canvas isn't empty on first load — users can
 * delete it or build around it.
 */
const STARTER_SCHEMA: FormJsSchema = {
  type: 'default',
  schemaVersion: 19,
  components: [
    {
      type: 'textfield',
      key: 'sample_field',
      label: 'Campo de texto de ejemplo'
    }
  ]
};

/**
 * Form authoring view, powered by the bpmn.io form-js editor.
 *
 * The integration mirrors how `bpmn-js` is reused in the Policy Designer:
 * a vanilla-JS instance is constructed against a host `<div>`, an initial
 * schema is imported, and the parent component listens to `changed` events
 * to keep the live preview and "Save" enablement in sync.
 *
 * `ViewEncapsulation.None` is used so the component's stylesheet can layout
 * the DOM that form-js dynamically appends inside our host (palette, canvas,
 * properties panel — none of which would otherwise receive scoped styles).
 *
 * Bootstrap timing
 * ----------------
 * Editor construction is deferred via `setTimeout(0)` so it runs after the
 * very first paint. This avoids a class of bugs where preact (form-js's
 * internal renderer) measures a host that has not yet received its final
 * dimensions from Angular's flex layout, then renders into a 0-sized box.
 */
@Component({
  selector: 'app-form-builder',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './form-builder.component.html',
  styleUrl: './form-builder.component.scss'
})
export class FormBuilderComponent implements AfterViewInit, OnDestroy {
  private readonly catalog = inject(FormCatalogService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  @ViewChild('editorHost', { static: true }) editorHostRef!: ElementRef<HTMLDivElement>;
  /**
   * Preview host is only rendered while the drawer is open (see the @if in
   * the template). `static: false` lets the reference update as the drawer
   * toggles, and callers always null-check before touching it.
   */
  @ViewChild('previewHost') previewHostRef?: ElementRef<HTMLDivElement>;

  readonly editingId = signal<string | null>(null);
  readonly name = signal<string>('Formulario sin título');
  readonly description = signal<string>('');

  /** Disposes the i18n MutationObserver on destroy. */
  private disposeLocalization: (() => void) | null = null;
  /** Disposes the palette-filter MutationObserver on destroy. */
  private disposePaletteFilter: (() => void) | null = null;

  readonly status = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  readonly statusMessage = signal<string>('');

  /**
   * Prominent toast banner shown after save attempts. Distinct from the
   * inline `statusMessage` (which is small and easy to miss in the toolbar)
   * — the toast slides in over the editor for ~3 seconds with success or
   * error styling so admins can't miss the outcome.
   */
  readonly toast = signal<{ kind: 'success' | 'error'; title: string; detail?: string } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Hard error during editor bootstrap. Surfaced inline so the user sees it. */
  readonly bootstrapError = signal<string>('');
  /** Number of recognized fields — drives Save enablement and empty states. */
  readonly translatedFieldCount = signal<number>(0);

  /**
   * Whether the live preview drawer is open. The choice is persisted in
   * localStorage so admins keep their preferred layout across sessions.
   * Default is `true` (open) so first-time users immediately see the
   * "what the form looks like" panel — the very feature that justifies the
   * builder existing.
   */
  readonly showPreview = signal<boolean>(this.loadPreviewPreference());

  /**
   * Debounce handle for preview sync. Coalesces rapid `changed` events
   * (each property-panel keystroke fires one) into a single import so the
   * viewer doesn't thrash on every character.
   */
  private previewSyncTimer: ReturnType<typeof setTimeout> | null = null;

  readonly canSave = computed<boolean>(
    () => this.name().trim().length > 0 && this.translatedFieldCount() > 0
  );

  private editor: FormEditor | null = null;
  private viewer: Form | null = null;
  /** Snapshot of the current schema, kept in sync via the editor's `changed` event. */
  private latestSchema: FormJsSchema = STARTER_SCHEMA;

  ngAfterViewInit(): void {
    // Defer one tick so Angular's flex layout has resolved the editor host's
    // final dimensions before form-js measures it.
    setTimeout(() => this.bootstrap(), 0);
  }

  ngOnDestroy(): void {
    if (this.previewSyncTimer) {
      clearTimeout(this.previewSyncTimer);
      this.previewSyncTimer = null;
    }
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.disposeLocalization?.();
    this.disposeLocalization = null;
    this.disposePaletteFilter?.();
    this.disposePaletteFilter = null;
    try { this.editor?.destroy(); } catch { /* already destroyed */ }
    try { this.viewer?.destroy(); } catch { /* already destroyed */ }
    this.editor = null;
    this.viewer = null;
  }

  // ── editor lifecycle ──────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    try {
      const host = this.editorHostRef.nativeElement;
      host.innerHTML = '';

      this.editor = new FormEditor({ container: host });
      this.editor.on('changed', () => this.handleEditorChange());

      // Translate the editor chrome into Spanish. Must run AFTER the
      // editor mounts (it injects its own DOM under `host`).
      this.disposeLocalization = setupSpanishLocalization(host);

      // Restrict the palette to approved, data-producing components.
      // Presentation-only tiles (image, html, table, iframe, separator,
      // spacer, button, textview…) are removed here; the translator also
      // strips any disallowed type at save time so the backend contract
      // stays tight even if this filter is bypassed.
      this.disposePaletteFilter = setupPaletteFilter(host);

      const id = this.route.snapshot.paramMap.get('id');
      if (id) {
        this.loadExisting(id);
      } else {
        await this.editor.importSchema(STARTER_SCHEMA);
        this.latestSchema = STARTER_SCHEMA;
        this.refreshTranslatedCount();
        // `editor.importSchema` fires `changed` only via its internal clear
        // (BEFORE the new state lands), so the cached `latestSchema` from
        // that event would be empty. Push the real starter into the preview
        // explicitly so the panel isn't blank on first load. Defer one tick
        // so Angular has rendered the @if branch and `previewHostRef` is
        // populated before we try to mount the viewer.
        if (this.showPreview()) {
          setTimeout(() => void this.refreshPreview(), 0);
        }
      }

      // Sanity check: surface the error inline if the editor mounted but
      // produced no DOM (catches CSS / sizing issues that fail silently).
      if (host.childElementCount === 0) {
        this.bootstrapError.set(
          'form-js editor mounted but produced no DOM. ' +
          'Check that the editor stylesheets are loaded and the container has dimensions.'
        );
      }
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? String(err);
      this.bootstrapError.set(`Failed to initialize form editor: ${msg}`);
      console.error('form-js editor bootstrap failed', err);
    }
  }

  private handleEditorChange(): void {
    if (!this.editor) return;
    try {
      this.latestSchema = this.editor.getSchema() as FormJsSchema;
    } catch {
      return;
    }
    this.refreshTranslatedCount();
    // Skip the (relatively expensive) preview rebuild while the drawer is
    // closed — the next open will catch up via togglePreview().
    if (this.showPreview()) {
      this.schedulePreviewSync();
    }
  }

  /** Opens / closes the live preview drawer. Lazily mounts the viewer. */
  togglePreview(): void {
    const next = !this.showPreview();
    this.showPreview.set(next);
    this.savePreviewPreference(next);
    if (next) {
      // Defer one tick so the host element is present in the DOM before the
      // viewer tries to mount into it. First open does an immediate sync so
      // the user sees content right away (no debounce on first open).
      setTimeout(() => this.refreshPreview(), 0);
    } else {
      // Tear down to free the viewer's DOM/listeners; we'll re-create on
      // next open. Cheap and avoids leaking in long sessions.
      try { this.viewer?.destroy(); } catch { /* already destroyed */ }
      this.viewer = null;
    }
  }

  /**
   * Coalesces rapid editor changes (every keystroke in the properties panel
   * fires one) into a single preview import. 150ms is the sweet spot — fast
   * enough to feel "live" but slow enough to skip ~90% of redundant imports
   * during continuous typing.
   */
  private schedulePreviewSync(): void {
    if (this.previewSyncTimer) clearTimeout(this.previewSyncTimer);
    this.previewSyncTimer = setTimeout(() => {
      this.previewSyncTimer = null;
      void this.refreshPreview();
    }, 150);
  }

  private refreshTranslatedCount(): void {
    const def = formJsSchemaToDefinition(this.latestSchema);
    this.translatedFieldCount.set(def.fields.length);
  }

  /**
   * Pushes the current schema into the preview viewer. The viewer is mounted
   * once on first open and reused — `Form.importSchema()` cleanly replaces
   * the rendered form in-place, which is what gives us flicker-free live
   * sync as the admin edits. Re-creating the instance on every change (the
   * old approach) caused visible flashes and lost any preview-side scroll
   * position on every keystroke.
   */
  private async refreshPreview(): Promise<void> {
    const host = this.previewHostRef?.nativeElement;
    if (!host) return;

    // Always read straight from the editor instead of trusting
    // `this.latestSchema`. The `changed` event sometimes fires DURING an
    // editor.importSchema() call (the internal clear() emits it before the
    // new state lands), so the cached schema would be a frame stale.
    let schema: FormJsSchema = this.latestSchema;
    try {
      schema = (this.editor?.getSchema() as FormJsSchema) ?? this.latestSchema;
    } catch {
      /* fall back to cached snapshot */
    }

    // Deep-clone before handing to the viewer. The editor and viewer share a
    // moddle layer that mutates schema nodes during import (it attaches
    // `_parent` references, ids, etc.). Sharing the same object instance
    // between editor and viewer caused the viewer to render only the first
    // row reliably — the rest of the components had their parent pointers
    // rewritten by the second import and Preact dropped them silently.
    const safeSchema: FormJsSchema = JSON.parse(JSON.stringify(schema));

    try {
      // Always destroy + recreate. In form-js v1.21 calling importSchema
      // twice on the same Form instance leaves stale `_parent` pointers
      // inside its internal registries, which makes only the first field
      // render after the second import. Recreating is cheap (the viewer is
      // ~1KB of state) and we already coalesce changes via 150ms debounce
      // so flicker is bounded.
      try { this.viewer?.destroy(); } catch { /* already destroyed */ }
      host.innerHTML = '';
      this.viewer = new Form({ container: host });
      await this.viewer.importSchema(safeSchema, {});
    } catch (err) {
      // Non-fatal — preview just won't render. Common when the schema is
      // half-edited and references missing components.
      console.warn('form-js viewer refresh failed', err);
      try { this.viewer?.destroy(); } catch { /* already destroyed */ }
      this.viewer = null;
    }
  }

  // ── Preview preference persistence ────────────────────────────────────

  private static readonly PREVIEW_PREF_KEY = 'form-builder:preview-open';

  private loadPreviewPreference(): boolean {
    try {
      const raw = localStorage.getItem(FormBuilderComponent.PREVIEW_PREF_KEY);
      // Default to CLOSED so the editor's own palette + canvas + properties
      // panel get the full viewport on first entry — opening the preview
      // drawer steals ~380px on the right, which squeezes the editor's
      // internal layout. The admin opens the drawer explicitly when they
      // want it. Once they do, their choice is persisted here so later
      // sessions honor it.
      return raw === null ? false : raw === '1';
    } catch {
      return false;
    }
  }

  private savePreviewPreference(open: boolean): void {
    try {
      localStorage.setItem(FormBuilderComponent.PREVIEW_PREF_KEY, open ? '1' : '0');
    } catch {
      /* private mode / quota — degrade silently */
    }
  }

  // ── persistence ───────────────────────────────────────────────────────

  private loadExisting(id: string): void {
    this.catalog.get(id).subscribe({
      next: async (entry) => {
        this.editingId.set(entry.id);
        this.name.set(entry.name);
        this.description.set(entry.description ?? '');
        // Prefer the rich form-js schema; fall back to synthesizing one from
        // the simple FormDefinition for entries created before form-js was
        // integrated.
        const schema =
          entry.formJsSchema ?? definitionToFormJsSchema(entry.formDefinition);
        if (this.editor) {
          await this.editor.importSchema(schema);
          this.latestSchema = schema;
          this.refreshTranslatedCount();
          if (this.showPreview()) {
            // Same deferral reason as the bootstrap path — wait for the
            // @if branch to render so `previewHostRef` is available.
            setTimeout(() => void this.refreshPreview(), 0);
          }
        }
      },
      error: () => {
        this.status.set('error');
        this.statusMessage.set('Formulario no encontrado.');
      }
    });
  }

  save(): void {
    if (!this.canSave() || !this.editor) return;

    const schema = this.editor.getSchema() as FormJsSchema;
    const definition = formJsSchemaToDefinition(schema);

    const payload: FormCatalogCreate = {
      name: this.name().trim(),
      description: this.description().trim() || undefined,
      formDefinition: definition,
      formJsSchema: schema
    };

    this.status.set('saving');
    this.statusMessage.set('Guardando…');

    const editing = this.editingId();
    const obs = editing
      ? this.catalog.update(editing, payload as FormCatalogUpdate)
      : this.catalog.create(payload);

    obs.subscribe({
      next: (entry) => {
        this.status.set('saved');
        this.statusMessage.set('Formulario guardado.');
        this.showToast({
          kind: 'success',
          title: editing ? 'Cambios guardados' : 'Formulario creado',
          detail: editing
            ? `«${entry.name}» se actualizó correctamente.`
            : `«${entry.name}» se agregó al catálogo.`
        });
        if (!editing) {
          // Clear the canvas so the admin can start another form right
          // away. We replaceState (rather than navigate) to keep THIS
          // component instance alive — navigating would remount and wipe
          // the success toast before the user can read it.
          void this.resetCanvas();
          this.location.replaceState('/forms/create');
        }
      },
      error: (err) => {
        this.status.set('error');
        const detail = err?.error?.message ?? err?.message ?? 'Inténtalo nuevamente.';
        this.statusMessage.set('Error al guardar el formulario.');
        this.showToast({
          kind: 'error',
          title: 'No se pudo guardar el formulario',
          detail
        });
      }
    });
  }

  /**
   * Pop a toast banner. Auto-dismisses after 3.5 s for success and 6 s for
   * errors (longer, since the user usually wants to read the detail before
   * acting on it). Calling again replaces any in-flight toast cleanly.
   */
  showToast(payload: { kind: 'success' | 'error'; title: string; detail?: string }): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast.set(payload);
    const ttl = payload.kind === 'error' ? 6000 : 3500;
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.toast.set(null);
    }, ttl);
  }

  dismissToast(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toast.set(null);
  }

  goBack(): void {
    this.router.navigate(['/forms']);
  }

  /**
   * Resets the builder to a fresh "create" state: clears name, description
   * and the editing id, then re-imports the starter schema so the canvas
   * is ready for another form. Called after a successful create-save so
   * admins don't have to manually click "Nuevo" before authoring the next
   * form. For edit-save we keep the current draft loaded (the user is
   * clearly iterating on that specific form).
   */
  private async resetCanvas(): Promise<void> {
    this.editingId.set(null);
    this.name.set('Formulario sin título');
    this.description.set('');
    this.status.set('idle');
    this.statusMessage.set('');

    if (!this.editor) return;
    try {
      await this.editor.importSchema(STARTER_SCHEMA);
      this.latestSchema = STARTER_SCHEMA;
      this.refreshTranslatedCount();
      if (this.showPreview()) {
        // Defer one tick so the viewer host (rendered inside an @if) is
        // already in the DOM when we try to mount into it.
        setTimeout(() => void this.refreshPreview(), 0);
      }
    } catch (err) {
      console.warn('Failed to reset form canvas', err);
    }
  }
}
