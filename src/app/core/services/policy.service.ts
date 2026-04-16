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

  getPolicies(): Observable<PolicyResponse[]> {
    return this.http.get<PolicyResponse[]>(this.baseUrl);
  }

  getPolicy(id: string): Observable<PolicyResponse> {
    return this.http.get<PolicyResponse>(`${this.baseUrl}/${id}`);
  }
}
