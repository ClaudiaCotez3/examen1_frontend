import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';

export interface SupervisorOverview {
  activeCases: number;
  completedCases: number;
  pendingTasks: number;
  inProgressTasks: number;
  p95LeadMinutes: number;
  stalledCases: number;
  stalledDaysThreshold: number;
}

export interface BottleneckActivity {
  activityId: string;
  activityName: string;
  policyName: string | null;
  laneName: string | null;
  avgWaitMinutes: number;
  avgServiceMinutes: number;
  avgLeadMinutes: number;
  currentBacklog: number;
  completedCount: number;
}

export interface OperatorPerformance {
  userId: string;
  fullName: string | null;
  email: string | null;
  completedCount: number;
  inProgressCount: number;
  avgServiceMinutes: number;
  teamMedianServiceMinutes: number;
}

/**
 * Wraps the deterministic KPI endpoints exposed by the Spring Boot
 * SupervisorController. Mirrors the AI sidecar in structure for
 * predictability — the dashboard component talks to both.
 */
@Injectable({ providedIn: 'root' })
export class SupervisorService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiBaseUrl}/supervisor`;

  getOverview(): Observable<SupervisorOverview> {
    return this.http.get<SupervisorOverview>(`${this.base}/overview`);
  }

  getBottlenecks(): Observable<BottleneckActivity[]> {
    return this.http.get<BottleneckActivity[]>(`${this.base}/bottlenecks`);
  }

  getOperators(): Observable<OperatorPerformance[]> {
    return this.http.get<OperatorPerformance[]>(`${this.base}/operators`);
  }
}
