import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { PolicyDraft, PolicyResponse } from '../models/policy.model';

export interface CreatePolicyMetadata {
  name: string;
  description?: string;
  status?: 'DRAFT' | 'ACTIVE';
}

@Injectable({ providedIn: 'root' })
export class PolicyService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/policies`;

  /** Creates a plain policy record (no graph). */
  createPolicy(payload: CreatePolicyMetadata): Observable<PolicyResponse> {
    return this.http.post<PolicyResponse>(this.baseUrl, payload);
  }

  /** Saves the full graph (policy + lanes + activities + flows) in one call. */
  savePolicyStructure(draft: PolicyDraft): Observable<PolicyResponse> {
    return this.http.post<PolicyResponse>(`${this.baseUrl}/full`, draft);
  }

  /**
   * Updates an existing policy's full graph in place. The backend wipes the
   * current lanes/activities/flows and re-inserts from the payload, keeping
   * the same policy id so version history and in-flight Procedures stay sane.
   */
  updatePolicyStructure(id: string, draft: PolicyDraft): Observable<PolicyResponse> {
    return this.http.put<PolicyResponse>(`${this.baseUrl}/${id}/full`, draft);
  }

  getPolicies(): Observable<PolicyResponse[]> {
    return this.http.get<PolicyResponse[]>(this.baseUrl);
  }

  getPolicy(id: string): Observable<PolicyResponse> {
    return this.http.get<PolicyResponse>(`${this.baseUrl}/${id}`);
  }

  /**
   * Cascade hard delete: the backend removes the policy together with
   * every dependent document (versions, lanes, activities, flows,
   * trámites, history, activity instances) so the operator Kanban
   * doesn't keep showing tasks for a process that the admin retired.
   */
  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }
}
