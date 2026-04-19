import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { ProcessHistoryResponse } from '../../../core/models/case-file.model';
import { FormDefinition } from '../../../core/models/form.model';
import {
  OperatorTask,
  OperatorTaskStatus,
  OperatorTasksResponse
} from '../../../core/models/operator-task.model';
import { CaseFileService } from '../../../core/services/case-file.service';
import { OperatorService } from '../../../core/services/operator.service';
import { FormService } from '../../forms/form.service';
import { DynamicFormComponent } from '../../../shared/dynamic-form/dynamic-form.component';

interface Column {
  state: OperatorTaskStatus;
  title: string;
  icon: string;
  modifier: string;
}

type LoadStatus = 'idle' | 'loading' | 'error';
type StatusFilter = 'ALL' | OperatorTaskStatus;

@Component({
  selector: 'app-task-monitor',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule, DynamicFormComponent],
  templateUrl: './task-monitor.component.html',
  styleUrl: './task-monitor.component.scss'
})
export class TaskMonitorComponent implements OnInit {
  private readonly operatorService = inject(OperatorService);
  private readonly caseFileService = inject(CaseFileService);
  private readonly formService = inject(FormService);

  readonly columns: Column[] = [
    { state: 'WAITING', title: 'Waiting', icon: 'clock', modifier: 'waiting' },
    { state: 'IN_PROGRESS', title: 'In Progress', icon: 'loader', modifier: 'in-progress' },
    { state: 'COMPLETED', title: 'Completed', icon: 'check-circle', modifier: 'completed' }
  ];

  // Raw data from backend
  readonly tasks = signal<OperatorTasksResponse>({ waiting: [], inProgress: [], completed: [] });
  readonly loadStatus = signal<LoadStatus>('idle');
  readonly errorMessage = signal<string>('');
  readonly pendingActionId = signal<string>('');

  // Client-side filters
  readonly filterDate = signal<string>('');          // YYYY-MM-DD — show tasks created on/after
  readonly filterCaseFile = signal<string>('');      // substring match on caseFileCode/id
  readonly filterStatus = signal<StatusFilter>('ALL');

  // History drawer state
  readonly historyOpen = signal<boolean>(false);
  readonly historyTask = signal<OperatorTask | null>(null);
  readonly historyEvents = signal<ProcessHistoryResponse[]>([]);
  readonly historyLoading = signal<boolean>(false);

  // Dynamic-form modal state (Phase 5)
  readonly formOpen = signal<boolean>(false);
  readonly formTask = signal<OperatorTask | null>(null);
  readonly formDefinition = signal<FormDefinition | null>(null);
  readonly formLoading = signal<boolean>(false);
  readonly formSubmitting = signal<boolean>(false);
  readonly formError = signal<string>('');

