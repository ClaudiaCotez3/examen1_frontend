import { CommonModule } from '@angular/common';
import {
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { AuthService } from '../../../core/services/auth.service';
import { FormDefinition } from '../../../core/models/form.model';
import { RoleName } from '../../../core/models/auth.model';
import {
  OperatorTask,
  OperatorTaskStatus,
  OperatorTasksResponse
} from '../../../core/models/operator-task.model';
import {
  ApprovalDecision,
  CaseStartForm,
  OperatorService
} from '../../../core/services/operator.service';
import { FormService } from '../../forms/form.service';
import { DynamicFormComponent } from '../../../shared/dynamic-form/dynamic-form.component';
import { AiChatService } from '../../../core/services/ai-chat.service';

interface Column {
  state: OperatorTaskStatus;
  title: string;
  icon: string;
  modifier: string;
}

type LoadStatus = 'idle' | 'loading' | 'error';

/**
 * Simple Kanban board for operators.
 *
 * Columns (Spanish): En espera · En proceso · Finalizadas.
 *
 * Task visibility: the backend returns only tasks where the current user is
 * either the assignee or a candidate, so no client-side filtering by user is
 * needed. A WAITING task with `assignedUserId == null` is AVAILABLE and shows
 * the "Tomar" button; claiming it (start + assign in one atomic call) moves
 * it to "En proceso" owned by the current user.
 *
 * Completion:
 *   - activities with a form → open dynamic form modal, then complete.
 *   - activities without a form → open Aprobar / Rechazar modal with an
 *     optional comment; the decision is sent alongside the complete call.
 */
@Component({
  selector: 'app-task-monitor',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule, DynamicFormComponent],
  templateUrl: './task-monitor.component.html',
  styleUrl: './task-monitor.component.scss'
})
export class TaskMonitorComponent implements OnInit, OnDestroy {
  private readonly operatorService = inject(OperatorService);
  private readonly formService = inject(FormService);
  private readonly authService = inject(AuthService);
  private readonly aiChat = inject(AiChatService);

  /**
   * Live reference to the form modal's `app-dynamic-form`. Used by the
   * voice assistant to read the current values, describe the schema
   * and write back whatever the model returns. Rebinds each time the
   * modal opens (Angular re-creates the form instance).
   */
  @ViewChild('formInstance') private formInstance?: DynamicFormComponent;

