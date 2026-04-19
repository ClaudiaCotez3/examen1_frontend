import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  ActivityForm,
  FormResponse,
  FormSubmissionRequest
} from '../../core/models/form.model';

/**
 * Thin HTTP facade for the dynamic-forms endpoints (Phase 5 backend).
 *
 * Two responsibilities:
 *   - fetch the schema attached to an activity (so the renderer knows what
 *     controls to build)
 *   - submit a completed form for an activity instance
 *
 * Validation + ownership rules live server-side; this service only carries
 * payloads and surfaces typed errors to the caller.
 */
@Injectable({ providedIn: 'root' })
export class FormService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/forms`;

  /** Retrieves the form schema declared on an activity (design-time). */
  getFormByActivity(activityId: string): Observable<ActivityForm> {
    return this.http.get<ActivityForm>(`${this.baseUrl}/activity/${activityId}`);
  }

  /** Sends a completed form for an activity instance (runtime). */
  submitForm(
    activityInstanceId: string,
    data: Record<string, unknown>
  ): Observable<FormResponse> {
    const body: FormSubmissionRequest = { formData: data };
    return this.http.post<FormResponse>(
      `${this.baseUrl}/submit/${activityInstanceId}`,
      body
    );
  }

  /** Reads back a previously submitted form. Optional — used for review UIs. */
  getFormResponse(activityInstanceId: string): Observable<FormResponse> {
    return this.http.get<FormResponse>(
      `${this.baseUrl}/response/${activityInstanceId}`
    );
  }
}