  // Columns visible according to status filter
  readonly visibleColumns = computed(() => {
    const f = this.filterStatus();
    return f === 'ALL' ? this.columns : this.columns.filter((c) => c.state === f);
  });

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
      error: (err) => this.setError(err, 'Failed to load tasks')
    });
  }

  /** Returns filtered cards for a given status column. */
  tasksFor(state: OperatorTaskStatus): OperatorTask[] {
    const all = this.tasks();
    const bucket: OperatorTask[] =
      state === 'WAITING' ? all.waiting :
      state === 'IN_PROGRESS' ? all.inProgress :
      all.completed;

    return bucket.filter((t) => this.matchesFilters(t));
  }

  startTask(task: OperatorTask): void {
    if (task.status !== 'WAITING') return;
    this.pendingActionId.set(task.activityInstanceId);
    this.operatorService.startTask(task.activityInstanceId).subscribe({
      next: () => {
        this.pendingActionId.set('');
        this.loadTasks();
      },
      error: (err) => {
        this.pendingActionId.set('');
        this.setError(err, 'Failed to start task');
      }
    });
  }

  /**
   * Entry point for "Complete" on a card. If the activity declares a form,
   * open the modal so the operator fills it in; submission then triggers the
   * actual backend completion via {@link completeAfterForm}. Activities without
   * a form shortcut straight to completion.
   */
  completeTask(task: OperatorTask): void {
    if (task.status !== 'IN_PROGRESS') return;

    this.pendingActionId.set(task.activityInstanceId);
    this.formError.set('');

    this.formService.getFormByActivity(task.activityId).subscribe({
      next: (form) => {
        this.pendingActionId.set('');
        const hasFields = !!form.formDefinition?.fields?.length;
        if (hasFields && form.requiresForm !== false) {
          this.openFormModal(task, form.formDefinition!);
        } else {
          this.performComplete(task);
        }
      },
      error: (err) => {
        // Backend returns 400 when the activity has no form — treat it as
        // "complete directly". Any other status is surfaced as an error.
        this.pendingActionId.set('');
        const status = (err as { status?: number })?.status;
        if (status === 400 || status === 404) {
          this.performComplete(task);
          return;
        }
        this.setError(err, 'Failed to load form');
      }
    });
  }

  /** Opens the dynamic-form modal for a task that requires a form. */
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

  /**
   * Called by the DynamicFormComponent when the user submits valid data.
   * Sends the form to the backend; on success, auto-completes the activity.
   */
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
        const msg =
          (err as { error?: { message?: string } })?.error?.message ??
          (err as { message?: string })?.message ??
          'Failed to submit form';
        this.formError.set(msg);
      }
    });
  }

  private performComplete(task: OperatorTask): void {
    this.pendingActionId.set(task.activityInstanceId);
    this.operatorService.completeTask(task.activityInstanceId).subscribe({
      next: () => {
        this.pendingActionId.set('');
        this.loadTasks();
      },
      error: (err) => {
        this.pendingActionId.set('');
        this.setError(err, 'Failed to complete task');
      }
    });
  }

  isPending(task: OperatorTask): boolean {
    return this.pendingActionId() === task.activityInstanceId;
  }

  /** Opens the history drawer and loads the full process history for this task's case file. */
  openHistory(task: OperatorTask): void {
    this.historyTask.set(task);
    this.historyOpen.set(true);
    this.historyLoading.set(true);
    this.historyEvents.set([]);

    this.caseFileService.getCaseFileHistory(task.caseFileId).subscribe({
      next: (events) => {
        this.historyEvents.set(events);
        this.historyLoading.set(false);
      },
      error: (err) => {
        this.historyLoading.set(false);
        this.setError(err, 'Failed to load process history');
      }
    });
  }

  closeHistory(): void {
    this.historyOpen.set(false);
    this.historyTask.set(null);
    this.historyEvents.set([]);
  }

  clearFilters(): void {
    this.filterDate.set('');
    this.filterCaseFile.set('');
    this.filterStatus.set('ALL');
  }

  dismissError(): void {
    this.errorMessage.set('');
  }

  /** Formats a timestamp for display. Returns empty string if null. */
  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }

  private matchesFilters(task: OperatorTask): boolean {
    // Date filter: compare against the most relevant timestamp for the card's state
    const dateStr = this.filterDate();
    if (dateStr) {
      const threshold = new Date(dateStr);
      const reference =
        task.startedAt ? new Date(task.startedAt) :
        task.createdAt ? new Date(task.createdAt) :
        null;
      if (!reference || reference < threshold) {
        return false;
      }
    }

    // Case file filter: case-insensitive substring on code or id
    const caseFilter = this.filterCaseFile().trim().toLowerCase();
    if (caseFilter) {
      const code = (task.caseFileCode ?? '').toLowerCase();
      const id = (task.caseFileId ?? '').toLowerCase();
      if (!code.includes(caseFilter) && !id.includes(caseFilter)) {
        return false;
      }
    }

    return true;
  }

  private setError(err: unknown, fallback: string): void {
    const message =
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback;
    this.errorMessage.set(message);
    this.loadStatus.set('error');
  }
}
