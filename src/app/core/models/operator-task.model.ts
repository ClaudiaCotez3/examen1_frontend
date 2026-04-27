export type OperatorTaskStatus =
  | 'WAITING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  /**
   * Pre-materialised but not yet runnable: an upstream task or a
   * decision branch must resolve before this one becomes WAITING.
   * Rendered with a lock icon and no "Tomar" button on the Kanban.
   */
  | 'BLOCKED';

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
  /**
   * True when the activity's outgoing flow lands on a DECISION gateway.
   * The operator UI uses this to follow up the form submission with the
   * Aprobar / Rechazar dialog so the workflow engine can pick a branch.
   */
  requiresDecision?: boolean;
}

/** Grouped-by-status response from the operator endpoint. */
export interface OperatorTasksResponse {
  waiting: OperatorTask[];
  inProgress: OperatorTask[];
  completed: OperatorTask[];
}
