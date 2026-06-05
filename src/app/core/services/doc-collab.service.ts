import { Injectable, NgZone, inject } from '@angular/core';
import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import { Subject } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

/** Estado del editor difundido por un co-editor. */
export interface DocContentEvent {
  senderEmail: string;
  /** text | rich | sheet */
  mode: string;
  content: string;
}

export interface DocPresenceEvent {
  emails: string[];
}

/**
 * Gestión Documental — canal de co-edición en vivo de un documento.
 *
 * Mismo broker STOMP del diseñador BPMN (/ws/policies), salas propias
 * bajo /topic/documents/{docId}. Igual que el diagrama colaborativo, se
 * difunde el ESTADO completo del editor (último-en-escribir gana); el
 * binario solo se persiste al "Guardar nueva versión".
 *
 *   connect() → joinDocument(id) → sendContent(...) / content$ / presence$
 *   leaveDocument() al cerrar el editor.
 */
@Injectable({ providedIn: 'root' })
export class DocCollabService {
  private readonly authService = inject(AuthService);
  private readonly zone = inject(NgZone);

  private client: Client | null = null;
  private currentDoc: string | null = null;
  private subscriptions: StompSubscription[] = [];

  readonly content$ = new Subject<DocContentEvent>();
  readonly presence$ = new Subject<DocPresenceEvent>();

  get selfEmail(): string {
    return this.authService.currentUser()?.email ?? '';
  }

  /** Abre el cliente STOMP si no está activo (idempotente). */
  connect(): Promise<void> {
    if (this.client?.active) {
      return Promise.resolve();
    }
    const token = this.authService.getToken();
    if (!token) {
      return Promise.reject(new Error('Sin token de sesión'));
    }

    this.client = new Client({
      brokerURL: environment.wsBaseUrl,
      connectHeaders: { Authorization: `Bearer ${token}` },
      reconnectDelay: 4000,
      heartbeatIncoming: 10_000,
      heartbeatOutgoing: 10_000,
      debug: () => {}
    });

    return new Promise<void>((resolve, reject) => {
      this.client!.onConnect = () => {
        if (this.currentDoc) {
          this.attachSubscriptions(this.currentDoc);
          this.publishJoin(this.currentDoc);
        }
        resolve();
      };
      this.client!.onStompError = (frame) => {
        reject(new Error(frame.headers['message'] ?? 'STOMP error'));
      };
      this.client!.activate();
    });
  }

  /** Entra a la sala del documento (sale de la anterior si había). */
  async joinDocument(documentId: string): Promise<void> {
    await this.connect();
    if (this.currentDoc === documentId) return;
    this.leaveDocument();
    this.currentDoc = documentId;
    this.attachSubscriptions(documentId);
    this.publishJoin(documentId);
  }

  leaveDocument(): void {
    const doc = this.currentDoc;
    this.subscriptions.forEach((s) => {
      try {
        s.unsubscribe();
      } catch {
        /* socket caído */
      }
    });
    this.subscriptions = [];
    if (doc && this.client?.connected) {
      try {
        this.client.publish({
          destination: `/app/documents/${doc}/leave`,
          body: '{}'
        });
      } catch {
        /* ignore */
      }
    }
    this.currentDoc = null;
  }

  /** Difunde el estado actual del editor a los demás co-editores. */
  sendContent(mode: string, content: string): void {
    if (!this.currentDoc || !this.client?.connected) return;
    this.client.publish({
      destination: `/app/documents/${this.currentDoc}/content`,
      body: JSON.stringify({ mode, content })
    });
  }

  // ── Internals ────────────────────────────────────────────────────────

  private attachSubscriptions(documentId: string): void {
    if (!this.client?.connected) return;
    this.subscriptions = [
      this.client.subscribe(
        `/topic/documents/${documentId}/content`,
        (msg: IMessage) =>
          this.zone.run(() =>
            this.content$.next(JSON.parse(msg.body) as DocContentEvent)
          )
      ),
      this.client.subscribe(
        `/topic/documents/${documentId}/presence`,
        (msg: IMessage) =>
          this.zone.run(() => {
            const body = JSON.parse(msg.body) as { emails?: string[] };
            this.presence$.next({ emails: body.emails ?? [] });
          })
      )
    ];
  }

  private publishJoin(documentId: string): void {
    if (!this.client?.connected) return;
    this.client.publish({
      destination: `/app/documents/${documentId}/join`,
      body: '{}'
    });
  }
}
