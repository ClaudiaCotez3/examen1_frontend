import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  inject
} from '@angular/core';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { FormDefinition, FormField } from '../../core/models/form.model';

/**
 * Renders a dynamic form from a JSON schema and emits the collected values
 * back to the parent.
 *
 * Supported field types (must match the approved set in {@link FormField}):
 *   text · textarea · number · date · datetime · radio · select · checkbox
 *   · file · tags · dynamic-list · group
 *
 * Output shape:
 *   - scalar fields  → `{ [name]: value }`
 *   - group          → `{ [name]: { nested... } }`
 *   - dynamic-list   → `{ [name]: [ { nested... }, ... ] }`
 *   - tags           → `{ [name]: ["a", "b"] }`
 *   - file           → `{ [name]: [FileMeta, ...] }`  (metadata only;
 *                      actual upload is a separate concern)
 *
 * The component does NOT talk to HTTP — submission is delegated to the
 * parent through the `formSubmit` output so it can be reused anywhere
 * (task runner, review drawer, test harness).
 */
@Component({
  selector: 'app-dynamic-form',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, LucideAngularModule],
  templateUrl: './dynamic-form.component.html',
  styleUrl: './dynamic-form.component.scss'
})
export class DynamicFormComponent implements OnChanges {
  @Input() definition: FormDefinition | null = null;
  @Input() initialValue: Record<string, unknown> | null = null;
  @Input() readonly = false;
  @Input() submitting = false;
  @Input() submitLabel = 'Submit';

  @Output() formSubmit = new EventEmitter<Record<string, unknown>>();

  private readonly fb = inject(FormBuilder);

  form: FormGroup = this.fb.group({});
  fields: FormField[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['definition']) {
      this.rebuildForm();
    } else if (changes['initialValue'] && this.form) {
      this.patchInitial();
    }
    if (changes['readonly']) {
      this.applyReadonly();
    }
  }

  // ── Form construction ────────────────────────────────────────────────

  private rebuildForm(): void {
    this.fields = this.definition?.fields ?? [];
    this.form = this.buildGroup(this.fields, (this.initialValue ?? {}) as Record<string, unknown>);
    this.applyReadonly();
  }

  /**
   * Builds a {@link FormGroup} for a list of fields, recursing into groups
   * and dynamic-lists. Initial values thread through so pre-filled forms
   * can round-trip nested structures.
   */
  private buildGroup(fields: FormField[], initial: Record<string, unknown>): FormGroup {
    const controls: Record<string, AbstractControl> = {};
    for (const field of fields) {
      controls[field.name] = this.buildControl(field, initial[field.name]);
    }
    return this.fb.group(controls);
  }

  private buildControl(field: FormField, value: unknown): AbstractControl {
    const validators = field.required ? [Validators.required] : [];

    switch (field.type) {
      case 'group': {
        return this.buildGroup(field.fields ?? [], (value ?? {}) as Record<string, unknown>);
      }
      case 'dynamic-list': {
        const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
        const rowGroups = rows.map((row) => this.buildGroup(field.fields ?? [], row));
        return this.fb.array(rowGroups, validators);
      }
      case 'tags': {
        const initial = Array.isArray(value) ? (value as string[]) : [];
        return new FormControl<string[]>(initial, validators);
      }
      case 'file': {
        // File metadata is kept in state but actual upload is deferred
        // to the parent. We store a list of {name,size,type} stubs so the
        // form value round-trips.
        const initial = Array.isArray(value) ? (value as unknown[]) : [];
        return new FormControl<unknown[]>(initial, validators);
      }
      case 'checkbox': {
        return new FormControl<boolean>(!!value, validators);
      }
      case 'number': {
        return new FormControl<number | null>(
          value === null || value === undefined || value === '' ? null : Number(value),
          validators
        );
      }
      default: {
        return new FormControl<string>(value == null ? '' : String(value), validators);
      }
    }
  }

  private patchInitial(): void {
    // Safer to rebuild than patch — nested FormArrays don't resize via
    // patchValue and would silently drop rows.
    this.rebuildForm();
  }

  private applyReadonly(): void {
    if (!this.form) return;
    if (this.readonly) {
      this.form.disable({ emitEvent: false });
    } else {
      this.form.enable({ emitEvent: false });
    }
  }

  // ── Template helpers ─────────────────────────────────────────────────

  asGroup(ctrl: AbstractControl | null): FormGroup {
    return ctrl as FormGroup;
  }

  asArray(ctrl: AbstractControl | null): FormArray {
    return ctrl as FormArray;
  }

  /**
   * Narrowing helper for the template. Every leaf control we build is a
   * FormControl; Angular's strict template type checker needs the cast.
   */
  asControl(ctrl: AbstractControl | null): FormControl {
    return ctrl as FormControl;
  }

  iconFor(field: FormField): string {
    switch (field.type) {
      case 'text': return 'type';
      case 'textarea': return 'align-left';
      case 'number': return 'hash';
      case 'date': return 'calendar';
      case 'datetime': return 'calendar-clock';
      case 'radio': return 'circle-dot';
      case 'select': return 'list';
      case 'checkbox': return 'check-square';
      case 'file': return 'paperclip';
      case 'tags': return 'tags';
      case 'dynamic-list': return 'list-plus';
      case 'group': return 'folder';
    }
  }

  isInvalid(ctrl: AbstractControl | null): boolean {
    if (!ctrl) return false;
    return ctrl.invalid && (ctrl.touched || ctrl.dirty);
  }

  // ── Dynamic-list row management ──────────────────────────────────────

  addRow(field: FormField, parent: FormGroup): void {
    const array = parent.get(field.name) as FormArray | null;
    if (!array) return;
    array.push(this.buildGroup(field.fields ?? [], {}));
  }

  removeRow(field: FormField, parent: FormGroup, index: number): void {
    const array = parent.get(field.name) as FormArray | null;
    if (!array) return;
    array.removeAt(index);
  }

  // ── Tags management ──────────────────────────────────────────────────

  addTag(parent: FormGroup, field: FormField, input: HTMLInputElement): void {
    const raw = input.value.trim();
    if (!raw) return;
    const ctrl = parent.get(field.name);
    if (!ctrl) return;
    const current = Array.isArray(ctrl.value) ? (ctrl.value as string[]) : [];
    if (current.includes(raw)) {
      input.value = '';
      return;
    }
    ctrl.setValue([...current, raw]);
    ctrl.markAsDirty();
    input.value = '';
  }

  removeTag(parent: FormGroup, field: FormField, index: number): void {
    const ctrl = parent.get(field.name);
    if (!ctrl) return;
    const current = Array.isArray(ctrl.value) ? (ctrl.value as string[]) : [];
    if (index < 0 || index >= current.length) return;
    const next = current.slice();
    next.splice(index, 1);
    ctrl.setValue(next);
    ctrl.markAsDirty();
  }

  // ── File input ───────────────────────────────────────────────────────

  onFilesSelected(parent: FormGroup, field: FormField, event: Event): void {
    const target = event.target as HTMLInputElement;
    const list = target.files ? Array.from(target.files) : [];
    const meta = list.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    const ctrl = parent.get(field.name);
    if (!ctrl) return;
    ctrl.setValue(meta);
    ctrl.markAsDirty();
  }

  // ── Submit ───────────────────────────────────────────────────────────

  onSubmit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.formSubmit.emit(this.form.getRawValue());
  }
}
