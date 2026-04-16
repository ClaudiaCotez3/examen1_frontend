export type CaseFileStatus = 'ACTIVE' | 'COMPLETED';
export type ActivityInstanceStatus = 'WAITING' | 'IN_PROGRESS' | 'COMPLETED';

/** Backend raw status codes (Spanish). Normalized to uppercase English by helpers. */
export type BackendCaseFileStatus = 'activo' | 'finalizado';
export type BackendActivityStatus = 'en_espera' | 'en_proceso' | 'finalizado';

export interface ActivityInstanceResponse {
  id: string;
  caseFileId: string;
  activityId: string;
  activityName?: string;
  activityType?: string;
  status: BackendActivityStatus | ActivityInstanceStatus;
  assignedUserId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface CaseFileResponse {
  id: string;
  code: string;
  policyVersionId: string;
  status: BackendCaseFileStatus | CaseFileStatus;
  createdAt: string;
  finishedAt?: string | null;
  currentActivities?: ActivityInstanceResponse[];
}

export interface ProcessHistoryResponse {
  id: string;
  caseFileId: string;
  activityId: string;
  activityName?: string;
  action: 'STARTED' | 'COMPLETED' | 'TRANSITION';
  userId?: string | null;
  timestamp: string;
}

export interface PolicyVersionResponse {
  id: string;
  policyId: string;
  versionNumber: number;
  active: boolean;
  createdAt: string;
}

/** Normalizes backend status codes to UI-friendly uppercase English codes. */
export function normalizeActivityStatus(
  status: string | undefined | null
): ActivityInstanceStatus {
  switch (status) {
    case 'en_espera':
    case 'WAITING':
      return 'WAITING';
    case 'en_proceso':
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'finalizado':
    case 'COMPLETED':
      return 'COMPLETED';
    default:
      return 'WAITING';
  }
}

export function normalizeCaseFileStatus(
  status: string | undefined | null
): CaseFileStatus {
  return status === 'finalizado' || status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE';
}
