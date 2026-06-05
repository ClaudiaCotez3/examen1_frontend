import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  inject,
  signal
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { CaseDocument } from '../../../core/models/document.model';
import { ExpedienteService } from '../../../core/services/expediente.service';

/** API global que inyecta el script api.js del Document Server. */
declare const DocsAPI: {
  DocEditor: new (elementId: string, config: Record<string, unknown>) => {
    destroyEditor(): void;
  };
};

/** Extensiones que se editan con OnlyOffice (espejo del backend). */
export const ONLYOFFICE_EDITABLE = new Set(['docx', 'xlsx', 'pptx']);

export function isOnlyOfficeFormat(fileName: string | null | undefined): boolean {
  const name = (fileName ?? '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return ONLYOFFICE_EDITABLE.has(ext);
}

/**
 * Gestión Documental — editor empresarial OnlyOffice embebido.
 *
 * Para .docx / .xlsx / .pptx el documento se abre con el OnlyOffice
 * Document Server (Docker, puerto 8083): fidelidad total de formato y
 * CO-EDICIÓN real (cursores, cambios en vivo) — todos los usuarios que
 * abren la MISMA versión comparten la sala del DS (document.key).
 *
 * Flujo: el backend emite la configuración FIRMADA (secreto propio de
 * OnlyOffice) con la URL de descarga tokenizada y el callbackUrl; al
 * cerrar la edición, el DS notifica al backend, que persiste el binario
 * como NUEVA VERSIÓN con el versionado + auditoría existentes.
 *
 * El modo (edición/lectura) viene resuelto del backend según los
 * permisos READER/EDITOR del usuario sobre el expediente.
 */
@Component({
  selector: 'app-onlyoffice-editor',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './onlyoffice-editor.component.html',
  styleUrl: './onlyoffice-editor.component.scss'
})
export class OnlyofficeEditorComponent implements OnInit, OnDestroy {
  @Input({ required: true }) caseFileId!: string;
  @Input({ required: true }) doc!: CaseDocument;
  /** true al cerrar: el padre refresca (el DS pudo haber guardado versión). */
  @Output() closed = new EventEmitter<boolean>();

  private readonly expedienteService = inject(ExpedienteService);

  readonly loading = signal<boolean>(true);
  readonly error = signal<string>('');
  readonly mode = signal<'edit' | 'view'>('view');

  private editor: { destroyEditor(): void } | null = null;
  /** Promesa compartida del script api.js — se carga una sola vez. */
  private static apiScript: Promise<void> | null = null;

  ngOnInit(): void {
    this.expedienteService
      .getOnlyOfficeConfig(this.caseFileId, this.doc.id)
      .subscribe({
        next: async ({ documentServerUrl, config }) => {
          try {
            await OnlyofficeEditorComponent.loadApiScript(documentServerUrl);
            const editorConfig = config['editorConfig'] as
              | { mode?: string }
              | undefined;
            this.mode.set(editorConfig?.mode === 'edit' ? 'edit' : 'view');
            this.editor = new DocsAPI.DocEditor('onlyoffice-container', config);
            this.loading.set(false);
          } catch (err) {
            console.error('[onlyoffice] no se pudo montar el editor', err);
            this.error.set(
              'No se pudo conectar con el servidor de documentos OnlyOffice. ' +
                'Verifica que esté corriendo (docker compose -f docker-compose.onlyoffice.yml up -d).'
            );
            this.loading.set(false);
          }
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(
            (err as { error?: { message?: string } })?.error?.message ??
              'No se pudo obtener la configuración del editor.'
          );
        }
      });
  }

  ngOnDestroy(): void {
    try {
      this.editor?.destroyEditor();
    } catch {
      /* el DS ya pudo haber limpiado el iframe */
    }
    this.editor = null;
  }

  close(): void {
    // El guardado lo hace el Document Server vía callback (asíncrono,
    // segundos después del último cambio) — el padre refresca igualmente.
    this.closed.emit(true);
  }

  /** Inyecta api.js del Document Server una sola vez por sesión. */
  private static loadApiScript(documentServerUrl: string): Promise<void> {
    if (typeof DocsAPI !== 'undefined') return Promise.resolve();
    if (this.apiScript) return this.apiScript;
    this.apiScript = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${documentServerUrl}/web-apps/apps/api/documents/api.js`;
      script.onload = () => resolve();
      script.onerror = () => {
        this.apiScript = null;
        reject(new Error('api.js no disponible'));
      };
      document.head.appendChild(script);
    });
    return this.apiScript;
  }
}