  // ── Voice-to-form state ──────────────────────────────────────────────
  /**
   * Per-task mic flow:
   *   idle       → button shows mic icon
   *   listening  → SpeechRecognition is open, accumulating transcript
   *   processing → transcript already sent to /ai/form-fill, waiting
   *
   * No chat panel, no history — the operator taps the mic, dictates,
   * taps again to send. The transcript becomes a one-shot prompt
   * (e.g. "agrega como comentario que el cliente no trajo el DNI" or
   * "marca aprobado y selecciona la opción luz").
   */
  readonly voiceState = signal<'idle' | 'listening' | 'processing'>('idle');
  readonly voiceFeedback = signal<{
    kind: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  readonly hasSpeechSupport = signal<boolean>(false);

  private speechRecognition: any | null = null;
  private speechTranscript = '';
  private voiceFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Light polling so the Kanban surfaces newly cascaded tasks (e.g. a
   * consultor just started a trámite in another tab) without forcing the
   * operator to manually refresh the page. We pull every 8s — short
   * enough to feel "live", long enough to barely register on the server.
   * No-op while a modal (form / approval) is open or a take/complete
   * request is in flight, so the user's in-progress action isn't
   * clobbered by a background refresh.
   */
  private static readonly POLL_INTERVAL_MS = 8000;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  readonly columns: Column[] = [
    { state: 'WAITING',     title: 'En espera',   icon: 'clock',        modifier: 'waiting' },
    { state: 'IN_PROGRESS', title: 'En proceso',  icon: 'loader',       modifier: 'in-progress' },
    { state: 'COMPLETED',   title: 'Finalizadas', icon: 'check-circle', modifier: 'completed' }
  ];

  // Raw data from backend
  readonly tasks = signal<OperatorTasksResponse>({ waiting: [], inProgress: [], completed: [] });
  readonly loadStatus = signal<LoadStatus>('idle');
  readonly errorMessage = signal<string>('');
  readonly pendingActionId = signal<string>('');

  // Dynamic-form modal state (for activities that require a form)
  readonly formOpen = signal<boolean>(false);
  readonly formTask = signal<OperatorTask | null>(null);
  readonly formDefinition = signal<FormDefinition | null>(null);
  readonly formSubmitting = signal<boolean>(false);
  readonly formError = signal<string>('');

  // Approval modal state (for activities without a form)
  readonly approvalOpen = signal<boolean>(false);
  readonly approvalTask = signal<OperatorTask | null>(null);
  readonly approvalDecision = signal<ApprovalDecision>('APPROVED');
  readonly approvalComment = signal<string>('');
  readonly approvalSubmitting = signal<boolean>(false);
  readonly approvalError = signal<string>('');

  // Customer-info side panel — opens on demand inside whichever task
  // modal is open (form or approval). Lazy-loaded the first time the
  // operator clicks "Ver info. del cliente"; cached per task afterward.
  readonly clientInfoOpen = signal<boolean>(false);
  readonly clientInfoLoading = signal<boolean>(false);
  readonly clientInfoError = signal<string>('');
  readonly clientInfoData = signal<CaseStartForm | null>(null);
  private readonly clientInfoCache = new Map<string, CaseStartForm>();

  /** Current operator's id, used to distinguish "my tasks" from "candidates". */
  readonly currentUserId = computed<string>(() => this.authService.currentUser()?.id ?? '');
  readonly currentUserName = computed<string>(() => this.authService.currentUser()?.fullName ?? '');

  ngOnInit(): void {
    this.loadTasks();
    this.pollHandle = setInterval(() => this.refreshIfIdle(),
        TaskMonitorComponent.POLL_INTERVAL_MS);
    this.hasSpeechSupport.set(this.detectSpeechSupport());
  }

  ngOnDestroy(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.abortRecognition();
    if (this.voiceFeedbackTimer !== null) {
      clearTimeout(this.voiceFeedbackTimer);
      this.voiceFeedbackTimer = null;
    }
  }

  /** Skips the refresh if a modal is open or an action is mid-flight. */
  private refreshIfIdle(): void {
    if (this.formOpen() || this.approvalOpen()) return;
    if (this.pendingActionId()) return;
    if (this.loadStatus() === 'loading') return;
    this.loadTasks();
  }

  loadTasks(): void {
    this.loadStatus.set('loading');
    this.errorMessage.set('');
    // Operators see only tasks where they are in the eligible pool or are
    // the claimer (backend-enforced via userId filter). Admin/supervisor
    // callers omit the filter so they keep the full monitoring view.
    const user = this.authService.getCurrentUser();
    const isPureOperator =
      !!user &&
      user.roles.includes(RoleName.OPERATOR) &&
      !user.roles.includes(RoleName.ADMIN) &&
      !user.roles.includes(RoleName.SUPERVISOR);
    const filters = isPureOperator && user ? { userId: user.id } : undefined;

    this.operatorService.getTasks(filters).subscribe({
      next: (response) => {
        this.tasks.set(response);
        this.loadStatus.set('idle');
      },
      error: (err) => this.setError(err, 'No se pudieron cargar las tareas')
    });
  }

  tasksFor(state: OperatorTaskStatus): OperatorTask[] {
    const all = this.tasks();
    if (state === 'WAITING') return all.waiting;
    if (state === 'IN_PROGRESS') return all.inProgress;
    return all.completed;
  }

  // ── Claim (Tomar) ────────────────────────────────────────────────────

  /** True when the task is unclaimed and in WAITING — eligible for "Tomar". */
  isAvailable(task: OperatorTask): boolean {
    return task.status === 'WAITING' && !task.assignedUserId;
  }

  /** True for tasks waiting on an upstream prerequisite or branch decision. */
  isBlocked(task: OperatorTask): boolean {
    return task.status === 'BLOCKED';
  }

  /**
   * True when the WAITING column has at least one BLOCKED card; gates
   * the legend at the bottom of the board.
   */
  hasBlockedTasks(): boolean {
    return this.tasks().waiting.some((t) => this.isBlocked(t));
  }

  /** True when the task is claimed by someone other than the current user. */
  isClaimedByOther(task: OperatorTask): boolean {
    const me = this.currentUserId();
    return !!task.assignedUserId && task.assignedUserId !== me;
  }

  /** True when the current user owns (claimed) the task. */
  isMine(task: OperatorTask): boolean {
    const me = this.currentUserId();
    return !!me && task.assignedUserId === me;
  }

  /** Name of the operator who claimed the task ("Tú" when it's the current user). */
  claimedByLabel(task: OperatorTask): string {
    if (!task.assignedUserId) return '';
    if (this.isMine(task)) return 'Tú';
    return task.assignedUserName || 'Otro operador';
  }

  /**
   * Resolved label for the WAITING-card footer button. Computed in TS so
   * the rendered text never depends on @if branching inside the template —
   * a setup where some Angular AOT outputs collapsed cascaded cards into
   * an icon-only button with no visible label.
   */
  takeLabel(task: OperatorTask): string {
    if (this.isPending(task)) return 'Tomando…';
    if (this.isBlocked(task)) return 'Bloqueada';
    if (this.isClaimedByOther(task)) return `En curso · ${this.claimedByLabel(task)}`;
    return 'Tomar';
  }

  takeIcon(task: OperatorTask): string {
    if (this.isBlocked(task)) return 'lock';
    return this.isClaimedByOther(task) ? 'lock' : 'hand';
  }

  /**
   * "Tomar": atomically claims + starts the task. Moves from En espera →
   * En proceso with `assignedUserId = current user`. On conflict (another
   * operator grabbed it first) we refresh so the UI reflects reality.
   */
  takeTask(task: OperatorTask): void {
    // The button stays visible on every WAITING card now, so the guard has
    // to allow tasks whose claimer is unset OR is already the current user
    // (idempotent re-take). We still bail out if somebody else owns it
    // or if the task is BLOCKED on a prerequisite.
    if (task.status !== 'WAITING') return;
    if (this.isBlocked(task)) return;
    if (this.isClaimedByOther(task)) return;
    const me = this.currentUserId();
    if (!me) {
      this.errorMessage.set('Sesión no disponible. Vuelve a iniciar sesión.');
      return;
    }
    this.pendingActionId.set(task.activityInstanceId);
    this.operatorService.claimAndStart(task.activityInstanceId, me).subscribe({
      next: () => {
        this.pendingActionId.set('');
        this.loadTasks();
      },
      error: (err) => {
        this.pendingActionId.set('');
        // 409 = someone else took it first; just refresh silently
        const status = (err as { status?: number })?.status;
        if (status === 409) {
          this.loadTasks();
          return;
        }
        this.setError(err, 'No se pudo tomar la tarea');
      }
    });
  }

  // ── Completion entry point ──────────────────────────────────────────

  /**
   * Opens the right modal based on whether the activity declares a form.
   * Form-backed activities go through {@link openFormModal}; the rest open
   * the Aprobar / Rechazar dialog.
   */
  completeTask(task: OperatorTask): void {
    if (task.status !== 'IN_PROGRESS') return;
    if (!this.isMine(task)) return;

    this.pendingActionId.set(task.activityInstanceId);
    this.formError.set('');

    this.formService.getFormByActivity(task.activityId).subscribe({
      next: (form) => {
        this.pendingActionId.set('');
        const hasFields = !!form.formDefinition?.fields?.length;
        if (hasFields && form.requiresForm !== false) {
          this.openFormModal(task, form.formDefinition!);
        } else {
          this.openApprovalModal(task);
        }
      },
      error: (err) => {
        this.pendingActionId.set('');
        const status = (err as { status?: number })?.status;
        if (status === 400 || status === 404) {
          // Activity has no form declared → treat as approval task.
          this.openApprovalModal(task);
          return;
        }
        this.setError(err, 'No se pudo cargar el formulario');
      }
    });
  }

  // ── Form modal (FORM_TASK) ──────────────────────────────────────────

  private openFormModal(task: OperatorTask, definition: FormDefinition): void {
    this.formTask.set(task);
    this.formDefinition.set(definition);
    this.formError.set('');
    this.formOpen.set(true);
    this.voiceFeedback.set(null);
  }

  closeFormModal(): void {
    this.abortRecognition();
    this.formOpen.set(false);
    this.formTask.set(null);
    this.formDefinition.set(null);
    this.formSubmitting.set(false);
    this.formError.set('');
    this.voiceFeedback.set(null);
    this.closeClientInfo();
  }

  onFormSubmit(formData: Record<string, unknown>): void {
    const task = this.formTask();
    if (!task) return;
    this.formSubmitting.set(true);
    this.formError.set('');
    this.formService.submitForm(task.activityInstanceId, formData).subscribe({
      next: () => {
        this.formSubmitting.set(false);
        this.closeFormModal();
        // When the activity feeds a DECISION gateway we must capture an
        // approve/reject decision before completing — otherwise the
        // workflow engine has no way to pick a branch and ends up
        // activating both. Form-only completes (linear/parallel/iterative
        // flows) skip this step and complete immediately.
        if (task.requiresDecision) {
          this.openApprovalModal(task);
        } else {
          this.performComplete(task);
        }
      },
      error: (err) => {
        this.formSubmitting.set(false);
        this.formError.set(this.messageOf(err, 'No se pudo enviar el formulario'));
      }
    });
  }

  // ── Approval modal (APPROVAL_TASK) ──────────────────────────────────

  private openApprovalModal(task: OperatorTask): void {
    this.approvalTask.set(task);
    this.approvalDecision.set('APPROVED');
    this.approvalComment.set('');
    this.approvalError.set('');
    this.approvalOpen.set(true);
  }

  closeApprovalModal(): void {
    this.approvalOpen.set(false);
    this.approvalTask.set(null);
    this.approvalComment.set('');
    this.approvalSubmitting.set(false);
    this.approvalError.set('');
    this.closeClientInfo();
  }

  submitApproval(): void {
    const task = this.approvalTask();
    if (!task) return;
    this.approvalSubmitting.set(true);
    this.approvalError.set('');
    this.operatorService
      .completeTask(task.activityInstanceId, {
        userId: this.currentUserId(),
        decision: this.approvalDecision(),
        comment: this.approvalComment()
      })
      .subscribe({
        next: () => {
          this.approvalSubmitting.set(false);
          this.closeApprovalModal();
          this.loadTasks();
        },
        error: (err) => {
          this.approvalSubmitting.set(false);
          this.approvalError.set(this.messageOf(err, 'No se pudo completar la tarea'));
        }
      });
  }

  // ── Shared completion path (used after form submit) ─────────────────

  private performComplete(task: OperatorTask): void {
    this.pendingActionId.set(task.activityInstanceId);
    this.operatorService
      .completeTask(task.activityInstanceId, { userId: this.currentUserId() })
      .subscribe({
        next: () => {
          this.pendingActionId.set('');
          this.loadTasks();
        },
        error: (err) => {
          this.pendingActionId.set('');
          this.setError(err, 'No se pudo completar la tarea');
        }
      });
  }

  // ── Customer info side panel ────────────────────────────────────────

  /**
   * Opens the "Ver info. del cliente" panel for the task that owns the
   * currently open modal. Looks up the start-form snapshot of the
   * trámite and caches it in memory for subsequent opens within the
   * same session.
   */
  openClientInfo(task: OperatorTask | null): void {
    if (!task) return;
    const caseId = task.caseFileId;
    if (!caseId) {
      this.clientInfoError.set('Trámite no resuelto.');
      this.clientInfoOpen.set(true);
      return;
    }
    this.clientInfoOpen.set(true);
    this.clientInfoError.set('');

    const cached = this.clientInfoCache.get(caseId);
    if (cached) {
      this.clientInfoData.set(cached);
      return;
    }
    this.clientInfoLoading.set(true);
    this.clientInfoData.set(null);
    this.operatorService.getCaseStartForm(caseId).subscribe({
      next: (info) => {
        this.clientInfoLoading.set(false);
        this.clientInfoCache.set(caseId, info);
        this.clientInfoData.set(info);
      },
      error: (err) => {
        this.clientInfoLoading.set(false);
        this.clientInfoError.set(this.messageOf(err, 'No se pudo cargar la información del cliente.'));
      }
    });
  }

  closeClientInfo(): void {
    this.clientInfoOpen.set(false);
    this.clientInfoData.set(null);
    this.clientInfoError.set('');
  }

  /** Pretty-prints a start-form value for read-only rendering in the side panel. */
  formatClientValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /** Resolves a friendly label for a field key, falling back to the key itself. */
  clientFieldLabel(name: string): string {
    const def = this.clientInfoData()?.definition;
    const field = def?.fields?.find((f) => f.name === name);
    return field?.label?.trim() || name;
  }

  /** Stable-ordered list of [name, value] pairs to render in the panel. */
  clientFieldEntries(): Array<{ name: string; label: string; value: string }> {
    const info = this.clientInfoData();
    if (!info) return [];
    const data = info.data ?? {};
    const def = info.definition;
    // Use the schema's order when available so the panel mirrors the form.
    const orderedKeys = def?.fields?.length
      ? def.fields.map((f) => f.name).filter((n): n is string => !!n)
      : Object.keys(data);
    const seen = new Set<string>();
    const out: Array<{ name: string; label: string; value: string }> = [];
    for (const key of orderedKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: key,
        label: this.clientFieldLabel(key),
        value: this.formatClientValue(data[key])
      });
    }
    // Surface ad-hoc keys that ended up in `data` but aren't on the schema
    // (e.g. legacy cases) so nothing is silently dropped.
    for (const key of Object.keys(data)) {
      if (seen.has(key)) continue;
      out.push({
        name: key,
        label: key,
        value: this.formatClientValue(data[key])
      });
    }
    return out;
  }

  // ── UI helpers ──────────────────────────────────────────────────────

  isPending(task: OperatorTask): boolean {
    return this.pendingActionId() === task.activityInstanceId;
  }

  dismissError(): void {
    this.errorMessage.set('');
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }

  private messageOf(err: unknown, fallback: string): string {
    return (
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback
    );
  }

  private setError(err: unknown, fallback: string): void {
    this.errorMessage.set(this.messageOf(err, fallback));
    this.loadStatus.set('error');
  }

  // ── Voice fill ─────────────────────────────────────────────────────

  /**
   * Single-button mic UX:
   *   - tap when idle      → start listening
   *   - tap while listening → stop, send transcript to /ai/form-fill
   *   - cannot tap while processing
   */
  toggleVoiceFill(): void {
    if (this.voiceState() === 'processing') return;
    if (this.voiceState() === 'listening') {
      this.stopRecognitionAndSend();
      return;
    }
    this.startRecognition();
  }

  dismissVoiceFeedback(): void {
    this.voiceFeedback.set(null);
    if (this.voiceFeedbackTimer !== null) {
      clearTimeout(this.voiceFeedbackTimer);
      this.voiceFeedbackTimer = null;
    }
  }

  private startRecognition(): void {
    const Ctor = this.getSpeechCtor();
    if (!Ctor) {
      this.flashFeedback('error', 'Tu navegador no soporta dictado por voz.');
      return;
    }
    let recognition: any;
    try {
      recognition = new Ctor();
    } catch {
      this.flashFeedback('error', 'No se pudo inicializar el micrófono.');
      return;
    }
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;

    this.speechTranscript = '';
    this.voiceFeedback.set(null);

    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = (event.results[i][0]?.transcript ?? '').trim();
        if (event.results[i].isFinal && transcript) {
          this.speechTranscript +=
            (this.speechTranscript ? ' ' : '') + transcript;
        }
      }
    };

    recognition.onerror = (event: any) => {
      const code = event?.error ?? 'desconocido';
      const msg =
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Permite el acceso al micrófono para dictar.'
          : code === 'no-speech'
          ? 'No detecté audio. Intenta de nuevo.'
          : `Error de dictado: ${code}`;
      this.voiceState.set('idle');
      this.speechRecognition = null;
      this.flashFeedback('error', msg);
    };

    recognition.onend = () => {
      // If we ended without an explicit stopAndSend (e.g. timeout),
      // make sure the UI returns to idle. The stopAndSend handler
      // overrides this by setting state to 'processing' first.
      if (this.voiceState() === 'listening') {
        this.voiceState.set('idle');
      }
      this.speechRecognition = null;
    };

    try {
      recognition.start();
    } catch {
      this.flashFeedback('error', 'No se pudo iniciar el dictado.');
      return;
    }
    this.speechRecognition = recognition;
    this.voiceState.set('listening');
  }

  private stopRecognitionAndSend(): void {
    const rec = this.speechRecognition;
    this.voiceState.set('processing');
    try {
      rec?.stop();
    } catch {
      /* ignore */
    }

    // Give the recognizer a beat to flush the final result.
    setTimeout(() => {
      const transcript = this.speechTranscript.trim();
      this.speechTranscript = '';
      if (!transcript) {
        this.voiceState.set('idle');
        this.flashFeedback('error', 'No detecté audio. Intenta de nuevo.');
        return;
      }
      this.dispatchVoicePrompt(transcript);
    }, 300);
  }

  private dispatchVoicePrompt(transcript: string): void {
    if (!this.formInstance) {
      this.voiceState.set('idle');
      this.flashFeedback('error', 'No hay un formulario abierto.');
      return;
    }
    const schema = this.formInstance.describeFields();
    const currentValues = this.formInstance.readCurrentValues();

    this.aiChat.fillFormSilent(transcript, schema, currentValues).subscribe({
      next: (resp) => {
        this.voiceState.set('idle');
        const filledKeys = Object.keys(resp.values ?? {});
        if (filledKeys.length > 0) {
          this.formInstance!.applyAssistantValues(resp.values);
          const summary =
            resp.reply ||
            `Listo, llené ${filledKeys.length} ${filledKeys.length === 1 ? 'campo' : 'campos'}.`;
          this.flashFeedback('success', summary, 5000);
        } else {
          this.flashFeedback(
            'info',
            resp.reply || 'No identifiqué qué llenar. ¿Puedes repetirlo?',
            5000
          );
        }
      },
      error: (err) => {
        this.voiceState.set('idle');
        const detail =
          (err as { error?: { detail?: string } })?.error?.detail ??
          'No se pudo contactar al asistente.';
        this.flashFeedback('error', detail);
      }
    });
  }

  private abortRecognition(): void {
    const rec = this.speechRecognition;
    this.speechRecognition = null;
    this.speechTranscript = '';
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    if (this.voiceState() !== 'idle') this.voiceState.set('idle');
  }

  private flashFeedback(
    kind: 'success' | 'error' | 'info',
    text: string,
    ttlMs = 4000
  ): void {
    this.voiceFeedback.set({ kind, text });
    if (this.voiceFeedbackTimer !== null) {
      clearTimeout(this.voiceFeedbackTimer);
    }
    this.voiceFeedbackTimer = setTimeout(() => {
      this.voiceFeedback.set(null);
      this.voiceFeedbackTimer = null;
    }, ttlMs);
  }

  private detectSpeechSupport(): boolean {
    return !!this.getSpeechCtor();
  }

  private getSpeechCtor(): { new (): any } | null {
    if (typeof window === 'undefined') return null;
    const w = window as any;
    return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
      | { new (): any }
      | null;
  }
}
