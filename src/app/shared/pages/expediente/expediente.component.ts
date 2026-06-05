import { CommonModule, Location } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import {
  ActivityInstanceResponse,
  normalizeActivityStatus,
  normalizeCaseFileStatus
} from '../../../core/models/case-file.model';
import {
  CaseDocument,
  DocumentAuditEntry,
  DocumentVersion,
  ExpedienteResponse,
  documentIconFor,
  formatFileSize
} from '../../../core/models/document.model';
import { FormDefinition } from '../../../core/models/form.model';
import { ExpedienteService } from '../../../core/services/expediente.service';
import { DocEditorComponent } from '../../components/doc-editor/doc-editor.component';
import {
  OnlyofficeEditorComponent,
  isOnlyOfficeFormat
} from '../../components/onlyoffice-editor/onlyoffice-editor.component';

type ExpedienteTab = 'resumen' | 'documentos' | 'formularios' | 'bitacora';

/** A label/value pair rendered on the Resumen and Formularios tabs. */
interface FieldEntry {
  name: string;
  label: string;
  value: string;
}

/** Submitted activity form prepared for rendering (Formularios tab). */
interface ActivityFormEntry {
  activityInstanceId: string;
  activityName: string;
  submittedAt: string | null;
  submittedByName: string | null;
  entries: FieldEntry[];
}

/** Normalized event for the Historial tab (newest first). */
interface HistoryEvent {
  id: string;
  kind: 'case' | 'activity' | 'document';
  icon: string;
  title: string;
  detail: string;
  timestamp: string;
}

/**
 * Expediente digital del trámite — Gestión Documental.
 *
 * Backed entirely by the backend expediente API: one
 * `GET /api/case-files/{id}/expediente` call brings the trámite, el
 * formulario inicial, los documentos, los formularios respondidos, el
 * historial del workflow, la auditoría documental y el permiso efectivo
 * (READER | EDITOR) del usuario actual.
 *
 * Pestañas:
 *   - Resumen     → información del cliente, del trámite y estado actual.
 *   - Documentos  → listado documental: visualizar / descargar siempre
 *                   (auditados por el backend); subir / actualizar solo
 *                   con permiso de Editor.
 *   - Formularios → formulario inicial + respuestas de actividades.
 *   - Historial   → workflow + auditoría documental en una línea de tiempo.
 */
