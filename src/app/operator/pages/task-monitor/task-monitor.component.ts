import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { Task, TaskState } from '../../../core/models/task.model';

interface Column {
  state: TaskState;
  title: string;
  icon: string;
  modifier: string;
}

@Component({
  selector: 'app-task-monitor',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './task-monitor.component.html',
  styleUrl: './task-monitor.component.scss'
})
export class TaskMonitorComponent {
  readonly columns: Column[] = [
    { state: 'waiting', title: 'Waiting', icon: 'clock', modifier: 'waiting' },
    { state: 'in_progress', title: 'In Progress', icon: 'loader', modifier: 'in-progress' },
    { state: 'completed', title: 'Completed', icon: 'check-circle', modifier: 'completed' }
  ];

  readonly tasks = signal<Task[]>([
    { id: '1', procedureCode: 'TRM-2026-001', activityName: 'Review documentation', state: 'waiting', assignedTo: 'María G.' },
    { id: '2', procedureCode: 'TRM-2026-002', activityName: 'Validate applicant data', state: 'waiting', assignedTo: 'Luis P.' },
    { id: '3', procedureCode: 'TRM-2026-003', activityName: 'Legal approval', state: 'in_progress', assignedTo: 'María G.' },
    { id: '4', procedureCode: 'TRM-2026-004', activityName: 'Site inspection', state: 'in_progress', assignedTo: 'Carlos R.' },
    { id: '5', procedureCode: 'TRM-2026-005', activityName: 'Permit issuance', state: 'completed', assignedTo: 'Ana T.' }
  ]);

  tasksFor(state: TaskState) {
    return computed(() => this.tasks().filter((t) => t.state === state));
  }
}
