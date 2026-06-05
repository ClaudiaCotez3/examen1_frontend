import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { ClientCases, RepositoryOverview } from '../models/repository.model';

/**
 * Repositorio Documental — HTTP facade for the admin module.
 * Master-detail over the customer dimension; the expediente itself is the
 * existing /expediente/:caseFileId view.
 */
@Injectable({ providedIn: 'root' })
export class AdminRepositoryService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/admin/repository`;

  /** KPIs + client list, optionally filtered by name/email/CI. */
  getClients(search?: string): Observable<RepositoryOverview> {
    let params = new HttpParams();
    if (search?.trim()) params = params.set('search', search.trim());
    return this.http.get<RepositoryOverview>(`${this.baseUrl}/clients`, { params });
  }

  /** A client's file: identity + every trámite they opened. */
  getClientCases(clientId: string): Observable<ClientCases> {
    return this.http.get<ClientCases>(`${this.baseUrl}/clients/${clientId}/cases`);
  }
}