@Component({
  selector: 'app-expediente',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    LucideAngularModule,
    DocEditorComponent,
    OnlyofficeEditorComponent
  ],
  templateUrl: './expediente.component.html',
  styleUrl: './expediente.component.scss'
})
export class ExpedienteComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly expedienteService = inject(ExpedienteService);

  readonly caseFileId = signal<string>('');
  readonly activeTab = signal<ExpedienteTab>('resumen');

  readonly loading = signal<boolean>(true);
  readonly loadError = signal<string>('');

  /** Full aggregate from the backend — single source of truth. */
  readonly expediente = signal<ExpedienteResponse | null>(null);

  /** Upload / update / fetch-binary in-flight flag + soft feedback. */
  readonly uploading = signal<boolean>(false);
  readonly documentMessage = signal<{ kind: 'success' | 'error'; text: string } | null>(null);

  /** Documento abierto en el editor propio (texto / PDF / fallback). */
  readonly editingDoc = signal<CaseDocument | null>(null);

  /** Documento abierto en OnlyOffice (.docx / .xlsx / .pptx). */
  readonly editingOnlyOfficeDoc = signal<CaseDocument | null>(null);

  // ── Modal "Historial de versiones" (bitácora por documento) ───────────
  readonly versionsDoc = signal<CaseDocument | null>(null);
  readonly versions = signal<DocumentVersion[]>([]);
  readonly versionsLoading = signal<boolean>(false);

  // ── Derivados del agregado ───────────────────────────────────────────

  readonly caseFile = computed(() => this.expediente()?.caseFile ?? null);
  readonly documents = computed<CaseDocument[]>(() => this.expediente()?.documents ?? []);

  /** Permiso documental efectivo, resuelto por el backend. */
  readonly canEditDocuments = computed<boolean>(
    () => this.expediente()?.accessLevel === 'EDITOR'
  );

  readonly statusLabel = computed<string>(() => {
    const cf = this.caseFile();
    if (!cf) return '—';
    return normalizeCaseFileStatus(cf.status) === 'COMPLETED' ? 'Finalizado' : 'Activo';
  });

  readonly isCompleted = computed<boolean>(() => {
    const cf = this.caseFile();
    return !!cf && normalizeCaseFileStatus(cf.status) === 'COMPLETED';
  });

  /** Actividades vigentes del trámite (el backend ya filtra las finalizadas). */
  readonly currentActivities = computed<ActivityInstanceResponse[]>(
    () => this.caseFile()?.currentActivities ?? []
  );

  /** Información del cliente capturada en el formulario inicial. */
  readonly clientEntries = computed<FieldEntry[]>(() => {
    const startForm = this.expediente()?.startForm;
    if (!startForm) return [];
    return this.toFieldEntries(startForm.definition, startForm.data);
  });

  /** Respuestas de actividades preparadas para render (con etiquetas). */
  readonly activityForms = computed<ActivityFormEntry[]>(() => {
    const responses = this.expediente()?.formResponses ?? [];
    return responses.map((r) => ({
      activityInstanceId: r.activityInstanceId,
      activityName: r.activityName || 'Actividad',
      submittedAt: r.submittedAt,
      submittedByName: r.submittedByName,
      entries: this.toFieldEntries(r.formDefinition, r.formData)
    }));
  });

  /** Línea de tiempo unificada: workflow + auditoría documental. */
  readonly timeline = computed<HistoryEvent[]>(() => {
    const data = this.expediente();
    if (!data) return [];
    const events: HistoryEvent[] = [];
    const cf = data.caseFile;

    if (cf?.createdAt) {
      events.push({
        id: `case-start-${cf.id}`,
        kind: 'case',
        icon: 'rocket',
        title: 'Trámite iniciado',
        detail: `Se creó el expediente ${cf.code}.`,
        timestamp: cf.createdAt
      });
    }
    if (cf?.finishedAt) {
      events.push({
        id: `case-end-${cf.id}`,
        kind: 'case',
        icon: 'check-square',
        title: 'Trámite finalizado',
        detail: 'El proceso llegó a su fin.',
        timestamp: cf.finishedAt
      });
    }

    for (const h of data.history ?? []) {
      const name = h.activityName || 'Actividad';
      if (h.action === 'STARTED') {
        events.push({
          id: h.id, kind: 'activity', icon: 'play',
          title: 'Actividad iniciada', detail: name, timestamp: h.timestamp
        });
      } else if (h.action === 'COMPLETED') {
        events.push({
          id: h.id, kind: 'activity', icon: 'check-circle',
          title: 'Actividad completada', detail: name, timestamp: h.timestamp
        });
      } else {
        events.push({
          id: h.id, kind: 'activity', icon: 'git-branch',
          title: 'Transición de estado', detail: name, timestamp: h.timestamp
        });
      }
    }

    // Los movimientos documentales NO se mezclan aquí: viven en su propia
    // tabla ("Bitácora documental") dentro de la pestaña Bitácora.
    return events.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  });

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('caseFileId') ?? '';
    this.caseFileId.set(id);
    if (!id) {
      this.loading.set(false);
      this.loadError.set('Trámite no especificado.');
      return;
    }
    this.loadExpediente(id, true);
  }

  // ── Data loading ─────────────────────────────────────────────────────

  private loadExpediente(caseFileId: string, withSpinner: boolean): void {
    if (withSpinner) this.loading.set(true);
    this.loadError.set('');
    this.expedienteService.getExpediente(caseFileId).subscribe({
      next: (data) => {
        this.expediente.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        if (!this.expediente()) {
          this.loadError.set(this.messageOf(err, 'No se pudo cargar el expediente.'));
        }
      }
    });
  }

  /** Silent refresh after any documental mutation/access (keeps audit fresh). */
  private refresh(): void {
    const id = this.caseFileId();
    if (id) this.loadExpediente(id, false);
  }

  // ── Tabs / navigation ────────────────────────────────────────────────

  setTab(tab: ExpedienteTab): void {
    this.activeTab.set(tab);
  }

  goBack(): void {
    this.location.back();
  }

  // ── Documentos: acciones ─────────────────────────────────────────────

  viewDocument(doc: CaseDocument): void {
    if (!doc.hasContent) return;
    this.expedienteService.viewDocument(doc).subscribe({
      next: () => this.refresh(),
      error: (err) =>
        this.flashDocumentMessage('error', this.messageOf(err, 'No se pudo abrir el documento.'))
    });
  }

  downloadDocument(doc: CaseDocument): void {
    if (!doc.hasContent) return;
    this.expedienteService.downloadDocument(doc).subscribe({
      next: () => this.refresh(),
      error: (err) =>
        this.flashDocumentMessage('error', this.messageOf(err, 'No se pudo descargar el documento.'))
    });
  }

  /** "Subir documentos" — fired by the hidden file input (multiple). */
  onUploadFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (files.length === 0 || !this.canEditDocuments()) return;

    this.uploading.set(true);
    this.expedienteService
      .uploadDocuments(this.caseFileId(), files, 'EXPEDIENTE', 'Expediente')
      .subscribe({
        next: (stored) => {
          this.uploading.set(false);
          this.flashDocumentMessage(
            'success',
            stored.length === 1
              ? `«${stored[0].fileName}» se agregó al expediente.`
              : `${stored.length} documentos agregados al expediente.`
          );
          this.refresh();
        },
        error: (err) => {
          this.uploading.set(false);
          this.flashDocumentMessage(
            'error',
            this.messageOf(err, 'No se pudo subir el documento.')
          );
        }
      });
  }

  // ── Editores de documentos ──────────────────────────────────────────────

  /**
   * Abre el editor adecuado según el formato:
   *   - .docx / .xlsx / .pptx → OnlyOffice Document Server (fidelidad
   *     total + co-edición real), siempre que el documento tenga contenido.
   *   - texto / PDF / resto   → editor propio (fallback).
   */
  openEdit(doc: CaseDocument): void {
    if (!this.canEditDocuments()) return;
    if (isOnlyOfficeFormat(doc.fileName) && doc.hasContent) {
      this.editingOnlyOfficeDoc.set(doc);
    } else {
      this.editingDoc.set(doc);
    }
  }

  onEditorClosed(saved: boolean): void {
    const doc = this.editingDoc();
    this.editingDoc.set(null);
    if (saved && doc) {
      this.flashDocumentMessage(
        'success',
        `«${doc.fileName}» se guardó como nueva versión.`
      );
      this.refresh();
    }
  }

  onOnlyOfficeClosed(): void {
    this.editingOnlyOfficeDoc.set(null);
    // El Document Server persiste vía callback unos segundos después de
    // cerrar la sesión de edición: refrescamos ahora y de nuevo en ~12 s
    // para que la nueva versión y la bitácora aparezcan sin F5 manual.
    this.refresh();
    setTimeout(() => this.refresh(), 12_000);
  }

  // ── Historial de versiones (bitácora por documento) ───────────────────

  openVersions(doc: CaseDocument): void {
    this.versionsDoc.set(doc);
    this.versions.set([]);
    this.versionsLoading.set(true);
    this.expedienteService.getVersions(this.caseFileId(), doc.id).subscribe({
      next: (versions) => {
        this.versions.set(versions);
        this.versionsLoading.set(false);
      },
      error: (err) => {
        this.versionsLoading.set(false);
        this.flashDocumentMessage(
          'error',
          this.messageOf(err, 'No se pudo cargar el historial de versiones.')
        );
        this.versionsDoc.set(null);
      }
    });
  }

  closeVersions(): void {
    this.versionsDoc.set(null);
    this.versions.set([]);
  }

  downloadVersion(version: DocumentVersion): void {
    const doc = this.versionsDoc();
    if (!doc || !version.hasContent) return;
    this.expedienteService.downloadVersion(doc, version).subscribe({
      next: () => this.refresh(),
      error: (err) =>
        this.flashDocumentMessage(
          'error',
          this.messageOf(err, 'No se pudo descargar esa versión.')
        )
    });
  }

  // ── Bitácora general del expediente ────────────────────────────────────

  /** Bitácora documental, más reciente primero (viene del agregado). */
  documentAudit(): DocumentAuditEntry[] {
    return this.expediente()?.documentAudit ?? [];
  }

  auditActionLabel(entry: DocumentAuditEntry): string {
    switch (entry.action) {
      case 'UPLOAD': return 'Carga';
      case 'UPDATE': return 'Edición';
      case 'DOWNLOAD': return 'Descarga';
      default: return 'Visualización';
    }
  }

  /** Resumen "última edición" de un documento para la tabla. */
  lastEditionOf(doc: CaseDocument): string {
    const who = doc.uploadedByName ? ` · ${doc.uploadedByName}` : '';
    return `${this.formatDate(doc.updatedAt)}${who}`;
  }

  dismissDocumentMessage(): void {
    this.documentMessage.set(null);
  }

  private flashDocumentMessage(kind: 'success' | 'error', text: string): void {
    this.documentMessage.set({ kind, text });
    setTimeout(() => {
      if (this.documentMessage()?.text === text) this.documentMessage.set(null);
    }, 6000);
  }

  // ── Render helpers ───────────────────────────────────────────────────

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }

  fileSize(bytes: number | null | undefined): string {
    return formatFileSize(bytes);
  }

  docIcon(doc: CaseDocument): string {
    return documentIconFor(doc.fileType);
  }

  sourceLabelOf(doc: CaseDocument): string {
    if (doc.sourceLabel) return doc.sourceLabel;
    switch (doc.source) {
      case 'START_FORM':
        return 'Formulario inicial';
      case 'ACTIVITY':
        return 'Actividad';
      default:
        return 'Expediente';
    }
  }

  activityStatusLabel(instance: ActivityInstanceResponse): string {
    switch (normalizeActivityStatus(instance.status)) {
      case 'COMPLETED':
        return 'Finalizada';
      case 'IN_PROGRESS':
        return 'En proceso';
      default:
        return 'En espera';
    }
  }

  activityStatusClass(instance: ActivityInstanceResponse): string {
    return normalizeActivityStatus(instance.status).toLowerCase().replace('_', '-');
  }

  private auditIcon(entry: DocumentAuditEntry): string {
    switch (entry.action) {
      case 'UPLOAD': return 'paperclip';
      case 'UPDATE': return 'refresh-cw';
      case 'DOWNLOAD': return 'download';
      default: return 'eye';
    }
  }

  private auditTitle(entry: DocumentAuditEntry): string {
    switch (entry.action) {
      case 'UPLOAD': return 'Documento agregado';
      case 'UPDATE': return 'Documento actualizado';
      case 'DOWNLOAD': return 'Documento descargado';
      default: return 'Documento visualizado';
    }
  }

  private messageOf(err: unknown, fallback: string): string {
    return (
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback
    );
  }

  /** Pretty-prints a form value for read-only rendering. */
  private formatValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (Array.isArray(value)) {
      if (value.length === 0) return '—';
      // File metadata arrays: render names.
      if (value.every((v) => v && typeof v === 'object' && 'name' in (v as object))) {
        return value.map((v) => String((v as { name: unknown }).name)).join(', ');
      }
      return value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /** Schema-ordered label/value list (ad-hoc keys appended at the end). */
  private toFieldEntries(
    definition: FormDefinition | null | undefined,
    data: Record<string, unknown> | null | undefined
  ): FieldEntry[] {
    const values = data ?? {};
    const fields = definition?.fields ?? [];
    const orderedKeys = fields.length
      ? fields.map((f) => f.name).filter((n): n is string => !!n)
      : Object.keys(values);
    const labelByName = new Map(fields.map((f) => [f.name, f.label?.trim() || f.name]));

    const seen = new Set<string>();
    const out: FieldEntry[] = [];
    for (const key of orderedKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: key,
        label: labelByName.get(key) ?? key,
        value: this.formatValue(values[key])
      });
    }
    for (const key of Object.keys(values)) {
      if (seen.has(key)) continue;
      out.push({ name: key, label: key, value: this.formatValue(values[key]) });
    }
    return out;
  }
}
