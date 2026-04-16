import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { OperatorTask, OperatorTasksResponse } from '../models/operator-task.model';

export interface OperatorFilters {
  /** ObjectId of the assigned user */
  userId?: string;
  /** Role name (resolved to users by the backend) */
  role?: string;
  /** Lane / department ObjectId */
  lane?: string;
}

@Injectable({ providedIn: 'root' })
export class OperatorService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/operator`;
  private readonly activityUrl = `${environment.apiBaseUrl}/activity-instances`;

  /**
   * Single-call endpoint optimized for the Kanban:
   * returns { waiting, inProgress, completed } with laneName/caseFileCode already resolved.
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

  /** WAITING -> IN_PROGRESS. Optionally assigns the user atomically. */
  startTask(activityInstanceId: string, userId?: string): Observable<unknown> {
    const url = userId
      ? `${this.activityUrl}/${activityInstanceId}/start?userId=${userId}`
      : `${this.activityUrl}/${activityInstanceId}/start`;
    return this.http.post(url, {});
  }

  /** IN_PROGRESS -> COMPLETED. Advances the workflow on the backend. */
  completeTask(activityInstanceId: string, userId?: string): Observable<unknown> {
    const url = userId
      ? `${this.activityUrl}/${activityInstanceId}/complete?userId=${userId}`
      : `${this.activityUrl}/${activityInstanceId}/complete`;
    return this.http.post(url, {});
  }
}
