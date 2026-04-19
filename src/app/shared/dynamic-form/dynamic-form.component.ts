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
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { FormDefinition, FormField } from '../../core/models/form.model';

/**
 * Renders a dynamic form from a JSON schema and emits the collected values
 * back to the parent when the user submits.
 *
 * Responsibilities:
 *   - build a reactive FormGroup from {@link FormDefinition}
 *   - enforce `required` constraints via Angular validators
 *   - render text / number / date / select inputs with Lucide icons
 *   - expose a disabled submit button until the form is valid (TASK 6)
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
  /** JSON schema describing the fields to render. */
  @Input() definition: FormDefinition | null = null;

  /** Initial values to pre-fill the form (e.g. after re-opening an activity). */
  @Input() initialValue: Record<string, unknown> | null = null;

  /** When true, every control is disabled and the submit button is hidden. */
  @Input() readonly = false;

  /** External flag the parent can raise while its POST is in flight. */
  @Input() submitting = false;

  /** Label for the submit button. Defaults to 'Submit'. */
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

  /** Rebuilds the underlying FormGroup whenever the schema changes. */
  private rebuildForm(): void {
    this.fields = this.definition?.fields ?? [];
    const group: Record<string, unknown[]> = {};
    for (const field of this.fields) {
      const validators = field.required ? [Validators.required] : [];
      const defaultValue = this.initialValue?.[field.name] ?? this.emptyFor(field);
      group[field.name] = [defaultValue, validators];
    }
    this.form = this.fb.group(group);
    this.applyReadonly();
  }

  private patchInitial(): void {
    if (!this.initialValue) return;
    this.form.patchValue(this.initialValue, { emitEvent: false });
  }

  private applyReadonly(): void {
    if (!this.form) return;
    if (this.readonly) {
      this.form.disable({ emitEvent: false });
    } else {
      this.form.enable({ emitEvent: false });
    }
  }

  private emptyFor(field: FormField): unknown {
    switch (field.type) {
      case 'number':
        return null;
      default:
        return '';
    }
  }

  iconFor(field: FormField): string {
    switch (field.type) {
      case 'text':
        return 'type';
      case 'number':
        return 'hash';
      case 'date':
        return 'calendar';
      case 'select':
        return 'list';
      default:
        return 'type';
    }
  }

  isInvalid(field: FormField): boolean {
    const ctrl = this.form.get(field.name);
    return !!ctrl && ctrl.invalid && (ctrl.touched || ctrl.dirty);
  }

  errorMessage(field: FormField): string | null {
    const ctrl = this.form.get(field.name);
    if (!ctrl || !ctrl.errors) return null;
    if (ctrl.errors['required']) {
      return `${field.label || field.name} is required`;
    }
    return 'Invalid value';
  }

  onSubmit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.formSubmit.emit(this.form.getRawValue());
  }
}
