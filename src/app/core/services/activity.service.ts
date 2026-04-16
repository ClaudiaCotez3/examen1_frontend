import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  ActivityInstanceResponse,
  ActivityInstanceStatus,
  CaseFileResponse
} from '../models/case-file.model';

@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/activity-instances`;

  /** Returns all activity instances, optionally filtered. */
  getActivities(filters?: {
    caseFileId?: string;
    userId?: string;
    status?: ActivityInstanceStatus;
  }): Observable<ActivityInstanceResponse[]> {
    let params = new HttpParams();
    if (filters?.caseFileId) {
      params = params.set('caseFileId', filters.caseFileId);
    }
    if (filters?.userId) {
      params = params.set('userId', filters.userId);
    }
    if (filters?.status) {
      params = params.set('status', filters.status);
    }
    return this.http.get<ActivityInstanceResponse[]>(this.baseUrl, { params });
  }

  /** Convenience: fetches activities for all 3 statuses in parallel and merges them. */
  getAllActivities(): Observable<ActivityInstanceResponse[]> {
    const waiting$ = this.getActivities({ status: 'WAITING' });
    const inProgress$ = this.getActivities({ status: 'IN_PROGRESS' });
    const completed$ = this.getActivities({ status: 'COMPLETED' });
    return forkJoin([waiting$, inProgress$, completed$]).pipe(
      map(([w, p, c]) => [...w, ...p, ...c])
    );
  }

  /** Starts an activity: WAITING -> IN_PROGRESS. */
  startActivity(activityInstanceId: string, userId?: string): Observable<ActivityInstanceResponse> {
    const url = userId
      ? `${this.baseUrl}/${activityInstanceId}/start?userId=${userId}`
      : `${this.baseUrl}/${activityInstanceId}/start`;
    return this.http.post<ActivityInstanceResponse>(url, {});
  }

  /** Completes an activity and advances the workflow. Returns updated CaseFile. */
  completeActivity(activityInstanceId: string, userId?: string): Observable<CaseFileResponse> {
    const url = userId
      ? `${this.baseUrl}/${activityInstanceId}/complete?userId=${userId}`
      : `${this.baseUrl}/${activityInstanceId}/complete`;
    return this.http.post<CaseFileResponse>(url, {});
  }
}
