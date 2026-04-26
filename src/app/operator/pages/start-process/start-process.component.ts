import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { CaseFileResponse } from '../../../core/models/case-file.model';
import { PolicyResponse } from '../../../core/models/policy.model';
import { CaseFileService } from '../../../core/services/case-file.service';
import { PolicyService } from '../../../core/services/policy.service';
import { DynamicFormComponent } from '../../../shared/dynamic-form/dynamic-form.component';

type Status = 'idle' | 'loading-policy' | 'starting' | 'success' | 'error';

/**
 * Consultant-facing process launcher.
 *
 * Flow: pick a policy → fill the dynamic start form authored by the admin →
 * click "Iniciar trámite" → POST /api/cases with
 * `{ policyId, startFormData }`. The backend resolves the active version
 * and boots the workflow engine, so the consultant never has to think about
 * versioning.
 *
 * The dynamic form lives inside {@link DynamicFormComponent} so file inputs,
 * validation, tags and groups come for free. Action buttons sit OUTSIDE the
 * form (by design) and gate submission on form validity, so "Cancelar" and
 * "Iniciar trámite" feel like page-level decisions — not a submit button
 * inside the form itself.
 */
@Component({
  selector: 'app-start-process',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule, DynamicFormComponent],
  templateUrl: './start-process.component.html',
  styleUrl: './start-process.component.scss'
})
export class StartProcessComponent implements OnInit, OnDestroy {
  private readonly policyService = inject(PolicyService);
  private readonly caseFileService = inject(CaseFileService);

  /**
   * Light polling so newly published policies appear in the dropdown
   * without forcing the consultor to refresh. 8 s mirrors the operator
   * Kanban cadence — long enough to be cheap, short enough to feel live.
   * Skipped while the consultor is mid-flow (loading-policy / starting)
   * so we never clobber an in-progress action.
   */
  private static readonly POLL_INTERVAL_MS = 8000;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Reference into the dynamic form. We need it to drive validation
   * reactively from the outside buttons ("Iniciar trámite" sits OUTSIDE the
   * form by design, per UX spec) and to re-read the latest values on submit.
   */
  @ViewChild(DynamicFormComponent) private dynForm?: DynamicFormComponent;

  readonly policies = signal<PolicyResponse[]>([]);
  readonly selectedPolicyId = signal<string>('');
  readonly selectedPolicy = signal<PolicyResponse | null>(null);
  readonly status = signal<Status>('idle');
  readonly errorMessage = signal<string>('');
  readonly result = signal<CaseFileResponse | null>(null);

  /** Free-text filter applied over the policy list so the consultor can
   *  narrow the catalog without scrolling the dropdown. Matches name and
   *  description (case-insensitive, accent-tolerant). */
  readonly searchTerm = signal<string>('');

  readonly filteredPolicies = computed<PolicyResponse[]>(() => {
    const term = this.normalize(this.searchTerm());
    const all = this.policies();
    if (!term) return all;
    return all.filter((p) => {
      const haystack = this.normalize(`${p.name} ${p.description ?? ''}`);
      return haystack.includes(term);
    });
  });

  /**
   * True when the selected policy declares no start form. The submit
   * button stays enabled in that case — the consultor sends an empty
   * payload and the case boots immediately.
   */
  readonly hasStartForm = computed<boolean>(() => {
    const p = this.selectedPolicy();
    return !!p?.startFormDefinition?.fields?.length;
  });

  ngOnInit(): void {
    this.refreshPolicies();
    this.pollHandle = setInterval(
      () => this.refreshPoliciesIfIdle(),
      StartProcessComponent.POLL_INTERVAL_MS
    );
  }

  ngOnDestroy(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /** Pulls the policy catalog from the backend, replacing the local cache. */
  private refreshPolicies(): void {
    this.policyService.getPolicies().subscribe({
      next: (policies) => this.policies.set(policies),
      error: (err) => this.setError(err, 'No se pudieron cargar los procesos disponibles.')
    });
  }

  /** Skips the refresh if the consultor is mid-action. */
  private refreshPoliciesIfIdle(): void {
    if (this.status() === 'starting' || this.status() === 'loading-policy') return;
    this.refreshPolicies();
  }

  onPolicyChange(policyId: string): void {
    this.selectedPolicyId.set(policyId);
    this.selectedPolicy.set(null);
    this.result.set(null);
    this.errorMessage.set('');
    this.status.set('idle');

    if (!policyId) return;

    // Fetch the full policy so we have its start form schema. The list
    // endpoint returns summaries only, which may or may not include the
    // startFormDefinition — so we always hit GET /policies/{id} for the
    // authoritative shape.
    this.status.set('loading-policy');
    this.policyService.getPolicy(policyId).subscribe({
      next: (policy) => {
        this.selectedPolicy.set(policy);
        this.status.set('idle');
      },
      error: (err) => this.setError(err, 'No se pudo cargar el proceso seleccionado.')
    });
  }

  /** Disables the submit button while the dynamic form reports invalid. */
  isFormValid(): boolean {
    if (!this.hasStartForm()) return true;
    const form = this.dynForm?.form;
    return !!form && form.valid;
  }

  startCase(): void {
    const policy = this.selectedPolicy();
    if (!policy) return;

    let startFormData: Record<string, unknown> = {};

    if (this.hasStartForm()) {
      const form = this.dynForm?.form;
      if (!form) {
        this.errorMessage.set('Formulario no disponible. Vuelve a seleccionar el proceso.');
        this.status.set('error');
        return;
      }
      if (form.invalid) {
        form.markAllAsTouched();
        this.errorMessage.set('Completa los campos requeridos antes de iniciar el trámite.');
        this.status.set('error');
        return;
      }
      startFormData = form.getRawValue() as Record<string, unknown>;
    }

    this.status.set('starting');
    this.errorMessage.set('');

    this.caseFileService.startCase(policy.id, startFormData).subscribe({
      next: (caseFile) => {
        this.result.set(caseFile);
        this.status.set('success');
      },
      error: (err) => this.setError(err, 'No se pudo iniciar el trámite.')
    });
  }

  cancel(): void {
    this.selectedPolicyId.set('');
    this.selectedPolicy.set(null);
    this.result.set(null);
    this.errorMessage.set('');
    this.status.set('idle');
  }

  /** Starts over after a successful case creation. */
  startAnother(): void {
    this.cancel();
  }

  /** Lowercases and strips diacritics so "ALMACÉN" matches "almacen". */
  private normalize(value: string): string {
    return (value ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .trim();
  }

  private setError(err: unknown, fallback: string): void {
    const message =
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback;
    this.errorMessage.set(message);
    this.status.set('error');
  }
}
