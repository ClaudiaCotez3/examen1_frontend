export type TaskState = 'waiting' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  procedureCode: string;
  activityName: string;
  assignedTo?: string;
  state: TaskState;
  startedAt?: string;
  finishedAt?: string;
}
