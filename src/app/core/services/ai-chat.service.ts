import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { tap } from 'rxjs/operators';

import { environment } from '../../../environments/environment';

// ─────────────────────────────────────────────────────────────────────
// Wire types — must mirror ai-service/main.py (ChatRequest/Response)
// and ai_chat.py (operation schema).
// ─────────────────────────────────────────────────────────────────────

export type DiagramOpKind =
  | 'addLane'
  | 'addNode'
  | 'renameNode'
  | 'removeNode'
  | 'connect'
  | 'disconnect'
  | 'setBranchLabel'
  | 'assignUsers';

export type DiagramNodeType = 'TASK' | 'START' | 'END' | 'DECISION';

export interface DiagramOp {
  op: DiagramOpKind;
  name?: string;
  newName?: string;
  laneName?: string;
  afterNode?: string;
  nodeType?: DiagramNodeType;
  fromNode?: string;
  toNode?: string;
  branchLabel?: 'APROBADO' | 'RECHAZADO';
  /** For assignUsers: list of operator names to attach to `name`. */
  userNames?: string[];
  target?: string;
}

export interface DiagramSnapshotLane {
  id: string;
  name: string;
}

export interface DiagramSnapshotNode {
  id: string;
  name: string;
  type: string;
  laneId: string | null;
  laneName: string | null;
}

export interface DiagramSnapshotEdge {
  id: string;
  source: string;
  target: string;
  sourceName: string;
  targetName: string;
  branchLabel: string | null;
}

export interface DiagramSnapshotOperator {
  name: string;
  email: string;
}

