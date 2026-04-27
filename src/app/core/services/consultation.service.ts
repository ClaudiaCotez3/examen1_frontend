import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';

export interface LaneProgress {
  laneId: string;
  laneName: string;
  position: number;
  /** COMPLETED | CURRENT | PENDING */
  status: 'COMPLETED' | 'CURRENT' | 'PENDING';
}

export interface CurrentStage {
  activityInstanceId: string;
  laneName: string | null;
  activityName: string | null;
  /** WAITING | IN_PROGRESS | BLOCKED */
  state: string;
  claimedByName: string | null;
  since: string | null;
}

export interface ConsultationCase {
  caseId: string;
  code: string;
  policyId: string | null;
  policyName: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerCi: string | null;
  lanesProgress: LaneProgress[];
  currentStages: CurrentStage[];
}

export interface ConsultationQuery {
  email?: string;
  name?: string;
  ci?: string;
}

/**
 * Wraps the {@code /api/consultation/cases} endpoints used by the
 * customer-attention "Consultas" view to look up trámites by customer.
 */
@Injectable({ providedIn: 'root' })
export class ConsultationService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/consultation`;

  search(query: ConsultationQuery): Observable<ConsultationCase[]> {
    let params = new HttpParams();
    if (query.email) params = params.set('email', query.email);
    if (query.name) params = params.set('name', query.name);
    if (query.ci) params = params.set('ci', query.ci);
    return this.http.get<ConsultationCase[]>(`${this.baseUrl}/cases`, { params });
  }

  getCase(caseId: string): Observable<ConsultationCase> {
    return this.http.get<ConsultationCase>(`${this.baseUrl}/cases/${caseId}`);
  }
}
