import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { AuthService } from '../../../core/services/auth.service';
import { FormDefinition } from '../../../core/models/form.model';
import {
  OperatorTask,
  OperatorTaskStatus,
  OperatorTasksResponse
} from '../../../core/models/operator-task.model';
import {
  ApprovalDecision,
  OperatorService
} from '../../../core/services/operator.service';
import { FormService } from '../../forms/form.service';
import { DynamicFormComponent } from '../../../shared/dynamic-form/dynamic-form.component';

interface Column {
  state: OperatorTaskStatus;
  title: string;
  icon: string;
  modifier: string;
}

type LoadStatus = 'idle' | 'loading' | 'error';

/**
 * Simple Kanban board for operators.
 *
 * Columns (Spanish): En espera · En proceso · Finalizadas.
 *
 * Task visibility: the backend returns only tasks where the current user is
 * either the assignee or a candidate, so no client-side filtering by user is
 * needed. A WAITING task with `assignedUserId == null` is AVAILABLE and shows
 * the "Tomar" button; claiming it (start + assign in one atomic call) moves
 * it to "En proceso" owned by the current user.
 *
 * Completion:
 *   - activities with a form → open dynamic form modal, then complete.
 *   - activities without a form → open Aprobar / Rechazar modal with an
 *     optional comment; the decision is sent alongside the complete call.
 */
@Component({
  selector: 'app-task-monitor',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule, DynamicFormComponent],
  templateUrl: './task-monitor.component.html',
  styleUrl: './task-monitor.component.scss'
})
export class TaskMonitorComponent implements OnInit {
  private readonly operatorService = inject(OperatorService);
  private readonly formService = inject(FormService);
  private readonly authService = inject(AuthService);

  readonly columns: Column[] = [
    { state: 'WAITING',     title: 'En espera',   icon: 'clock',        modifier: 'waiting' },
    { state: 'IN_PROGRESS', title: 'En proceso',  icon: 'loader',       modifier: 'in-progress' },
    { state: 'COMPLETED',   title: 'Finalizadas', icon: 'check-circle', modifier: 'completed' }
  ];

  // Raw data from backend
  readonly tasks = signal<OperatorTasksResponse>({ waiting: [], inProgress: [], completed: [] });
  readonly loadStatus = signal<LoadStatus>('idle');
  readonly errorMessage = signal<string>('');
  readonly pendingActionId = signal<string>('');

  // Dynamic-form modal state (for activities that require a form)
  readonly formOpen = signal<boolean>(false);
  readonly formTask = signal<OperatorTask | null>(null);
  readonly formDefinition = signal<FormDefinition | null>(null);
  readonly formSubmitting = signal<boolean>(false);
  readonly formError = signal<string>('');

  // Approval modal state (for activities without a form)
  readonly approvalOpen = signal<boolean>(false);
  readonly approvalTask = signal<OperatorTask | null>(null);
  readonly approvalDecision = signal<ApprovalDecision>('APPROVED');
  readonly approvalComment = signal<string>('');
  readonly approvalSubmitting = signal<boolean>(false);
  readonly approvalError = signal<string>('');

  /** Current operator's id, used to distinguish "my tasks" from "candidates". */
  readonly currentUserId = computed<string>(() => this.authService.currentUser()?.id ?? '');
  readonly currentUserName = computed<string>(() => this.authService.currentUser()?.fullName ?? '');

  ngOnInit(): void {
    this.loadTasks();
  }

  loadTasks(): void {
    this.loadStatus.set('loading');
    this.errorMessage.set('');
    this.operatorService.getTasks().subscribe({
      next: (response) => {
        this.tasks.set(response);
        this.loadStatus.set('idle');
      },
      error: (err) => this.setError(err, 'No se pudieron cargar las tareas')
    });
  }

  tasksFor(state: OperatorTaskStatus): OperatorTask[] {
    const all = this.tasks();
    if (state === 'WAITING') return all.waiting;
    if (state === 'IN_PROGRESS') return all.inProgress;
    return all.completed;
  }

  // ── Claim (Tomar) ────────────────────────────────────────────────────

  /** True when the task is unclaimed and in WAITING — eligible for "Tomar". */
  isAvailable(task: OperatorTask): boolean {
    return task.status === 'WAITING' && !task.assignedUserId;
  }

  /** True when the task is claimed by someone other than the current user. */
  isClaimedByOther(task: OperatorTask): boolean {
    const me = this.currentUserId();
    return !!task.assignedUserId && task.assignedUserId !== me;
  }

  /** True when the current user owns (claimed) the task. */
  isMine(task: OperatorTask): boolean {
    const me = this.currentUserId();
    return !!me && task.assignedUserId === me;
  }

  /** Name of the operator who claimed the task ("Tú" when it's the current user). */
  claimedByLabel(task: OperatorTask): string {
    if (!task.assignedUserId) return '';
    if (this.isMine(task)) return 'Tú';
    return task.assignedUserName || 'Otro operador';
  }

