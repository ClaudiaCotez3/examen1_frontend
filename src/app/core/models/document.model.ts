import { DocumentAccessLevel } from './policy.model';
import { FormDefinition } from './form.model';
import { CaseFileResponse, ProcessHistoryResponse } from './case-file.model';

export type { DocumentAccessLevel };

/**
 * Backend document-access levels (collection `actividades.acceso_documentos`).
 * The designer UI speaks Spanish (LECTOR/EDITOR — see DocumentAccessLevel);
 * the backend persists/returns the canonical English enum.
 */
export type BackendDocumentAccess = 'READER' | 'EDITOR';

/**
 * Where a document entered the expediente:
 *   - `START_FORM`  → adjunto cargado por el consultor en el formulario inicial.
 *   - `ACTIVITY`    → adjunto cargado por un operador desde el formulario de
 *                     una actividad.
 *   - `EXPEDIENTE`  → subido directamente desde la vista Expediente (pestaña
 *                     Documentos) por un usuario con permiso de Editor.
 */
export type CaseDocumentSource = 'START_FORM' | 'ACTIVITY' | 'EXPEDIENTE';

/**
 * A document of the trámite's expediente — mirrors the backend's
 * CaseDocumentDTO (`GET /api/case-files/{id}/documents`). The binary lives
 * server-side; download/view go through dedicated endpoints.
 */
export interface CaseDocument {
  id: string;
  caseFileId: string;
  fileName: string;
  fileType: string | null;
  sizeBytes: number | null;
  /** Starts at 1; "Actualizar documento" bumps it server-side. */
  version: number;
  uploadedBy: string | null;
  uploadedByName: string | null;
  uploadedAt: string;
  updatedAt: string;
  source: CaseDocumentSource;
  sourceLabel: string | null;
  /**
   * False for metadata-only rows: start-form attachments whose binary was
   * never pushed to the server (legacy cases). View/download are disabled
   * until an Editor attaches content via "Actualizar".
   */
  hasContent: boolean;
}

/**
 * Una versión del historial de un documento (bitácora por documento) —
 * espejo del DocumentVersionDTO del backend.
 */
export interface DocumentVersion {
  version: number;
  fileName: string;
  fileType: string | null;
  sizeBytes: number | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  uploadedAt: string;
  /** Nota de cambio escrita por quien editó esta versión. */
  changeNote: string | null;
  /** True para la versión vigente. */
  current: boolean;
  /** False si el binario de esta versión ya no está disponible. */
  hasContent: boolean;
}

/** One row of the expediente's documental audit trail (TAREA 6 backend). */
export interface DocumentAuditEntry {
  id: string;
  caseFileId: string;
  documentId: string | null;
  /** UPLOAD | UPDATE | VIEW | DOWNLOAD */
  action: 'UPLOAD' | 'UPDATE' | 'VIEW' | 'DOWNLOAD';
  detail: string | null;
  userId: string | null;
  userName: string | null;
  timestamp: string;
}

/** A submitted activity form, as returned inside the expediente aggregate. */
export interface ExpedienteFormResponse {
  activityInstanceId: string;
  activityId: string | null;
  activityName: string | null;
  formDefinition: FormDefinition | null;
  formData: Record<string, unknown> | null;
  submittedBy: string | null;
  submittedByName: string | null;
  submittedAt: string | null;
}

/** Start-form snapshot embedded in the expediente aggregate. */
export interface ExpedienteStartForm {
  definition: FormDefinition | null;
  data: Record<string, unknown> | null;
}

/**
 * Full digital expediente — mirrors the backend's ExpedienteDTO
 * (`GET /api/case-files/{id}/expediente`). Single aggregate feeding the
 * Expediente screen.
 */
export interface ExpedienteResponse {
  caseFile: CaseFileResponse | null;
  startForm: ExpedienteStartForm | null;
  documents: CaseDocument[];
  formResponses: ExpedienteFormResponse[];
  history: ProcessHistoryResponse[];
  documentAudit: DocumentAuditEntry[];
  /** READER | EDITOR — effective documental permission of the caller. */
  accessLevel: BackendDocumentAccess;
}

/** Pretty-prints a byte count ("12.4 KB", "3.1 MB"). */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Maps a MIME type to a lucide icon name for the document list. */
export function documentIconFor(mime: string | null | undefined): string {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'file-image';
  if (m === 'application/pdf') return 'file-text';
  if (m.includes('word') || m.includes('text')) return 'file-text';
  if (m.includes('json') || m.includes('xml') || m.includes('javascript')) return 'file-code';
  return 'file';
}
