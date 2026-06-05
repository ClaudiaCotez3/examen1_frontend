import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { LucideAngularModule } from 'lucide-angular';
import { Subscription } from 'rxjs';
import * as XLSX from 'xlsx';
import * as mammoth from 'mammoth';
import {
  Document as DocxDocument,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from 'docx';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { CaseDocument } from '../../../core/models/document.model';
import { DocCollabService } from '../../../core/services/doc-collab.service';
import { ExpedienteService } from '../../../core/services/expediente.service';

/** Modo del editor según el formato del documento. */
type EditorMode = 'text' | 'rich' | 'sheet' | 'pdf' | 'replace';

interface PdfAnnotation {
  page: number;
  text: string;
}

/**
 * Gestión Documental — editor de documentos DENTRO del sistema.
 *
 * Cada formato se edita con el motor adecuado, sin salir de la app:
 *   - Excel (.xlsx/.xls/.csv) → grilla editable (SheetJS), exporta xlsx/csv real.
 *   - Word (.docx)            → editor de texto enriquecido (mammoth lee el
 *                               docx; al guardar se genera un .docx REAL con
 *                               la librería `docx` — round-trip editable).
 *   - PDF                     → vista embebida + anotaciones de texto por
 *                               página estampadas con pdf-lib.
 *   - Texto (.txt/.json/.xml…)→ editor de texto plano.
 *   - Otros formatos          → reemplazo guiado del archivo.
 *
 * COLABORATIVO: al abrir un documento entras a su sala (mismo broker STOMP
 * del diseñador BPMN). La presencia se muestra como chips ("Editando:
 * fulano@…") y cada cambio difunde el estado completo del editor con
 * debounce — último-en-escribir gana, igual que el diagrama colaborativo.
 * El binario se persiste como NUEVA VERSIÓN (con nota de cambio para la
 * bitácora) solo al pulsar Guardar.
 */
@Component({
  selector: 'app-doc-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './doc-editor.component.html',
  styleUrl: './doc-editor.component.scss'
})
export class DocEditorComponent implements OnInit, OnDestroy {
  @Input({ required: true }) caseFileId!: string;
  @Input({ required: true }) doc!: CaseDocument;
  /** true cuando se guardó una nueva versión (el padre refresca). */
  @Output() closed = new EventEmitter<boolean>();

  @ViewChild('richArea') richArea?: ElementRef<HTMLDivElement>;

  private readonly expedienteService = inject(ExpedienteService);
  private readonly collab = inject(DocCollabService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly mode = signal<EditorMode>('text');
  readonly loading = signal<boolean>(true);
  readonly saving = signal<boolean>(false);
  readonly error = signal<string>('');
  readonly note = signal<string>('');

  // Co-edición
  readonly editors = signal<string[]>([]);
  private collabSubs: Subscription[] = [];
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private applyingRemote = false;

  // ── Estado por modo ──────────────────────────────────────────────────
  readonly textContent = signal<string>('');
  /** Matriz de la hoja (primera hoja del libro). */
  readonly sheetRows = signal<string[][]>([]);
  readonly richHtml = signal<string>('');
  readonly pdfPreviewUrl = signal<SafeResourceUrl | null>(null);
  private rawPdfUrl: string | null = null;
  readonly pdfPageCount = signal<number>(0);
  readonly pdfAnnotations = signal<PdfAnnotation[]>([]);
  readonly pdfNewText = signal<string>('');
  readonly pdfNewPage = signal<number>(1);
  readonly replaceFile = signal<File | null>(null);

  private originalBytes: ArrayBuffer | null = null;
  private sheetIsCsv = false;

  // ── Ciclo de vida ────────────────────────────────────────────────────

  ngOnInit(): void {
    this.detectMode();
    this.loadContent();
    this.joinCollab();
  }

  ngOnDestroy(): void {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.collabSubs.forEach((s) => s.unsubscribe());
    this.collab.leaveDocument();
    if (this.rawPdfUrl) URL.revokeObjectURL(this.rawPdfUrl);
  }

  close(saved = false): void {
    this.closed.emit(saved);
  }

  // ── Detección de formato ─────────────────────────────────────────────

  private detectMode(): void {
    const name = (this.doc.fileName || '').toLowerCase();
    const mime = (this.doc.fileType || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop()! : '';

    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv'
        || mime.includes('spreadsheet') || mime.includes('excel')) {
      this.sheetIsCsv = ext === 'csv';
      this.mode.set('sheet');
    } else if (ext === 'docx' || mime.includes('wordprocessingml')) {
      this.mode.set('rich');
    } else if (ext === 'pdf' || mime === 'application/pdf') {
      this.mode.set('pdf');
    } else if (
      mime.startsWith('text/') ||
      ['txt', 'json', 'xml', 'md', 'log', 'html', 'yml', 'yaml'].includes(ext)
    ) {
      this.mode.set('text');
    } else {
      this.mode.set('replace');
    }
  }

  modeLabel(): string {
    switch (this.mode()) {
      case 'sheet': return 'Hoja de cálculo';
      case 'rich': return 'Documento de texto (Word)';
      case 'pdf': return 'PDF · anotaciones';
      case 'text': return 'Texto plano';
      default: return 'Reemplazo de archivo';
    }
  }

  // ── Carga del contenido ──────────────────────────────────────────────

  private loadContent(): void {
    if (!this.doc.hasContent) {
      this.loading.set(false);
      if (this.mode() !== 'replace') this.mode.set('replace');
      return;
    }
    this.expedienteService.getContentBlob(this.doc).subscribe({
      next: async (blob) => {
        try {
          this.originalBytes = await blob.arrayBuffer();
          await this.parseContent(blob);
          this.loading.set(false);
        } catch (err) {
          console.warn('[doc-editor] parse failed, fallback a reemplazo', err);
          this.mode.set('replace');
          this.loading.set(false);
        }
      },
      error: () => {
        this.error.set('No se pudo cargar el contenido del documento.');
        this.loading.set(false);
      }
    });
  }

  private async parseContent(blob: Blob): Promise<void> {
    const bytes = this.originalBytes!;
    switch (this.mode()) {
      case 'text': {
        this.textContent.set(await blob.text());
        break;
      }
      case 'sheet': {
        const workbook = XLSX.read(bytes, { type: 'array' });
        const first = workbook.Sheets[workbook.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(first, {
          header: 1,
          defval: ''
        });
        const rows = aoa.map((row) => row.map((cell) => String(cell ?? '')));
        if (rows.length === 0) rows.push(['']);
        // Normaliza el ancho de todas las filas.
        const width = Math.max(...rows.map((r) => r.length), 1);
        this.sheetRows.set(rows.map((r) => {
          const copy = [...r];
          while (copy.length < width) copy.push('');
          return copy;
        }));
        break;
      }
      case 'rich': {
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
        this.richHtml.set(result.value || '<p></p>');
        break;
      }
      case 'pdf': {
        const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
        this.pdfPageCount.set(pdf.getPageCount());
        this.rawPdfUrl =
          URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        this.pdfPreviewUrl.set(
          this.sanitizer.bypassSecurityTrustResourceUrl(this.rawPdfUrl)
        );
        break;
      }
      default:
        break;
    }
  }

  // ── Co-edición (presencia + sync de contenido) ───────────────────────

  private joinCollab(): void {
    this.collab
      .joinDocument(this.doc.id)
      .then(() => {
        this.collabSubs.push(
          this.collab.presence$.subscribe((p) => this.editors.set(p.emails)),
          this.collab.content$.subscribe((event) => {
            if (event.senderEmail === this.collab.selfEmail) return;
            this.applyRemoteContent(event.mode, event.content);
          })
        );
      })
      .catch(() => {
        // Sin colaboración (socket caído) el editor sigue funcionando solo.
      });
  }

  private applyRemoteContent(mode: string, content: string): void {
    this.applyingRemote = true;
    try {
      if (mode === 'text' && this.mode() === 'text') {
        this.textContent.set(content);
      } else if (mode === 'sheet' && this.mode() === 'sheet') {
        const rows = JSON.parse(content) as string[][];
        if (Array.isArray(rows)) this.sheetRows.set(rows);
      } else if (mode === 'rich' && this.mode() === 'rich') {
        this.richHtml.set(content);
        const area = this.richArea?.nativeElement;
        if (area && area.innerHTML !== content) {
          area.innerHTML = content;
        }
      }
    } finally {
      this.applyingRemote = false;
    }
  }

  /** Difunde el estado local con debounce (600 ms, como el diseñador). */
  private scheduleBroadcast(): void {
    if (this.applyingRemote) return;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const mode = this.mode();
      if (mode === 'text') {
        this.collab.sendContent('text', this.textContent());
      } else if (mode === 'sheet') {
        this.collab.sendContent('sheet', JSON.stringify(this.sheetRows()));
      } else if (mode === 'rich') {
        this.collab.sendContent('rich', this.richHtml());
      }
    }, 600);
  }

  otherEditors(): string[] {
    const self = this.collab.selfEmail;
    return this.editors().filter((e) => e !== self);
  }

  // ── Handlers por modo ────────────────────────────────────────────────

  onTextChange(value: string): void {
    this.textContent.set(value);
    this.scheduleBroadcast();
  }

  onCellChange(rowIndex: number, colIndex: number, value: string): void {
    const rows = this.sheetRows().map((r) => [...r]);
    rows[rowIndex][colIndex] = value;
    this.sheetRows.set(rows);
    this.scheduleBroadcast();
  }

  addRow(): void {
    const rows = this.sheetRows();
    const width = rows[0]?.length ?? 1;
    this.sheetRows.set([...rows, new Array(width).fill('')]);
    this.scheduleBroadcast();
  }

  addColumn(): void {
    this.sheetRows.set(this.sheetRows().map((r) => [...r, '']));
    this.scheduleBroadcast();
  }

  removeRow(index: number): void {
    const rows = this.sheetRows();
    if (rows.length <= 1) return;
    this.sheetRows.set(rows.filter((_, i) => i !== index));
    this.scheduleBroadcast();
  }

  onRichInput(): void {
    const area = this.richArea?.nativeElement;
    if (!area) return;
    this.richHtml.set(area.innerHTML);
    this.scheduleBroadcast();
  }

  /** Toolbar del editor enriquecido (negrita, cursiva, listas…). */
  format(command: string, value?: string): void {
    // execCommand sigue siendo el estándar de facto para contenteditable.
    document.execCommand(command, false, value);
    this.onRichInput();
  }

  addPdfAnnotation(): void {
    const text = this.pdfNewText().trim();
    if (!text) return;
    const page = Math.min(
      Math.max(1, Math.floor(this.pdfNewPage() || 1)),
      this.pdfPageCount() || 1
    );
    this.pdfAnnotations.update((list) => [...list, { page, text }]);
    this.pdfNewText.set('');
  }

  removePdfAnnotation(index: number): void {
    this.pdfAnnotations.update((list) => list.filter((_, i) => i !== index));
  }

  onReplaceFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.replaceFile.set(input.files?.[0] ?? null);
    input.value = '';
  }

  canSave(): boolean {
    switch (this.mode()) {
      case 'pdf':
        return this.pdfAnnotations().length > 0;
      case 'replace':
        return !!this.replaceFile();
      default:
        return true;
    }
  }

  // ── Guardar nueva versión ────────────────────────────────────────────

  async save(): Promise<void> {
    if (this.saving() || !this.canSave()) return;
    this.saving.set(true);
    this.error.set('');
    try {
      const file = await this.buildFile();
      this.expedienteService
        .updateDocument(this.caseFileId, this.doc.id, file, this.note())
        .subscribe({
          next: () => {
            this.saving.set(false);
            this.close(true);
          },
          error: (err) => {
            this.saving.set(false);
            this.error.set(
              (err as { error?: { message?: string } })?.error?.message ??
                'No se pudo guardar la nueva versión.'
            );
          }
        });
    } catch (err) {
      this.saving.set(false);
      this.error.set('No se pudo generar el archivo editado.');
      console.error('[doc-editor] build file failed', err);
    }
  }

  private async buildFile(): Promise<File> {
    const name = this.doc.fileName || 'documento';
    switch (this.mode()) {
      case 'text': {
        return new File([this.textContent()], name, {
          type: this.doc.fileType || 'text/plain'
        });
      }
      case 'sheet': {
        const sheet = XLSX.utils.aoa_to_sheet(this.sheetRows());
        if (this.sheetIsCsv) {
          const csv = XLSX.utils.sheet_to_csv(sheet);
          return new File([csv], name, { type: 'text/csv' });
        }
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, 'Hoja1');
        const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
        return new File([bytes], this.ensureExt(name, 'xlsx'), {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
      }
      case 'rich': {
        const blob = await this.htmlToDocx(this.richHtml());
        return new File([blob], this.ensureExt(name, 'docx'), {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
      }
      case 'pdf': {
        const bytes = await this.stampPdfAnnotations();
        return new File([bytes as BlobPart], name, { type: 'application/pdf' });
      }
      default: {
        const file = this.replaceFile();
        if (!file) throw new Error('Sin archivo de reemplazo');
        return file;
      }
    }
  }

  private ensureExt(name: string, ext: string): string {
    return name.toLowerCase().endsWith(`.${ext}`)
      ? name
      : `${name.replace(/\.[^.]+$/, '')}.${ext}`;
  }

  // ── HTML → docx real (round-trip editable) ───────────────────────────

  /**
   * Convierte el HTML del editor a un .docx REAL (párrafos, encabezados,
   * negrita/cursiva/subrayado y listas) usando la librería `docx`. Al ser
   * OOXML genuino, mammoth puede volver a abrirlo — el ciclo
   * editar→guardar→editar no se rompe.
   */
  private async htmlToDocx(html: string): Promise<Blob> {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const paragraphs: Paragraph[] = [];

    const runsOf = (node: Node, inherited: {
      bold?: boolean; italics?: boolean; underline?: boolean;
    }): TextRun[] => {
      const runs: TextRun[] = [];
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent ?? '';
          if (text.length > 0) {
            runs.push(new TextRun({
              text,
              bold: inherited.bold,
              italics: inherited.italics,
              underline: inherited.underline ? {} : undefined
            }));
          }
          return;
        }
        if (!(child instanceof Element)) return;
        const tag = child.tagName.toLowerCase();
        if (tag === 'br') {
          runs.push(new TextRun({ text: '', break: 1 }));
          return;
        }
        runs.push(...runsOf(child, {
          bold: inherited.bold || tag === 'b' || tag === 'strong',
          italics: inherited.italics || tag === 'i' || tag === 'em',
          underline: inherited.underline || tag === 'u'
        }));
      });
      return runs;
    };

    const pushBlock = (el: Element): void => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        el.querySelectorAll(':scope > li').forEach((li) => {
          paragraphs.push(new Paragraph({
            children: runsOf(li, {}),
            bullet: { level: 0 }
          }));
        });
        return;
      }
      const heading =
        tag === 'h1' ? HeadingLevel.HEADING_1 :
        tag === 'h2' ? HeadingLevel.HEADING_2 :
        tag === 'h3' ? HeadingLevel.HEADING_3 : undefined;
      const runs = runsOf(el, {});
      paragraphs.push(new Paragraph({ children: runs, heading }));
    };

    const body = parsed.body;
    if (body.children.length === 0) {
      paragraphs.push(new Paragraph({ children: runsOf(body, {}) }));
    } else {
      Array.from(body.children).forEach(pushBlock);
    }
    if (paragraphs.length === 0) paragraphs.push(new Paragraph(''));

    const docx = new DocxDocument({ sections: [{ children: paragraphs }] });
    return Packer.toBlob(docx);
  }

  // ── PDF: estampar anotaciones ────────────────────────────────────────

  private async stampPdfAnnotations(): Promise<Uint8Array> {
    const pdf = await PDFDocument.load(this.originalBytes!, {
      ignoreEncryption: true
    });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const byPage = new Map<number, PdfAnnotation[]>();
    for (const a of this.pdfAnnotations()) {
      const list = byPage.get(a.page) ?? [];
      list.push(a);
      byPage.set(a.page, list);
    }
    for (const [pageNumber, annotations] of byPage) {
      const page = pdf.getPage(pageNumber - 1);
      const { width, height } = page.getSize();
      annotations.forEach((annotation, index) => {
        const boxHeight = 24;
        const y = height - 20 - index * (boxHeight + 6);
        page.drawRectangle({
          x: 14,
          y: y - 6,
          width: width - 28,
          height: boxHeight,
          color: rgb(1, 0.973, 0.764), // amarillo nota (#fff8c3 aprox)
          opacity: 0.92,
          borderColor: rgb(0.85, 0.65, 0.13),
          borderWidth: 0.8
        });
        page.drawText(annotation.text.slice(0, 160), {
          x: 20,
          y: y + 2,
          size: 9,
          font,
          color: rgb(0.45, 0.29, 0.03)
        });
      });
    }
    return pdf.save();
  }
}