  /**
   * "Tomar": atomically claims + starts the task. Moves from En espera →
   * En proceso with `assignedUserId = current user`. On conflict (another
   * operator grabbed it first) we refresh so the UI reflects reality.
   */
  takeTask(task: OperatorTask): void {
    if (!this.isAvailable(task)) return;
    const me = this.currentUserId();
    if (!me) {
      this.errorMessage.set('Sesión no disponible. Vuelve a iniciar sesión.');
      return;
    }
    this.pendingActionId.set(task.activityInstanceId);
    this.operatorService.claimAndStart(task.activityInstanceId, me).subscribe({
      next: () => {
        this.pendingActionId.set('');
        this.loadTasks();
      },
      error: (err) => {
        this.pendingActionId.set('');
        // 409 = someone else took it first; just refresh silently
        const status = (err as { status?: number })?.status;
        if (status === 409) {
          this.loadTasks();
          return;
        }
        this.setError(err, 'No se pudo tomar la tarea');
      }
    });
  }

  // ── Completion entry point ──────────────────────────────────────────

  /**
   * Opens the right modal based on whether the activity declares a form.
   * Form-backed activities go through {@link openFormModal}; the rest open
   * the Aprobar / Rechazar dialog.
   */
  completeTask(task: OperatorTask): void {
    if (task.status !== 'IN_PROGRESS') return;
    if (!this.isMine(task)) return;

    this.pendingActionId.set(task.activityInstanceId);
    this.formError.set('');

    this.formService.getFormByActivity(task.activityId).subscribe({
      next: (form) => {
        this.pendingActionId.set('');
        const hasFields = !!form.formDefinition?.fields?.length;
        if (hasFields && form.requiresForm !== false) {
          this.openFormModal(task, form.formDefinition!);
        } else {
          this.openApprovalModal(task);
        }
      },
      error: (err) => {
        this.pendingActionId.set('');
        const status = (err as { status?: number })?.status;
        if (status === 400 || status === 404) {
          // Activity has no form declared → treat as approval task.
          this.openApprovalModal(task);
          return;
        }
        this.setError(err, 'No se pudo cargar el formulario');
      }
    });
  }

  // ── Form modal (FORM_TASK) ──────────────────────────────────────────

  private openFormModal(task: OperatorTask, definition: FormDefinition): void {
    this.formTask.set(task);
    this.formDefinition.set(definition);
    this.formError.set('');
    this.formOpen.set(true);
  }

  closeFormModal(): void {
    this.formOpen.set(false);
    this.formTask.set(null);
    this.formDefinition.set(null);
    this.formSubmitting.set(false);
    this.formError.set('');
  }

  onFormSubmit(formData: Record<string, unknown>): void {
    const task = this.formTask();
    if (!task) return;
    this.formSubmitting.set(true);
    this.formError.set('');
    this.formService.submitForm(task.activityInstanceId, formData).subscribe({
      next: () => {
        this.formSubmitting.set(false);
        this.closeFormModal();
        this.performComplete(task);
      },
      error: (err) => {
        this.formSubmitting.set(false);
        this.formError.set(this.messageOf(err, 'No se pudo enviar el formulario'));
      }
    });
  }

  // ── Approval modal (APPROVAL_TASK) ──────────────────────────────────

  private openApprovalModal(task: OperatorTask): void {
    this.approvalTask.set(task);
    this.approvalDecision.set('APPROVED');
    this.approvalComment.set('');
    this.approvalError.set('');
    this.approvalOpen.set(true);
  }

  closeApprovalModal(): void {
    this.approvalOpen.set(false);
    this.approvalTask.set(null);
    this.approvalComment.set('');
    this.approvalSubmitting.set(false);
    this.approvalError.set('');
  }

  submitApproval(): void {
    const task = this.approvalTask();
    if (!task) return;
    this.approvalSubmitting.set(true);
    this.approvalError.set('');
    this.operatorService
      .completeTask(task.activityInstanceId, {
        userId: this.currentUserId(),
        decision: this.approvalDecision(),
        comment: this.approvalComment()
      })
      .subscribe({
        next: () => {
          this.approvalSubmitting.set(false);
          this.closeApprovalModal();
          this.loadTasks();
        },
        error: (err) => {
          this.approvalSubmitting.set(false);
          this.approvalError.set(this.messageOf(err, 'No se pudo completar la tarea'));
        }
      });
  }

  // ── Shared completion path (used after form submit) ─────────────────

  private performComplete(task: OperatorTask): void {
    this.pendingActionId.set(task.activityInstanceId);
    this.operatorService
      .completeTask(task.activityInstanceId, { userId: this.currentUserId() })
      .subscribe({
        next: () => {
          this.pendingActionId.set('');
          this.loadTasks();
        },
        error: (err) => {
          this.pendingActionId.set('');
          this.setError(err, 'No se pudo completar la tarea');
        }
      });
  }

  // ── UI helpers ──────────────────────────────────────────────────────

  isPending(task: OperatorTask): boolean {
    return this.pendingActionId() === task.activityInstanceId;
  }

  dismissError(): void {
    this.errorMessage.set('');
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }

  private messageOf(err: unknown, fallback: string): string {
    return (
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback
    );
  }

  private setError(err: unknown, fallback: string): void {
    this.errorMessage.set(this.messageOf(err, fallback));
    this.loadStatus.set('error');
  }
}
