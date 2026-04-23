import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import { PolicyResponse } from '../../../core/models/policy.model';
import { PolicyService } from '../../../core/services/policy.service';

/**
 * Catalog view for business policies (processes).
 *
 * Responsibilities:
 *   - list every non-archived policy from the backend
 *   - let the admin open a policy in the designer to edit its diagram
 *   - let the admin soft-delete (archive) a policy with explicit confirm
 *
 * Authoring the diagram itself still lives in {@code PolicyDesignerComponent};
 * this page is a lightweight management surface that points back at it.
 */
@Component({
  selector: 'app-policy-management',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './policy-management.component.html',
  styleUrl: './policy-management.component.scss'
})
export class PolicyManagementComponent implements OnInit {
  private readonly policyService = inject(PolicyService);
  private readonly router = inject(Router);

  readonly policies = signal<PolicyResponse[]>([]);
  readonly loading = signal<boolean>(true);
  readonly errorMessage = signal<string>('');
  readonly search = signal<string>('');

  /** Id currently awaiting the delete-confirm UI. Empty when none. */
  readonly pendingDeleteId = signal<string>('');

  /** Floating banner for save/delete outcomes — same pattern as the designer. */
  readonly toast = signal<{ kind: 'success' | 'error'; title: string; detail?: string } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  readonly visible = computed<PolicyResponse[]>(() => {
    const term = this.search().trim().toLowerCase();
    const all = this.policies();
    if (!term) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.description ?? '').toLowerCase().includes(term)
    );
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.errorMessage.set('');
    this.policyService.getPolicies().subscribe({
      next: (list) => {
        this.policies.set(list);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.errorMessage.set(this.messageOf(err, 'No se pudieron cargar los procesos'));
      }
    });
  }

  goToCreate(): void {
    this.router.navigate(['/admin/policies/new']);
  }

  goToEdit(policy: PolicyResponse): void {
    this.router.navigate(['/admin/policies/edit', policy.id]);
  }

  askDelete(policy: PolicyResponse): void {
    this.pendingDeleteId.set(policy.id);
  }

  cancelDelete(): void {
    this.pendingDeleteId.set('');
  }

  confirmDelete(policy: PolicyResponse): void {
    this.policyService.delete(policy.id).subscribe({
      next: () => {
        this.pendingDeleteId.set('');
        // Remove locally instead of refetching — the policy is archived
        // server-side so a reload would also omit it, but avoiding the
        // round-trip keeps the UI snappy.
        this.policies.update((list) => list.filter((p) => p.id !== policy.id));
        this.showToast({
          kind: 'success',
          title: 'Proceso eliminado',
          detail: `«${policy.name}» se archivó correctamente.`
        });
      },
      error: (err) => {
        this.pendingDeleteId.set('');
        this.showToast({
          kind: 'error',
          title: 'No se pudo eliminar el proceso',
          detail: this.messageOf(err, 'Inténtalo nuevamente.')
        });
      }
    });
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : d.toLocaleString();
  }

  dismissToast(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toast.set(null);
  }

  private showToast(payload: { kind: 'success' | 'error'; title: string; detail?: string }): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast.set(payload);
    const ttl = payload.kind === 'error' ? 6000 : 3500;
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.toast.set(null);
    }, ttl);
  }

  private messageOf(err: unknown, fallback: string): string {
    return (
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback
    );
  }
}