export interface DiagramSnapshot {
  lanes: DiagramSnapshotLane[];
  nodes: DiagramSnapshotNode[];
  edges: DiagramSnapshotEdge[];
  /** Operators the AI can assign to tasks via `assignUsers`. */
  availableOperators?: DiagramSnapshotOperator[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ops?: DiagramOp[];
  /** Local timestamp for the bubble timestamp. */
  ts: number;
}

interface ChatResponse {
  reply: string;
  operations: DiagramOp[];
}

interface FormFillResponse {
  reply: string;
  values: Record<string, unknown>;
}

/**
 * Lightweight schema used by the form-fill mode. The shape mirrors the
 * subset of `FormDefinition` the AI needs: field name, label and type.
 * Keeps the assistant prompt small even for big forms.
 */
export interface FormFieldDescriptor {
  name: string;
  label: string;
  type: string;
  /** Available choices for select/radio fields. */
  options?: string[];
}

/**
 * Frontend wrapper around the FastAPI assistant.
 *
 * The service holds:
 *   - a stable `sessionId` so the backend can keep conversation memory.
 *   - the visible chat history (`messages` signal — bound by the panel).
 *   - a per-component "designer adapter" registered by the policy
 *     designer. The adapter exposes (a) how to read the current diagram
 *     for the system prompt and (b) how to apply the operations the
 *     model returns. Components other than the designer don't register,
 *     so calls made elsewhere fall back to a chat-only conversation.
 */
@Injectable({ providedIn: 'root' })
export class AiChatService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.aiBaseUrl}/ai/chat`;
  private readonly formFillUrl = `${environment.aiBaseUrl}/ai/form-fill`;

  /** Random UUID created on first instantiation. Survives navigation
   *  inside the SPA but resets on full reload — fine for short
   *  designer sessions and keeps memory bounded. */
  readonly sessionId = crypto.randomUUID();

  readonly messages = signal<ChatMessage[]>([]);
  readonly sending = signal<boolean>(false);
  readonly errorMessage = signal<string>('');

  /**
   * Human-friendly label for the diagram the registered designer is
   * currently editing (e.g. policy name). The chat panel shows it in
   * the header so the user understands which canvas the assistant is
   * about to mutate. Empty string means "no specific context".
   */
  readonly contextLabel = signal<string>('');

  /** Designer adapter — null when no designer is mounted. */
  private adapter: DesignerAdapter | null = null;
  /** Form-fill adapter — null when no operator form is open. */
  private formAdapter: FormAssistantAdapter | null = null;

  /** Stream the panel can subscribe to in case it wants to react to
   *  model-side events (currently unused; kept for future extensions
   *  like streamed tokens). */
  readonly events$ = new Subject<ChatMessage>();

  registerDesigner(adapter: DesignerAdapter): void {
    this.adapter = adapter;
  }

  unregisterDesigner(adapter: DesignerAdapter): void {
    if (this.adapter === adapter) {
      this.adapter = null;
    }
  }

  isDesignerActive(): boolean {
    return this.adapter !== null;
  }

  registerFormAssistant(adapter: FormAssistantAdapter): void {
    this.formAdapter = adapter;
  }

  unregisterFormAssistant(adapter: FormAssistantAdapter): void {
    if (this.formAdapter === adapter) {
      this.formAdapter = null;
    }
  }

  isFormAssistantActive(): boolean {
    return this.formAdapter !== null;
  }

  reset(): void {
    this.messages.set([]);
    this.errorMessage.set('');
    this.http.post(`${this.base}/reset`, { sessionId: this.sessionId }).subscribe({
      next: () => {},
      error: () => {} // best-effort; the in-memory store is per-session anyway
    });
  }

  /**
   * Sends a user turn to the assistant. Pulls the diagram snapshot
   * from the registered adapter (when available) so the model knows
   * exactly which nodes / lanes / edges exist right now. Applies the
   * resulting operations through the adapter.
   *
   * `image` is an optional attachment (base64 data URL + mime type)
   * that gets forwarded to Claude as a vision input. The model can use
   * it to derive operations from a sketch/croquis the admin uploaded.
   */
  send(
    message: string,
    image?: { dataUrl: string; mimeType: string } | null
  ): void {
    const trimmed = message.trim();
    if (!trimmed && !image) return;
    if (this.sending()) return;

    // Form-fill mode wins when an operator has the form modal open.
    // It routes to a different backend endpoint and applies the
    // returned `values` map directly onto the form's controls.
    if (this.formAdapter) {
      this.sendFormFill(trimmed, image ?? null);
      return;
    }

    const diagram = this.adapter?.getDiagramState() ?? {
      lanes: [],
      nodes: [],
      edges: []
    };

    const userTurn: ChatMessage = {
      role: 'user',
      text: trimmed || (image ? '(imagen adjunta)' : ''),
      ts: Date.now()
    };
    this.messages.update((m) => [...m, userTurn]);
    this.events$.next(userTurn);

    this.sending.set(true);
    this.errorMessage.set('');

    const body: Record<string, unknown> = {
      sessionId: this.sessionId,
      message: trimmed,
      diagram
    };
    if (image?.dataUrl && image?.mimeType) {
      // Strip the `data:image/png;base64,` prefix the FileReader gave us;
      // Anthropic's image block expects the raw base64 payload.
      const commaIdx = image.dataUrl.indexOf(',');
      body['imageData'] =
        commaIdx >= 0 ? image.dataUrl.slice(commaIdx + 1) : image.dataUrl;
      body['imageMimeType'] = image.mimeType;
    }

    this.http
      .post<ChatResponse>(this.base, body)
      .pipe(
        tap((resp) => {
          const assistant: ChatMessage = {
            role: 'assistant',
            text: resp.reply,
            ops: resp.operations,
            ts: Date.now()
          };
          this.messages.update((m) => [...m, assistant]);
          this.events$.next(assistant);
          if (this.adapter && resp.operations?.length) {
            this.adapter.applyOperations(resp.operations);
          } else if (!this.adapter && resp.operations?.length) {
            // Surface a hint so the user knows why nothing changed.
            const hint: ChatMessage = {
              role: 'system',
              text:
                'Abre el Diseñador de políticas para que pueda aplicar los cambios sobre el lienzo.',
              ts: Date.now()
            };
            this.messages.update((m) => [...m, hint]);
          }
        })
      )
      .subscribe({
        next: () => this.sending.set(false),
        error: (err) => this.handleSendError(err)
      });
  }

  /**
   * Form-fill flow: ships the form schema + current values to the
   * operator-side endpoint, applies whatever fields the model returns
   * back onto the open form. Stays out of the diagram-side `send`
   * branch so each mode has its own request shape.
   */
  private sendFormFill(
    text: string,
    image: { dataUrl: string; mimeType: string } | null
  ): void {
    if (!this.formAdapter) return;
    const fields = this.formAdapter.getSchema();
    const currentValues = this.formAdapter.getCurrentValues();

    const userTurn: ChatMessage = {
      role: 'user',
      text: text || (image ? '(imagen adjunta)' : ''),
      ts: Date.now()
    };
    this.messages.update((m) => [...m, userTurn]);
    this.events$.next(userTurn);

    this.sending.set(true);
    this.errorMessage.set('');

    const body: Record<string, unknown> = {
      sessionId: this.sessionId,
      message: text,
      fields,
      currentValues
    };
    if (image?.dataUrl && image?.mimeType) {
      const commaIdx = image.dataUrl.indexOf(',');
      body['imageData'] =
        commaIdx >= 0 ? image.dataUrl.slice(commaIdx + 1) : image.dataUrl;
      body['imageMimeType'] = image.mimeType;
    }

    this.http
      .post<FormFillResponse>(this.formFillUrl, body)
      .pipe(
        tap((resp) => {
          const valuePairs = resp.values ?? {};
          const filledOps: DiagramOp[] = Object.keys(valuePairs).map(
            (name) => ({
              op: 'addNode' as DiagramOpKind, // reused union just for display
              name,
              newName: this.toDisplayValue(valuePairs[name])
            })
          );
          // We embed the filled fields in `ops` so the existing chat
          // bubble's expandable list renders them; the bubble shows
          // "Llenado: nombre → Pedro García" per entry.
          const assistant: ChatMessage = {
            role: 'assistant',
            text: resp.reply,
            ops: filledOps,
            ts: Date.now()
          };
          this.messages.update((m) => [...m, assistant]);
          this.events$.next(assistant);
          if (this.formAdapter && Object.keys(valuePairs).length) {
            this.formAdapter.applyValues(valuePairs);
          }
        })
      )
      .subscribe({
        next: () => this.sending.set(false),
        error: (err) => this.handleSendError(err)
      });
  }

  private toDisplayValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private handleSendError(err: unknown): void {
    this.sending.set(false);
    const detail =
      (err as { error?: { detail?: string; message?: string } })?.error?.detail ??
      (err as { error?: { detail?: string; message?: string } })?.error?.message ??
      'No se pudo contactar al asistente. Verifica el servicio de IA.';
    this.errorMessage.set(detail);
    this.messages.update((m) => [
      ...m,
      { role: 'system', text: `Error: ${detail}`, ts: Date.now() }
    ]);
  }
}

/**
 * Component-side hook. The policy designer implements this to (1)
 * serialise the current bpmn-js model into the snapshot the model
 * expects and (2) apply each `DiagramOp` to the canvas.
 */
export interface DesignerAdapter {
  getDiagramState(): DiagramSnapshot;
  applyOperations(ops: DiagramOp[]): void;
}

/**
 * Operator-side hook. The task-monitor implements this when a form
 * modal is open: (1) describes the form to the model with a flat list
 * of field descriptors, (2) reports whatever the operator has typed
 * so far, and (3) applies the value map the model returns onto the
 * live form controls.
 */
export interface FormAssistantAdapter {
  getSchema(): FormFieldDescriptor[];
  getCurrentValues(): Record<string, unknown>;
  applyValues(values: Record<string, unknown>): void;
}
