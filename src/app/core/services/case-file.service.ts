import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  CaseFileResponse,
  PolicyVersionResponse,
  ProcessHistoryResponse
} from '../models/case-file.model';

@Injectable({ providedIn: 'root' })
export class CaseFileService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/case-files`;
  private readonly policiesUrl = `${environment.apiBaseUrl}/policies`;
  /**
   * New consultant-facing endpoint: creates a case directly from a policy +
   * start-form payload. The backend picks the active policy version and
   * boots the workflow engine. Consolidates the two-step
   * "pick version → start" flow the designer originally used.
   */
  private readonly casesUrl = `${environment.apiBaseUrl}/cases`;

  /** Starts a new process from a policy version (legacy flow). */
  startProcess(policyVersionId: string): Observable<CaseFileResponse> {
    return this.http.post<CaseFileResponse>(`${this.baseUrl}/start/${policyVersionId}`, {});
  }

  /**
   * Starts a case directly from a policy id and the data captured by the
   * start form. Backend contract:
   *   POST /api/cases
   *   { policyId, startFormData }
   */
  startCase(
    policyId: string,
    startFormData: Record<string, unknown>
  ): Observable<CaseFileResponse> {
    return this.http.post<CaseFileResponse>(this.casesUrl, {
      policyId,
      startFormData
    });
  }

  getCaseFile(id: string): Observable<CaseFileResponse> {
    return this.http.get<CaseFileResponse>(`${this.baseUrl}/${id}`);
  }

  getAllCaseFiles(status?: string): Observable<CaseFileResponse[]> {
    const url = status ? `${this.baseUrl}?status=${status}` : this.baseUrl;
    return this.http.get<CaseFileResponse[]>(url);
  }

  getCaseFileHistory(id: string): Observable<ProcessHistoryResponse[]> {
    return this.http.get<ProcessHistoryResponse[]>(`${this.baseUrl}/${id}/history`);
  }

  /** Fetches policy versions for the start-process dropdown. */
  getPolicyVersions(policyId: string): Observable<PolicyVersionResponse[]> {
    return this.http.get<PolicyVersionResponse[]>(`${this.policiesUrl}/${policyId}/versions`);
  }

  /** Creates a new version for a policy (used as a convenience for starting a process). */
  createPolicyVersion(policyId: string): Observable<PolicyVersionResponse> {
    return this.http.post<PolicyVersionResponse>(`${this.policiesUrl}/${policyId}/versions`, {});
  }

  /** Activates a policy version so it can be used to start processes. */
  activatePolicyVersion(versionId: string): Observable<PolicyVersionResponse> {
    return this.http.put<PolicyVersionResponse>(
      `${this.policiesUrl}/versions/${versionId}/activate`,
      {}
    );
  }
}
