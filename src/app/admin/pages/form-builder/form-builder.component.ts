import { CommonModule } from '@angular/common';
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
      label: 'Sample text field'
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

  @ViewChild('editorHost', { static: true }) editorHostRef!: ElementRef<HTMLDivElement>;
  @ViewChild('previewHost', { static: true }) previewHostRef!: ElementRef<HTMLDivElement>;

  readonly editingId = signal<string | null>(null);
  readonly name = signal<string>('Untitled form');
  readonly description = signal<string>('');

  readonly status = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  readonly statusMessage = signal<string>('');

  /** Hard error during editor bootstrap. Surfaced inline so the user sees it. */
  readonly bootstrapError = signal<string>('');
  /** Number of recognized fields — drives Save enablement and empty states. */
  readonly translatedFieldCount = signal<number>(0);

  /**
   * Whether the live preview drawer is open. Hidden by default so the editor
   * has the full viewport for design work; the admin opens it on demand from
   * the toolbar. The viewer is also lazily mounted — we only spin it up the
   * first time the drawer opens, then keep it in sync on every schema change
   * while open.
   */
  readonly showPreview = signal<boolean>(false);

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

      const id = this.route.snapshot.paramMap.get('id');
      if (id) {
        this.loadExisting(id);
      } else {
        await this.editor.importSchema(STARTER_SCHEMA);
        this.latestSchema = STARTER_SCHEMA;
        this.refreshTranslatedCount();
        // Preview stays closed on first paint; user opens it from the toolbar.
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
      this.refreshPreview();
    }
  }

  /** Opens / closes the live preview drawer. Lazily mounts the viewer. */
  togglePreview(): void {
    const next = !this.showPreview();
    this.showPreview.set(next);
    if (next) {
      // Defer one tick so the host element is present in the DOM before the
      // viewer tries to mount into it.
      setTimeout(() => this.refreshPreview(), 0);
    }
  }

  private refreshTranslatedCount(): void {
    const def = formJsSchemaToDefinition(this.latestSchema);
    this.translatedFieldCount.set(def.fields.length);
  }

  /**
   * Rebuilds the read-only viewer with the current schema. We destroy and
   * re-create on each change instead of patching — form-js viewers are cheap
   * to spin up and this avoids subtle bugs with stale validators.
   */
  private async refreshPreview(): Promise<void> {
    const host = this.previewHostRef?.nativeElement;
    if (!host) return;
    try { this.viewer?.destroy(); } catch { /* already destroyed */ }
    host.innerHTML = '';
    try {
      this.viewer = new Form({ container: host });
      await this.viewer.importSchema(this.latestSchema, {});
    } catch (err) {
      // Non-fatal — preview just won't render. Common when the schema is
      // half-edited and references missing components.
      console.warn('form-js viewer refresh failed', err);
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
            await this.refreshPreview();
          }
        }
      },
      error: () => {
        this.status.set('error');
        this.statusMessage.set('Form not found.');
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
    this.statusMessage.set('Saving…');

    const editing = this.editingId();
    const obs = editing
      ? this.catalog.update(editing, payload as FormCatalogUpdate)
      : this.catalog.create(payload);

    obs.subscribe({
      next: (entry) => {
        this.status.set('saved');
        this.statusMessage.set('Form saved.');
        if (!editing) {
          // Switch to "edit" mode so subsequent saves update instead of
          // duplicating the entry.
          this.editingId.set(entry.id);
          this.router.navigate(['/forms/edit', entry.id], { replaceUrl: true });
        }
      },
      error: (err) => {
        this.status.set('error');
        this.statusMessage.set(err?.message ?? 'Failed to save form.');
      }
    });
  }

  goBack(): void {
    this.router.navigate(['/forms']);
  }
}
