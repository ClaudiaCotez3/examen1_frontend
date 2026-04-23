export type OperatorTaskStatus = 'WAITING' | 'IN_PROGRESS' | 'COMPLETED';

/** Lightweight task as returned by GET /api/operator/tasks. */
export interface OperatorTask {
  activityInstanceId: string;
  activityId: string;
  activityName: string;
  activityType: string;
  status: OperatorTaskStatus;
  caseFileId: string;
  caseFileCode: string;
  laneId: string | null;
  laneName: string | null;
  /** Operator who currently owns the task (null = unclaimed / AVAILABLE). */
  assignedUserId: string | null;
  /** Display name of the claimed operator — backend-populated when available. */
  assignedUserName?: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Grouped-by-status response from the operator endpoint. */
export interface OperatorTasksResponse {
  waiting: OperatorTask[];
  inProgress: OperatorTask[];
  completed: OperatorTask[];
}
