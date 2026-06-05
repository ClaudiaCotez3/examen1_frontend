import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  CaseDocument,
  CaseDocumentSource,
  DocumentAuditEntry,
  ExpedienteResponse
} from '../models/document.model';

/**
 * Gestión Documental — HTTP facade for the backend expediente API.
 *
 * Replaces the interim localStorage vault: documents now live server-side
 * (Mongo metadata + filesystem binaries) and every view/download/upload/
 * update is audited by the backend.
 *
 * Endpoints (see backend CaseDocumentController / CaseController):
 *   GET    /api/case-files/{id}/expediente                      → full aggregate
 *   GET    /api/case-files/{id}/documents                       → document list
 *   POST   /api/case-files/{id}/documents          (multipart)  → upload (EDITOR)
 *   PUT    /api/case-files/{id}/documents/{docId}  (multipart)  → update  (EDITOR)
 *   GET    /api/case-files/{id}/documents/{docId}/view          → binary inline  (audits VIEW)
 *   GET    /api/case-files/{id}/documents/{docId}/download      → binary attach. (audits DOWNLOAD)
 *   GET    /api/case-files/{id}/documents/audit                 → documental audit trail
 *   POST   /api/cases/{id}/start-form-documents    (multipart)  → start-form binaries
 */
@Injectable({ providedIn: 'root' })
export class ExpedienteService {
  private readonly http = inject(HttpClient);
  private readonly caseFilesUrl = `${environment.apiBaseUrl}/case-files`;
  private readonly casesUrl = `${environment.apiBaseUrl}/cases`;

  /** Full expediente aggregate — feeds the Expediente screen in one call. */
  getExpediente(caseFileId: string): Observable<ExpedienteResponse> {
    return this.http.get<ExpedienteResponse>(
      `${this.caseFilesUrl}/${caseFileId}/expediente`
    );
  }

  listDocuments(caseFileId: string): Observable<CaseDocument[]> {
    return this.http.get<CaseDocument[]>(
      `${this.caseFilesUrl}/${caseFileId}/documents`
    );
  }

  /** Uploads new documents to the expediente (requires EDITOR). */
  uploadDocuments(
    caseFileId: string,
    files: File[],
    source: CaseDocumentSource = 'EXPEDIENTE',
    sourceLabel?: string
  ): Observable<CaseDocument[]> {
    const form = new FormData();
    for (const file of files) {
      form.append('files', file, file.name);
    }
    form.append('source', source);
    if (sourceLabel) {
      form.append('sourceLabel', sourceLabel);
    }
    return this.http.post<CaseDocument[]>(
      `${this.caseFilesUrl}/${caseFileId}/documents`,
      form
    );
  }

  /** Replaces a document's content with a new version (requires EDITOR). */
  updateDocument(
    caseFileId: string,
    documentId: string,
    file: File
  ): Observable<CaseDocument> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.put<CaseDocument>(
      `${this.caseFilesUrl}/${caseFileId}/documents/${documentId}`,
      form
    );
  }

  /** Documental audit trail of the trámite (UPLOAD/UPDATE/VIEW/DOWNLOAD). */
  getDocumentAudit(caseFileId: string): Observable<DocumentAuditEntry[]> {
    return this.http.get<DocumentAuditEntry[]>(
      `${this.caseFilesUrl}/${caseFileId}/documents/audit`
    );
  }

  /**
   * Pushes the REAL binaries of the start-form attachments right after the
   * case was created (part of the case-creation flow — CONSULTATION role).
   */
  attachStartFormDocuments(
    caseFileId: string,
    files: File[]
  ): Observable<CaseDocument[]> {
    const form = new FormData();
    for (const file of files) {
      form.append('files', file, file.name);
    }
    return this.http.post<CaseDocument[]>(
      `${this.casesUrl}/${caseFileId}/start-form-documents`,
      form
    );
  }

  // ── Binary helpers (the JWT lives in the Authorization header, so a
  //    plain <a href> / window.open against the API would come back 401 —
  //    we fetch the blob through HttpClient and hand it to the browser) ──

  /** Opens the document inline in a new tab (backend audits VIEW). */
  viewDocument(doc: CaseDocument): Observable<void> {
    return new Observable<void>((subscriber) => {
      this.fetchBlob(doc, 'view').subscribe({
        next: (blob) => {
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank', 'noopener');
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          subscriber.next();
          subscriber.complete();
        },
        error: (err) => subscriber.error(err)
      });
    });
  }

  /** Triggers a browser download (backend audits DOWNLOAD). */
  downloadDocument(doc: CaseDocument): Observable<void> {
    return new Observable<void>((subscriber) => {
      this.fetchBlob(doc, 'download').subscribe({
        next: (blob) => {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = doc.fileName || 'documento';
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
          subscriber.next();
          subscriber.complete();
        },
        error: (err) => subscriber.error(err)
      });
    });
  }

  private fetchBlob(doc: CaseDocument, mode: 'view' | 'download'): Observable<Blob> {
    return this.http.get(
      `${this.caseFilesUrl}/${doc.caseFileId}/documents/${doc.id}/${mode}`,
      { responseType: 'blob' }
    );
  }
}
