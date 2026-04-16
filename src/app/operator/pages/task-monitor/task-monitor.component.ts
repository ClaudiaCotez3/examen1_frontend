import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { ProcessHistoryResponse } from '../../../core/models/case-file.model';
import {
  OperatorTask,
  OperatorTaskStatus,
  OperatorTasksResponse
} from '../../../core/models/operator-task.model';
import { CaseFileService } from '../../../core/services/case-file.service';
import { OperatorService } from '../../../core/services/operator.service';

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
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './task-monitor.component.html',
  styleUrl: './task-monitor.component.scss'
})
export class TaskMonitorComponent implements OnInit {
  private readonly operatorService = inject(OperatorService);
  private readonly caseFileService = inject(CaseFileService);

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

  completeTask(task: OperatorTask): void {
    if (task.status !== 'IN_PROGRESS') return;
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
