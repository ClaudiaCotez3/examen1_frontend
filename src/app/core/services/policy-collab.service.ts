import { Injectable, NgZone, inject } from '@angular/core';
import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import { Subject } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

export interface CollabDiagramEvent {
  senderEmail: string;
  xml: string;
}

export interface CollabCursorEvent {
  senderEmail: string;
  x: number;
  y: number;
}

export interface CollabPresenceEvent {
  policyId: string;
  emails: string[];
}

export interface CollabStartFormEvent {
  senderEmail: string;
  /** Structured field list the runtime renderer consumes. */
  definition: { fields: unknown[] } | null;
  /** form-js editor schema kept alongside `definition`. */
  schema: Record<string, unknown> | null;
  /** Catalog entry id (optional) the form was sourced from. */
  catalogId?: string | null;
  /** Human-friendly name resolved by the sender. */
  displayName?: string | null;
}

/**
 * Real-time collaboration channel for the policy designer.
 *
 * Backed by STOMP-over-WebSocket (Spring Boot WebSocket starter on the
 * server). Auth happens at CONNECT time via the same JWT we send to REST
 * endpoints, attached as the `Authorization: Bearer …` header.
 *
 * Lifecycle:
 *   connect()         — opens the socket, starts the STOMP client.
 *   joinRoom(id)      — subscribes to the three room topics and announces
 *                       this admin to the rest of the room.
 *   leaveRoom()       — unsubscribes + tells the server to drop us from
 *                       the presence list. Idempotent.
 *   sendDiagram(xml)  — broadcasts the local BPMN snapshot.
 *   sendCursor(x, y)  — broadcasts the local cursor position.
 *
 * A single instance can only be in one room at a time. Re-joining a
 * different room will leave the previous one cleanly.
 */
@Injectable({ providedIn: 'root' })
export class PolicyCollabService {
  private readonly authService = inject(AuthService);
  private readonly zone = inject(NgZone);

  private client: Client | null = null;
  private currentRoom: string | null = null;
  private subscriptions: StompSubscription[] = [];

  readonly diagram$ = new Subject<CollabDiagramEvent>();
  readonly cursor$ = new Subject<CollabCursorEvent>();
  readonly presence$ = new Subject<CollabPresenceEvent>();
  readonly startForm$ = new Subject<CollabStartFormEvent>();

  /** Returns the email of the currently authenticated admin. */
  get selfEmail(): string {
    return this.authService.currentUser()?.email ?? '';
  }

  /**
   * Idempotent: opens the STOMP client if it isn't already active. Returns
   * a promise that resolves once we're CONNECTED, so callers can chain
   * subscribe() calls without races.
   */
  connect(): Promise<void> {
    if (this.client?.active) {
      return Promise.resolve();
    }
    const token = sessionStorage.getItem('workflow.auth.token');
    if (!token) {
      return Promise.reject(new Error('No auth token in sessionStorage'));
    }

    this.client = new Client({
      brokerURL: environment.wsBaseUrl,
      connectHeaders: { Authorization: `Bearer ${token}` },
      reconnectDelay: 4000,
      heartbeatIncoming: 10_000,
      heartbeatOutgoing: 10_000,
      debug: () => {} // silence default debug prints
    });

    return new Promise<void>((resolve, reject) => {
      this.client!.onConnect = () => {
        // Re-subscribe to the previous room if we were in one before a drop.
        if (this.currentRoom) {
          this.attachRoomSubscriptions(this.currentRoom);
          this.publishJoin(this.currentRoom);
        }
        resolve();
      };
      this.client!.onStompError = (frame) => {
        reject(new Error(frame.headers['message'] ?? 'STOMP error'));
      };
      this.client!.activate();
    });
  }

  /** Joins the room for a given policy id. Leaves the previous one first. */
  async joinRoom(policyId: string): Promise<void> {
    if (this.currentRoom === policyId) return;
    if (this.currentRoom) {
      this.leaveRoom();
    }
    await this.connect();
    this.currentRoom = policyId;
    this.attachRoomSubscriptions(policyId);
    this.publishJoin(policyId);
  }

  /** Cleanly leaves the current room. Safe to call multiple times. */
  leaveRoom(): void {
    if (!this.currentRoom || !this.client?.connected) {
      this.subscriptions.forEach((s) => s.unsubscribe());
      this.subscriptions = [];
      this.currentRoom = null;
      return;
    }
    this.client.publish({
      destination: `/app/policies/${this.currentRoom}/leave`,
      body: ''
    });
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.subscriptions = [];
    this.currentRoom = null;
  }

  sendDiagram(xml: string): void {
    if (!this.currentRoom || !this.client?.connected) return;
    this.client.publish({
      destination: `/app/policies/${this.currentRoom}/diagram`,
      body: JSON.stringify({ xml }),
      headers: { 'content-type': 'application/json' }
    });
  }

  sendCursor(x: number, y: number): void {
    if (!this.currentRoom || !this.client?.connected) return;
    this.client.publish({
      destination: `/app/policies/${this.currentRoom}/cursor`,
      body: JSON.stringify({ x, y }),
      headers: { 'content-type': 'application/json' }
    });
  }

  /** Broadcasts the policy's start form (definition + form-js schema). */
  sendStartForm(
    definition: { fields: unknown[] } | null,
    schema: Record<string, unknown> | null,
    catalogId: string | null = null,
    displayName: string | null = null
  ): void {
    if (!this.currentRoom || !this.client?.connected) return;
    // Explicit content-type so Spring's @Payload converter picks the
    // Jackson MessageConverter and deserialises into CollabStartFormDTO
    // instead of dropping the frame as a binary blob.
    this.client.publish({
      destination: `/app/policies/${this.currentRoom}/start-form`,
      body: JSON.stringify({ definition, schema, catalogId, displayName }),
      headers: { 'content-type': 'application/json' }
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private attachRoomSubscriptions(policyId: string): void {
    if (!this.client) return;
    const base = `/topic/policies/${policyId}`;
    console.info('[Collab] subscribing to room', base);

    this.subscriptions.push(
      this.client.subscribe(`${base}/diagram`, (msg: IMessage) => {
        this.zone.run(() => this.diagram$.next(JSON.parse(msg.body)));
      }),
      this.client.subscribe(`${base}/cursor`, (msg: IMessage) => {
        this.zone.run(() => this.cursor$.next(JSON.parse(msg.body)));
      }),
      this.client.subscribe(`${base}/presence`, (msg: IMessage) => {
        this.zone.run(() => this.presence$.next(JSON.parse(msg.body)));
      }),
      this.client.subscribe(`${base}/start-form`, (msg: IMessage) => {
        console.info('[Collab] start-form frame received');
        this.zone.run(() => this.startForm$.next(JSON.parse(msg.body)));
      })
    );
  }

  private publishJoin(policyId: string): void {
    this.client?.publish({
      destination: `/app/policies/${policyId}/join`,
      body: ''
    });
  }
}
