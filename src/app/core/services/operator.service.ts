import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { OperatorTask, OperatorTasksResponse } from '../models/operator-task.model';

export interface OperatorFilters {
  userId?: string;
  role?: string;
  lane?: string;
}

/** Decision captured on the Aprobar / Rechazar modal. */
export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export interface CompletionOptions {
  /** ObjectId of the current operator (for audit + atomic ownership). */
  userId?: string;
  /** APPROVED / REJECTED — only relevant for activities without a form. */
  decision?: ApprovalDecision;
  /** Free-text note attached to the completion (optional). */
  comment?: string;
}

@Injectable({ providedIn: 'root' })
export class OperatorService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/operator`;
  private readonly activityUrl = `${environment.apiBaseUrl}/activity-instances`;

  /**
   * Single-call endpoint optimized for the Kanban:
   * returns { waiting, inProgress, completed } with laneName/caseFileCode already resolved.
   * The backend filters the list so operators only see tasks assigned to
   * them or where they appear as a candidate.
   */
  getTasks(filters?: OperatorFilters): Observable<OperatorTasksResponse> {
    let params = new HttpParams();
    if (filters?.userId) params = params.set('userId', filters.userId);
    if (filters?.role) params = params.set('role', filters.role);
    if (filters?.lane) params = params.set('lane', filters.lane);
    return this.http.get<OperatorTasksResponse>(`${this.baseUrl}/tasks`, { params });
  }

  /** Atomic assignment — backend refuses if the task is no longer WAITING. */
  assignTask(activityInstanceId: string, userId: string): Observable<OperatorTask> {
    const url = `${this.baseUrl}/tasks/${activityInstanceId}/assign?userId=${userId}`;
    return this.http.post<OperatorTask>(url, {});
  }

  /**
   * "Tomar": atomically claim + start a task. WAITING → IN_PROGRESS with
   * `assignedUserId = userId`. Backend rejects (409) if another operator
   * claimed it first; the caller should refresh on error.
   */
  claimAndStart(activityInstanceId: string, userId: string): Observable<unknown> {
    const url = `${this.activityUrl}/${activityInstanceId}/start?userId=${userId}`;
    return this.http.post(url, {});
  }

  /** WAITING -> IN_PROGRESS. Optionally assigns the user atomically. */
  startTask(activityInstanceId: string, userId?: string): Observable<unknown> {
    const url = userId
      ? `${this.activityUrl}/${activityInstanceId}/start?userId=${userId}`
      : `${this.activityUrl}/${activityInstanceId}/start`;
    return this.http.post(url, {});
  }

  /**
   * IN_PROGRESS -> COMPLETED. For approval activities (no form), pass the
   * {@link ApprovalDecision} and an optional comment via {@link CompletionOptions};
   * the body is sent alongside so the backend can record the decision.
   */
  completeTask(activityInstanceId: string, options?: CompletionOptions): Observable<unknown> {
    const url = options?.userId
      ? `${this.activityUrl}/${activityInstanceId}/complete?userId=${options.userId}`
      : `${this.activityUrl}/${activityInstanceId}/complete`;
    const body: Record<string, unknown> = {};
    if (options?.decision) body['decision'] = options.decision;
    if (options?.comment && options.comment.trim().length > 0) {
      body['comment'] = options.comment.trim();
    }
    return this.http.post(url, body);
  }
}
