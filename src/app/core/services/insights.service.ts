import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';

export interface BottleneckInsightItem {
  activityId: string;
  activityName: string;
  laneName: string | null;
  policyName: string | null;
  avgServiceMinutes: number;
  avgWaitMinutes: number;
  backlog: number;
  /** CRITICAL | WARNING | OK */
  severity: 'CRITICAL' | 'WARNING' | 'OK';
  score: number;
  explanation: string;
}

export interface BottleneckInsightResponse {
  items: BottleneckInsightItem[];
  topAlerts: BottleneckInsightItem[];
  summary: string;
}

export interface OperatorClusterItem {
  userId: string;
  fullName: string | null;
  email: string | null;
  completedCount: number;
  avgServiceMinutes: number;
  /** EFICIENTE | PROMEDIO | LENTO */
  cluster: 'EFICIENTE' | 'PROMEDIO' | 'LENTO';
  explanation: string;
}

export interface OperatorClusterResponse {
  items: OperatorClusterItem[];
  summary: string;
}

export interface AnomalyItem {
  caseId: string;
  code: string | null;
  activityName: string | null;
  laneName: string | null;
  leadMinutes: number;
  explanation: string;
}

export interface AnomalyResponse {
  items: AnomalyItem[];
  summary: string;
}

export interface InsightsSummary {
  bottlenecks: string | null;
  operators: string | null;
  anomalies: string | null;
}

/**
 * Talks to the FastAPI sidecar that runs the scikit-learn models
 * (KMeans / IsolationForest). The API base lives in `environment.aiBaseUrl`
 * because the sidecar runs on a different port (default :8001).
 *
 * The auth interceptor injects the same JWT we send to Spring Boot —
 * the Python service verifies the HS256 signature with the same secret.
 */
@Injectable({ providedIn: 'root' })
export class InsightsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.aiBaseUrl}/insights`;

  getBottlenecks(): Observable<BottleneckInsightResponse> {
    return this.http.get<BottleneckInsightResponse>(`${this.base}/bottlenecks`);
  }

  getOperators(): Observable<OperatorClusterResponse> {
    return this.http.get<OperatorClusterResponse>(`${this.base}/operators`);
  }

  getAnomalies(): Observable<AnomalyResponse> {
    return this.http.get<AnomalyResponse>(`${this.base}/anomalies`);
  }

  getSummary(): Observable<InsightsSummary> {
    return this.http.get<InsightsSummary>(`${this.base}/summary`);
  }
}
