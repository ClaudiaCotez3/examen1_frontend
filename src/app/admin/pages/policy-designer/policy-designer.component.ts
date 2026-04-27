import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import BpmnModeler from 'bpmn-js/lib/Modeler';

import { PolicyService } from '../../../core/services/policy.service';
import { AssignmentType, PolicyDraft } from '../../../core/models/policy.model';
import { FormDefinition } from '../../../core/models/form.model';
import { FormCatalogEntry } from '../../../core/models/form-catalog.model';
import { FormCatalogService } from '../../../core/services/form-catalog.service';
import { Role } from '../../../core/models/role.model';
import { User } from '../../../core/models/user.model';
import { RoleService } from '../../../core/services/role.service';
import { UserService } from '../../../core/services/user.service';
import { BpmnExportService } from '../../../core/services/bpmn-export.service';
import { DiagramStateService } from '../../../core/services/diagram-state.service';
import { StartFormDraftService } from '../../../core/services/start-form-draft.service';
import { PolicyCollabService } from '../../../core/services/policy-collab.service';
import { Subscription } from 'rxjs';
import {
  ASSIGNED_USER_KEY,
  ASSIGNMENT_TYPE_KEY,
  BRANCH_LABEL_KEY,
  EMPTY_POLICY_DIAGRAM,
  FORM_ID_KEY,
  ParsedDiagram,
  ensureWorkflowNamespace,
  extractPolicyGraph,
  readAssignedUsersExtension,
  readAssignmentTypeExtension,
  readBranchLabelExtension,
  readFormIdExtension,
  validateGraph
} from './bpmn-parser';
import {
  registerAppendElementPopup,
  registerGatewayContextPadEntries
} from './bpmn-context-pad';
import {
  registerCustomPalette,
  setupCollapsiblePaletteSections
} from './bpmn-palette';

interface SelectedNode {
  elementId: string;
  bpmnType: string;
  name: string;
}

/**
 * BPMN $types that can have a form attached. With the restricted element set
 * this is only the plain Task — user/service/manual/script tasks are no
 * longer exposed in the palette.
 */
const FORMABLE_TYPES = new Set(['bpmn:Task']);

/**
 * Assignment semantics for every Task. We expose one simple concept in
 * the UI ("Responsables"): the admin designates 1 or N operators, any of
 * whom can take the task. That maps to the backend's CANDIDATE_USERS enum
 * value, which is stamped automatically — there's no user-facing dropdown
 * for the type.
 */
const DEFAULT_ASSIGNMENT_TYPE: AssignmentType = 'CANDIDATE_USERS';

@Component({
  selector: 'app-policy-designer',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './policy-designer.component.html',
  styleUrl: './policy-designer.component.scss'
})
export class PolicyDesignerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLDivElement>;

  private readonly policyService = inject(PolicyService);
  private readonly catalog = inject(FormCatalogService);
  private readonly userService = inject(UserService);
  private readonly roleService = inject(RoleService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly exporter = inject(BpmnExportService);
  private readonly diagramState = inject(DiagramStateService);
  private readonly startFormDraft = inject(StartFormDraftService);
  private readonly collab = inject(PolicyCollabService);
  private modeler: BpmnModeler | null = null;

  // ── Collaboration state ───────────────────────────────────────────────
  /** Emails of the admins currently editing the same policy. */
  readonly presentEmails = signal<string[]>([]);
  /** email → { x, y } cursor positions in diagram space. */
  readonly remoteCursors = signal<Record<string, { x: number; y: number }>>({});
  /** Self-email so the presence header can highlight "Tú". */
  readonly selfEmail = signal<string>('');

  private collabSubs: Subscription[] = [];
  /** True while we're applying a remote XML — suppresses outbound echoes. */
  private applyingRemoteXml = false;
  /** Same idea but for the start-form sync channel. */
  private applyingRemoteStartForm = false;
  private collabBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private collabCursorThrottleAt = 0;
  private collabRoomId: string | null = null;
  /**
   * Set true when the admin returns from the form-builder with a saved
   * start form. The broadcast runs AFTER {@link joinCollabRoom} succeeds —
   * the room (and therefore the WebSocket) isn't connected yet at that
   * point in {@link ngAfterViewInit}, so we have to defer the publish.
   */
  private pendingStartFormBroadcast = false;

  /**
   * When present, the designer was opened from the Políticas catalog to
   * "edit" an existing policy. Full diagram reconstruction from the stored
   * graph is not implemented yet, so for now we load metadata only and
   * surface a toast explaining the limitation. The id is kept so a future
   * iteration can swap {@link savePolicy} to a PUT/update call.
   */
  readonly editingPolicyId = signal<string | null>(null);

  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressAutoSave = true;
  readonly exportMenuOpen = signal(false);

  /**
   * Sidebar visibility toggle. Defaults to "open" on wider viewports;
   * users can collapse it to give the canvas more room. On narrow
   * viewports the SCSS overlays the sidebar instead of stealing canvas
   * width, so opening it doesn't push the diagram off-screen.
   */
  readonly sidebarOpen = signal<boolean>(true);

  toggleSidebar(): void {
    this.sidebarOpen.update((v) => !v);
  }

  /**
   * Prominent toast banner shown after save attempts. The inline status
   * pill in the toolbar is easy to miss (especially with the sidebar full
   * of properties), so we surface the result through a floating banner
   * identical in shape to the one used by the form builder.
   */
  readonly toast = signal<{ kind: 'success' | 'error'; title: string; detail?: string } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Process-level metadata ────────────────────────────────────────────
  // Name starts empty so the input's placeholder ("Nombre del proceso") is
  // visible — the admin should see the prompt, not a pre-filled default
  // they have to delete. At save time an empty name falls back to
  // "Proceso sin título" so the backend always receives a value.
  readonly policyName = signal('');
  readonly policyDescription = signal('');
  /**
   * Dynamic form the consultor fills when initiating a new case for this
   * process. Authored in the shared form builder (policy-start mode) and
   * travels with the policy on save. Replaces the old free-text
   * "requisitos previos" list — instead of bullet points, the customer
   * provides structured data that lands directly on the case.
   */
  readonly startFormDefinition = signal<FormDefinition | null>(null);
  /** form-js editor schema kept in lockstep with {@link startFormDefinition}. */
  readonly startFormSchema = signal<unknown | null>(null);

  /** Number of fields in the configured start form — drives sidebar hint. */
  readonly startFormFieldCount = computed<number>(
    () => this.startFormDefinition()?.fields?.length ?? 0
  );

  // ── Selection + per-activity state ────────────────────────────────────
  readonly selected = signal<SelectedNode | null>(null);
  readonly selectedName = signal('');

  readonly formIdsByElementId = signal<Record<string, string | null>>({});

  readonly availableForms = computed<FormCatalogEntry[]>(() => this.catalog.entries());

  readonly assignedUserIdsByElementId = signal<Record<string, string[]>>({});

  /** Assignment mode per activity. Defaults to DEPARTMENT on first select. */
  readonly assignmentTypesByElementId = signal<Record<string, AssignmentType>>({});

  /**
   * Branch label per flow id. Only meaningful for flows leaving a DECISION
   * gateway (typically "APROBADO" / "RECHAZADO"). Drives the runtime
   * decision modal that the operator gets when completing the task that
   * precedes the gateway.
   */
  readonly branchLabelsByElementId = signal<Record<string, string>>({});

  readonly allUsers = signal<User[]>([]);
  readonly allRoles = signal<Role[]>([]);

  /**
   * All users with the OPERATOR role — the candidate pool for activity
   * assignment. Filtering rules:
   *   - Role match is case-insensitive in case the seeded data drifts
   *     (`OPERATOR` / `Operator` / `operator`).
   *   - We only exclude users explicitly marked inactive (`active === false`).
   *     Older records with `active` null/undefined are treated as active so
   *     they still appear in the dropdown — the admin asked to see "todos
   *     los usuarios con rol operador".
   */
  readonly operatorUsers = computed<User[]>(() => {
    const opRole = this.allRoles().find(
      (r) => (r.name ?? '').trim().toUpperCase() === 'OPERATOR'
    );
    if (!opRole) return [];
    return this.allUsers().filter(
      (u) => u.roleId === opRole.id && u.active !== false
    );
  });

  readonly selectedAssignedUserIds = computed<string[]>(() => {
    const node = this.selected();
    if (!node) return [];
    return this.assignedUserIdsByElementId()[node.elementId] ?? [];
  });

  readonly assignedUsers = computed<User[]>(() => {
    const ids = this.selectedAssignedUserIds();
    if (ids.length === 0) return [];
    const index = new Map(this.allUsers().map((u) => [u.id, u]));
    return ids.map((id) => index.get(id)).filter((u): u is User => !!u);
  });

  readonly availableUsersToAdd = computed<User[]>(() => {
    const assigned = new Set(this.selectedAssignedUserIds());
    return this.operatorUsers().filter((u) => !assigned.has(u.id));
  });

  readonly status = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  readonly statusMessage = signal<string>('');
  readonly validationErrors = signal<string[]>([]);

  readonly canEditName = computed(() => {
    const node = this.selected();
    return !!node && node.bpmnType !== 'bpmn:Lane';
  });

  readonly canHaveForm = computed(() => {
    const node = this.selected();
    return !!node && FORMABLE_TYPES.has(node.bpmnType);
  });

  /** True when selected element is a Task (activity-level controls visible). */
  readonly isActivitySelected = this.canHaveForm;

  readonly selectedFormId = computed<string>(() => {
    const node = this.selected();
    if (!node) return '';
    return this.formIdsByElementId()[node.elementId] ?? '';
  });

  readonly assignedForm = computed<FormCatalogEntry | null>(() => {
    const id = this.selectedFormId();
    if (!id) return null;
    return this.availableForms().find((f) => f.id === id) ?? null;
  });

  /**
   * Inferred activity kind: FORM_TASK when a form is attached, APPROVAL_TASK
   * otherwise. Never shown as a raw label to the user — it only drives the
   * "Aprobar / Rechazar" UI hint.
   */
  readonly isApprovalTask = computed<boolean>(() => {
    return this.isActivitySelected() && !this.assignedForm();
  });

  async ngAfterViewInit(): Promise<void> {
    this.userService.getAll().subscribe({
      next: (users) => this.allUsers.set(users),
      error: (err) => console.warn('Failed to load users', err)
    });
    this.roleService.load().subscribe({
      next: (roles) => this.allRoles.set(roles),
      error: (err) => console.warn('Failed to load roles', err)
    });

    // Keyboard binding is implicit in diagram-js now — passing an explicit
    // `keyboard.bindTo` target triggers an unsupported-configuration warning.
    // See https://github.com/bpmn-io/diagram-js/issues/661
    this.modeler = new BpmnModeler({
      container: this.canvasRef.nativeElement
    });

    registerGatewayContextPadEntries(this.modeler);
    registerAppendElementPopup(this.modeler);
    registerCustomPalette(this.modeler);
    setupCollapsiblePaletteSections(this.modeler);

    // Edit mode: a route param `:id` means the admin clicked "Editar" in
    // the Políticas catalog. Skip the localStorage draft in that case so
    // the editor starts clean and then fetches policy metadata from the
    // backend. The diagram canvas stays empty until a future iteration
    // wires BPMN XML storage end-to-end.
    const editId = this.route.snapshot.paramMap.get('id');
    const draft = editId ? null : this.diagramState.load();
    const startingXml = ensureWorkflowNamespace(draft?.xml ?? EMPTY_POLICY_DIAGRAM);
    try {
      await this.modeler.importXML(startingXml);
    } catch (err) {
      console.error('Failed to import diagram XML, falling back to empty', err);
      try {
        await this.modeler.importXML(EMPTY_POLICY_DIAGRAM);
      } catch {
        /* surface nothing extra; user will see blank canvas */
      }
    }

    if (draft) {
      this.policyName.set(draft.name ?? '');
      this.policyDescription.set(draft.description || '');
      this.startFormDefinition.set(draft.startFormDefinition ?? null);
      this.startFormSchema.set(draft.startFormSchema ?? null);
      this.formIdsByElementId.set(draft.formIds ?? {});
      this.assignedUserIdsByElementId.set(draft.assignedUserIds ?? {});
      this.assignmentTypesByElementId.set(draft.assignmentTypes ?? {});
    }

    // Pick up a fresh start form that was just saved in the form builder
    // (policy-start mode). The draft slot lives in localStorage so it
    // survives the navigation round-trip; we clear it once applied so
    // re-opening the designer in a new session doesn't re-inject it.
    const returnedStartForm = this.startFormDraft.get();
    if (returnedStartForm?.saved) {
      this.startFormDefinition.set(returnedStartForm.definition);
      this.startFormSchema.set(returnedStartForm.schema);
      // Defer the broadcast to right after joinCollabRoom succeeds — the
      // WebSocket isn't open yet at this point in the lifecycle.
      this.pendingStartFormBroadcast = true;
    }
    this.startFormDraft.clear();

    if (editId) {
      this.editingPolicyId.set(editId);
      this.loadPolicyForEdit(editId);
      // Real-time collaboration is bound to a policy id, so it kicks in
      // only when editing an already-saved policy. Newly drafted policies
      // join the room after the first save (see `savePolicy` success).
      this.joinCollabRoom(editId);
    }

    this.selfEmail.set(this.collab.selfEmail);

    const eventBus = this.modeler.get<any>('eventBus');
    eventBus.on('selection.changed', (ev: { newSelection: any[] }) => {
      const element = ev.newSelection?.[0];
      if (!element) {
        this.selected.set(null);
        this.selectedName.set('');
        return;
      }
      const bo = element.businessObject;
      this.selected.set({
        elementId: element.id,
        bpmnType: bo?.$type ?? element.type,
        name: bo?.name ?? ''
      });
      this.selectedName.set(bo?.name ?? '');

      this.hydrateFormIdFromXml(element);
      this.hydrateAssignedUserFromXml(element);
      this.hydrateAssignmentTypeFromXml(element);
      this.hydrateBranchLabelFromXml(element);
    });

    eventBus.on('element.changed', (ev: { element: any }) => {
      const current = this.selected();
      if (current && ev.element?.id === current.elementId) {
        const name = ev.element.businessObject?.name ?? '';
        if (name !== current.name) {
          this.selected.set({ ...current, name });
          this.selectedName.set(name);
        }
      }
    });

    eventBus.on('commandStack.changed', () => {
      this.scheduleAutoSave();
      this.broadcastDiagramToPeers();
    });

    // Cursor broadcast — bpmn-js exposes 'canvas.viewbox.changing' and
    // 'element.hover' but for a free-floating cursor we want raw mouse
    // moves with the canvas-relative coordinate. Throttled to ~25 Hz so
    // the channel doesn't drown other messages.
    this.canvasRef.nativeElement.addEventListener('mousemove', this.onLocalCursorMove);

    setTimeout(() => {
      this.suppressAutoSave = false;
    }, 0);
  }

  ngOnDestroy(): void {
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
      void this.persistDraft();
    }
    if (this.collabBroadcastTimer) {
      clearTimeout(this.collabBroadcastTimer);
      this.collabBroadcastTimer = null;
    }
    this.canvasRef?.nativeElement?.removeEventListener('mousemove', this.onLocalCursorMove);
    this.collabSubs.forEach((s) => s.unsubscribe());
    this.collabSubs = [];
    this.collab.leaveRoom();
    this.collabRoomId = null;
    this.modeler?.destroy();
    this.modeler = null;
  }

  // ── Real-time collaboration ─────────────────────────────────────────

  /** Connects, joins the room and wires the three streams to local state. */
  private async joinCollabRoom(policyId: string): Promise<void> {
    this.collabRoomId = policyId;
    try {
      await this.collab.joinRoom(policyId);
    } catch (err) {
      console.warn('Collaboration unavailable; continuing solo', err);
      return;
    }
    this.collabSubs.push(
      this.collab.diagram$.subscribe((event) => {
        if (event.senderEmail === this.collab.selfEmail) return;
        void this.applyRemoteXml(event.xml);
      }),
      this.collab.cursor$.subscribe((event) => {
        if (event.senderEmail === this.collab.selfEmail) return;
        const next = { ...this.remoteCursors() };
        next[event.senderEmail] = { x: event.x, y: event.y };
        this.remoteCursors.set(next);
      }),
      this.collab.presence$.subscribe((event) => {
        if (event.policyId !== this.collabRoomId) return;
        this.presentEmails.set(event.emails ?? []);
        // Drop stale cursors for admins who left the room.
        const stillHere = new Set(event.emails ?? []);
        const next: Record<string, { x: number; y: number }> = {};
        for (const [email, pos] of Object.entries(this.remoteCursors())) {
          if (stillHere.has(email)) next[email] = pos;
        }
        this.remoteCursors.set(next);
      }),
      this.collab.startForm$.subscribe((event) => {
        if (event.senderEmail === this.collab.selfEmail) return;
        console.info('[Collab] start-form received from', event.senderEmail,
          'fields=', event.definition?.fields?.length ?? 0,
          'name=', event.displayName);
        // Suppress the resulting auto-save / re-broadcast so the inbound
        // event doesn't bounce back as our own update.
        this.applyingRemoteStartForm = true;
        this.startFormDefinition.set(
          (event.definition as FormDefinition | null) ?? null
        );
        this.startFormSchema.set(event.schema ?? null);
        // Mirror the sender's catalog selection so the summary shows the
        // same human-friendly name.
        this.startFormCatalogId.set(event.catalogId ?? '');
        setTimeout(() => { this.applyingRemoteStartForm = false; }, 0);
      })
    );

    // Flush a pending start-form broadcast queued before the WebSocket
    // was connected (e.g. the admin just returned from the form-builder
    // with a saved start form, which fires earlier in ngAfterViewInit).
    if (this.pendingStartFormBroadcast) {
      this.pendingStartFormBroadcast = false;
      // Tiny delay so the server has registered our SUBSCRIBE on the
      // start-form topic before we try to publish.
      setTimeout(() => this.broadcastStartForm(), 100);
    }
  }

  /**
   * Imports the BPMN XML coming from another admin into the local modeler
   * while suppressing the outbound echo through the cascading
   * commandStack.changed events. After the import, rebuilds the per-element
   * state maps (forms, assignees, assignment types) from the XML so the
   * sidebar reflects whatever the remote admin just changed — without
   * this step the modeler shows the new graph but our local signals stay
   * stuck on the previous values and the "Responsables" chips don't update.
   */
  private async applyRemoteXml(xml: string): Promise<void> {
    if (!this.modeler) return;
    this.applyingRemoteXml = true;
    try {
      await this.modeler.importXML(ensureWorkflowNamespace(xml));
      this.syncLiveStateFromXml();
    } catch (err) {
      console.warn('Failed to apply remote diagram update', err);
    } finally {
      // Microtask defer so the commandStack events fired by importXML
      // see the flag still set.
      setTimeout(() => { this.applyingRemoteXml = false; }, 0);
    }
  }

  /**
   * Replaces the per-element state maps with whatever the current XML
   * declares. Unlike {@link rehydrateLiveStateFromXml} (which is additive
   * and skips elements already present in the maps), this one is
   * authoritative — used when a remote admin edits the diagram and our
   * local copy needs to track theirs exactly.
   */
  private syncLiveStateFromXml(): void {
    if (!this.modeler) return;
    const registry = this.modeler.get<any>('elementRegistry');
    const elements: any[] = registry.getAll();
    const formIds: Record<string, string | null> = {};
    const assignedUsers: Record<string, string[]> = {};
    const assignmentTypes: Record<string, AssignmentType> = {};
    for (const element of elements) {
      if (!element?.businessObject) continue;
      const formId = readFormIdExtension(element);
      if (formId) formIds[element.id] = formId;
      const users = readAssignedUsersExtension(element);
      if (users.length > 0) assignedUsers[element.id] = users;
      const aType = readAssignmentTypeExtension(element);
      if (aType) assignmentTypes[element.id] = aType;
    }
    this.formIdsByElementId.set(formIds);
    this.assignedUserIdsByElementId.set(assignedUsers);
    this.assignmentTypesByElementId.set(assignmentTypes);
  }

  /** Debounced fan-out of the local BPMN XML to every peer in the room. */
  private broadcastDiagramToPeers(): void {
    if (this.applyingRemoteXml || !this.collabRoomId) return;
    if (this.collabBroadcastTimer) clearTimeout(this.collabBroadcastTimer);
    this.collabBroadcastTimer = setTimeout(async () => {
      this.collabBroadcastTimer = null;
      if (!this.modeler) return;
      try {
        const xml = await this.exporter.exportXml(this.modeler);
        this.collab.sendDiagram(xml);
      } catch (err) {
        console.warn('Failed to broadcast diagram', err);
      }
    }, 300);
  }

  /**
   * Pushes the current start form (definition + form-js schema) to every
   * peer in the room. No-op if we're not in a room or if the change came
   * from a remote event (avoids ping-pong loops).
   */
  private broadcastStartForm(): void {
    if (this.applyingRemoteStartForm) return;
    if (!this.collabRoomId) {
      console.info('[Collab] start-form broadcast skipped — not in a room yet');
      return;
    }
    const def = this.startFormDefinition();
    const catalogId = this.startFormCatalogId() || null;
    const displayName = this.startFormDisplayName() || null;
    console.info('[Collab] broadcasting start-form, fields=',
      def?.fields?.length ?? 0, 'name=', displayName);
    this.collab.sendStartForm(
      def ? { fields: def.fields as unknown[] } : null,
      (this.startFormSchema() as Record<string, unknown> | null) ?? null,
      catalogId,
      displayName
    );
  }

  /** Throttled cursor broadcaster, ~25 Hz. */
  private readonly onLocalCursorMove = (event: MouseEvent): void => {
    if (!this.collabRoomId) return;
    const now = Date.now();
    if (now - this.collabCursorThrottleAt < 40) return;
    this.collabCursorThrottleAt = now;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.collab.sendCursor(event.clientX - rect.left, event.clientY - rect.top);
  };

  /** Stable colour per email so the UI consistently tints the same admin. */
  cursorColor(email: string): string {
    let hash = 0;
    for (let i = 0; i < email.length; i++) {
      hash = (hash * 31 + email.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  }

  remoteCursorList(): Array<{ email: string; x: number; y: number }> {
    return Object.entries(this.remoteCursors()).map(([email, pos]) => ({
      email,
      x: pos.x,
      y: pos.y
    }));
  }

  // ── Auto-save (debounced) ───────────────────────────────────────────

  onMetaChanged(): void {
    this.scheduleAutoSave();
  }

  private scheduleAutoSave(): void {
    if (this.suppressAutoSave) return;
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      void this.persistDraft();
    }, 500);
  }

  private async persistDraft(): Promise<void> {
    if (!this.modeler) return;
    try {
      const xml = await this.exporter.exportXml(this.modeler);
      this.diagramState.save({
        name: this.policyName(),
        description: this.policyDescription(),
        startFormDefinition: this.startFormDefinition(),
        startFormSchema: this.startFormSchema(),
        xml,
        formIds: this.formIdsByElementId(),
        assignedUserIds: this.assignedUserIdsByElementId(),
        assignmentTypes: this.assignmentTypesByElementId()
      });
    } catch (err) {
      console.warn('Auto-save failed', err);
    }
  }

  applyNameChange(): void {
    const node = this.selected();
    if (!this.modeler || !node) return;

    const elementRegistry = this.modeler.get<any>('elementRegistry');
    const modeling = this.modeler.get<any>('modeling');
    const element = elementRegistry.get(node.elementId);
    if (!element) return;
    modeling.updateProperties(element, { name: this.selectedName() });
  }

  // ── Process-level start form ────────────────────────────────────────

  /**
   * Navigates to the shared form builder in policy-start mode so the admin
   * can design the dynamic form the consultor will fill when initiating a
   * case. We persist the current start-form state (if any) and the URL to
   * return to so the builder can round-trip cleanly on cancel or save.
   */
  openStartFormBuilder(): void {
    void this.persistDraft();
    this.startFormDraft.set({
      definition: this.startFormDefinition(),
      schema: this.startFormSchema(),
      returnTo: this.router.url,
      saved: false
    });
    this.router.navigate(['/admin/policies/start-form']);
  }

  clearStartForm(): void {
    this.startFormDefinition.set(null);
    this.startFormSchema.set(null);
    this.startFormCatalogId.set('');
    this.scheduleAutoSave();
    this.broadcastStartForm();
  }

  /**
   * Currently selected catalog entry id for the start form. Empty string
   * means "none picked" — keeps the placeholder option active in the
   * dropdown. Reset when the form is cleared or fully customised.
   */
  readonly startFormCatalogId = signal<string>('');

  /**
   * Display name of the start form once it is configured. Resolved from
   * the catalog entry when applicable; falls back to "Formulario
   * personalizado" when the admin authored one from scratch in the
   * builder.
   */
  readonly startFormDisplayName = computed<string>(() => {
    const id = this.startFormCatalogId();
    if (id) {
      const entry = this.availableForms().find((f) => f.id === id);
      if (entry?.name) return entry.name;
    }
    if (this.startFormDefinition()?.fields?.length) {
      return 'Formulario personalizado';
    }
    return '';
  });

  /**
   * Adopts an existing form catalog entry as the policy's start form.
   * Persisted as a denormalised snapshot (same semantics as task forms),
   * so future edits to the catalog don't silently retroactively change
   * already-saved policies.
   */
  // ── Branch labels (DECISION outgoing flows) ────────────────────────

  /**
   * True when the current selection is a sequence flow whose source is
   * a DECISION gateway. Drives the visibility of the "Etiqueta de la
   * rama" input in the sidebar.
   */
  readonly isDecisionBranchSelected = computed<boolean>(() => {
    const node = this.selected();
    if (!node) return false;
    if (node.bpmnType !== 'bpmn:SequenceFlow') return false;
    if (!this.modeler) return false;
    const registry = this.modeler.get<any>('elementRegistry');
    const flow = registry.get(node.elementId);
    const sourceType = flow?.businessObject?.sourceRef?.$type;
    return sourceType === 'bpmn:ExclusiveGateway'
        || sourceType === 'bpmn:InclusiveGateway'
        || sourceType === 'bpmn:EventBasedGateway';
  });

  readonly selectedBranchLabel = computed<string>(() => {
    const node = this.selected();
    if (!node) return '';
    return this.branchLabelsByElementId()[node.elementId] ?? '';
  });

  /** Applies a branch label preset (or any free-text value) to the selected flow. */
  applyBranchLabel(label: string): void {
    const node = this.selected();
    if (!node) return;
    const trimmed = (label ?? '').trim();
    const next = { ...this.branchLabelsByElementId() };
    if (trimmed) next[node.elementId] = trimmed;
    else delete next[node.elementId];
    this.branchLabelsByElementId.set(next);
    this.writeExtensionAttr(node.elementId, BRANCH_LABEL_KEY, trimmed || null);
  }

  private hydrateBranchLabelFromXml(element: any): void {
    if (!element?.businessObject) return;
    const elementId = element.id;
    if (Object.prototype.hasOwnProperty.call(this.branchLabelsByElementId(), elementId)) {
      return;
    }
    const fromXml = readBranchLabelExtension(element);
    if (!fromXml) return;
    this.branchLabelsByElementId.set({
      ...this.branchLabelsByElementId(),
      [elementId]: fromXml
    });
  }

  applyStartFormFromCatalog(catalogId: string): void {
    this.startFormCatalogId.set(catalogId);
    if (!catalogId) {
      // The "— Selecciona uno —" sentinel just resets the picker; we
      // intentionally do NOT wipe an existing definition here so the
      // admin can keep what they already configured.
      return;
    }
    const entry = this.availableForms().find((f) => f.id === catalogId);
    if (!entry?.formDefinition) return;
    this.startFormDefinition.set({
      fields: entry.formDefinition.fields.map((f) => ({ ...f }))
    });
    // The catalog only stores the schema; clear any previous form-js
    // editor schema so the builder rebuilds it cleanly next time.
    this.startFormSchema.set(null);
    this.scheduleAutoSave();
    this.broadcastStartForm();
    this.showToast({
      kind: 'success',
      title: 'Formulario aplicado',
      detail: `«${entry.name}» se asignó como formulario inicial.`
    });
  }

  // ── Form assignment ──────────────────────────────────────────────────

  assignForm(formId: string): void {
    const node = this.selected();
    if (!node) return;
    const next = { ...this.formIdsByElementId() };
    if (formId) {
      next[node.elementId] = formId;
    } else {
      delete next[node.elementId];
    }
    this.formIdsByElementId.set(next);
    this.writeFormIdToBpmn(node.elementId, formId || null);
  }

  clearAssignedForm(): void {
    this.assignForm('');
  }

  goToFormBuilder(): void {
    this.router.navigate(['/forms/create']);
  }

  editAssignedForm(): void {
    const id = this.selectedFormId();
    if (!id) return;
    this.router.navigate(['/forms/edit', id]);
  }

  private writeFormIdToBpmn(elementId: string, formId: string | null): void {
    this.writeExtensionAttr(elementId, FORM_ID_KEY, formId);
  }

  private hydrateFormIdFromXml(element: any): void {
    if (!element?.businessObject) return;
    const elementId = element.id;
    if (Object.prototype.hasOwnProperty.call(this.formIdsByElementId(), elementId)) {
      return;
    }
    const fromXml = readFormIdExtension(element);
    if (!fromXml) return;
    const next = { ...this.formIdsByElementId(), [elementId]: fromXml };
    this.formIdsByElementId.set(next);
  }

  // ── Assignment type (implicit) ───────────────────────────────────────
  //
  // The UI no longer exposes a "tipo de asignación" dropdown — assigning
  // 1..N responsables IS the assignment model. We still persist the type
  // on the BPMN XML so the backend receives an explicit enum value, but
  // it is always {@link DEFAULT_ASSIGNMENT_TYPE} (CANDIDATE_USERS).

  private writeAssignmentTypeToBpmn(elementId: string, type: AssignmentType): void {
    this.writeExtensionAttr(elementId, ASSIGNMENT_TYPE_KEY, type);
  }

  private hydrateAssignmentTypeFromXml(element: any): void {
    if (!element?.businessObject) return;
    const elementId = element.id;
    if (
      Object.prototype.hasOwnProperty.call(this.assignmentTypesByElementId(), elementId)
    ) {
      return;
    }

    // Only tasks carry an assignment type; gateways / events ignore it.
    if (element.businessObject.$type !== 'bpmn:Task') return;

    // The UI no longer offers a type selector; we normalize every task to
    // CANDIDATE_USERS so the "1..N responsables" semantics apply uniformly.
    // Any legacy value found in the XML (e.g. DEPARTMENT from a migrated
    // diagram) is overwritten so the saved state matches what the admin
    // sees in the sidebar.
    const fromXml = readAssignmentTypeExtension(element);
    const resolved: AssignmentType = DEFAULT_ASSIGNMENT_TYPE;
    const next = { ...this.assignmentTypesByElementId(), [elementId]: resolved };
    this.assignmentTypesByElementId.set(next);
    if (fromXml !== resolved) {
      this.writeAssignmentTypeToBpmn(elementId, resolved);
    }
    if (!fromXml) {
      this.writeAssignmentTypeToBpmn(elementId, resolved);
    }
  }

  // ── User assignment (multi-assignee) ─────────────────────────────────

  addUserToActivity(userId: string): void {
    const node = this.selected();
    if (!node || !userId) return;
    const current = this.assignedUserIdsByElementId()[node.elementId] ?? [];
    if (current.includes(userId)) return;
    this.persistAssignedUsers(node.elementId, [...current, userId]);
  }

  /**
   * Native change handler for the "Agregar responsable" dropdown. We use
   * a plain (change) handler — no ngModel — so we can imperatively reset
   * the underlying DOM value back to the disabled placeholder after each
   * pick. With ngModel bound to a literal `''`, Angular sees no model
   * change and skips the DOM update, leaving the dropdown showing the
   * just-picked operator instead of the placeholder.
   */
  onAddUserSelectChange(select: HTMLSelectElement): void {
    const userId = select.value;
    if (!userId) return;
    this.addUserToActivity(userId);
    // Defer the reset to the next microtask so we don't fight the browser's
    // own selection update on this same change event.
    Promise.resolve().then(() => {
      select.value = '';
    });
  }

  removeUserFromActivity(userId: string): void {
    const node = this.selected();
    if (!node) return;
    const current = this.assignedUserIdsByElementId()[node.elementId] ?? [];
    const nextList = current.filter((id) => id !== userId);
    this.persistAssignedUsers(node.elementId, nextList);
  }

  goToCreateUser(): void {
    this.router.navigate(['/users/create']);
  }

  private persistAssignedUsers(elementId: string, list: string[]): void {
    const next = { ...this.assignedUserIdsByElementId(), [elementId]: list };
    this.assignedUserIdsByElementId.set(next);
    this.writeAssignedUsersToBpmn(elementId, list);
  }

  private writeAssignedUsersToBpmn(elementId: string, list: string[]): void {
    const serialized = list.length > 0 ? JSON.stringify(list) : null;
    this.writeExtensionAttr(elementId, ASSIGNED_USER_KEY, serialized);
  }

  /**
   * Persists a `workflow:*` extension attribute on the element's
   * businessObject in a way bpmn-js will reliably serialize when the XML
   * is exported.
   *
   * Why not just `modeling.updateProperties`?
   *   bpmn-js refuses to serialize prefixed attributes that aren't part
   *   of a registered moddle extension; the attr lives on the in-memory
   *   businessObject but vanishes on `exportXML`. Writing into the
   *   `$attrs` bag (the moddle catch-all for unknown attributes) is
   *   what survives the round-trip.
   *
   * After updating `$attrs` we explicitly trigger the auto-save and the
   * collaboration broadcast, since this code path bypasses the modeling
   * command stack which is the usual hook for both.
   */
  private writeExtensionAttr(
    elementId: string,
    key: string,
    value: string | null
  ): void {
    if (!this.modeler) return;
    const registry = this.modeler.get<any>('elementRegistry');
    const element = registry.get(elementId);
    if (!element?.businessObject) return;

    // Mutate $attrs in place. Re-assigning the property tripped on at
    // least one moddle build where the bag was non-writable; in-place
    // mutation is the documented contract.
    const bo = element.businessObject as { $attrs?: Record<string, string | undefined> };
    if (!bo.$attrs) {
      bo.$attrs = {};
    }
    if (value === null || value === undefined || value === '') {
      delete bo.$attrs[key];
    } else {
      bo.$attrs[key] = value;
    }

    this.scheduleAutoSave();
    this.broadcastDiagramToPeers();
  }

  private hydrateAssignedUserFromXml(element: any): void {
    if (!element?.businessObject) return;
    const elementId = element.id;
    if (Object.prototype.hasOwnProperty.call(this.assignedUserIdsByElementId(), elementId)) {
      return;
    }
    const fromXml = readAssignedUsersExtension(element);
    if (fromXml.length === 0) return;
    const next = { ...this.assignedUserIdsByElementId(), [elementId]: fromXml };
    this.assignedUserIdsByElementId.set(next);
  }

  // ── Save / export ───────────────────────────────────────────────────────

  private collectGraph(): ParsedDiagram | null {
    if (!this.modeler) return null;
    const registry = this.modeler.get<any>('elementRegistry');
    const all = registry.getAll();
    return extractPolicyGraph(
      all,
      {},
      this.formIdsByElementId(),
      (id) => this.catalog.getSync(id)?.formDefinition ?? null,
      this.assignedUserIdsByElementId(),
      this.assignmentTypesByElementId(),
      this.branchLabelsByElementId()
    );
  }

  runValidation(): boolean {
    const graph = this.collectGraph();
    if (!graph) {
      this.validationErrors.set(['El modelador no está listo.']);
      return false;
    }
    const result = validateGraph(graph);
    const errors = [...result.errors];

    // Start form is mandatory for policies. Unlike task forms (which are
    // optional approval-vs-form switches), the consultor-facing start form
    // is the contract for the data the customer must provide before the
    // engine can boot a trámite.
    if (!this.startFormDefinition()?.fields?.length) {
      errors.push(
        'Debes configurar el formulario inicial de la política antes de guardar.'
      );
    }

    this.validationErrors.set(errors);
    if (errors.length === 0) {
      this.statusMessage.set('El diagrama es válido.');
      this.status.set('idle');
    } else {
      this.statusMessage.set('El diagrama tiene errores de validación.');
      this.status.set('error');
    }
    return errors.length === 0;
  }

  async savePolicy(): Promise<void> {
    if (!this.modeler) return;
    if (!this.runValidation()) {
      // The footer bar shows each error individually, but it's easy to miss
      // while the user's attention is on the canvas. Surface the failure
      // through the same toast used for server-side errors so the admin sees
      // it immediately next to the Guardar button.
      const errs = this.validationErrors();
      this.showToast({
        kind: 'error',
        title: 'No se puede guardar: el diagrama tiene errores',
        detail:
          errs.length === 0
            ? 'Corrige los problemas marcados e inténtalo nuevamente.'
            : errs.join(' • ')
      });
      return;
    }
    const graph = this.collectGraph();
    if (!graph) return;

    // Export the BPMN XML so the backend can rehydrate the visual diagram
    // verbatim on re-open. If the export fails we block the save: a policy
    // without XML can't be edited again (the Políticas catalog would open
    // it with a blank canvas), so it's better to surface the error now.
    let bpmnXml: string;
    try {
      bpmnXml = await this.exporter.exportXml(this.modeler);
    } catch (err) {
      console.error('Failed to export BPMN XML at save time', err);
      this.status.set('error');
      this.statusMessage.set('No se pudo serializar el diagrama.');
      this.showToast({
        kind: 'error',
        title: 'No se pudo serializar el diagrama',
        detail: 'Intenta guardar nuevamente; si el error persiste, recarga el editor.'
      });
      return;
    }

    const draft: PolicyDraft = {
      name: this.policyName().trim() || 'Proceso sin título',
      description: this.policyDescription().trim() || undefined,
      status: 'DRAFT',
      bpmnXml,
      startFormDefinition: this.startFormDefinition(),
      startFormSchema: this.startFormSchema(),
      lanes: graph.lanes,
      activities: graph.activities,
      flows: graph.flows
    };

    const editId = this.editingPolicyId();
    const request$ = editId
      ? this.policyService.updatePolicyStructure(editId, draft)
      : this.policyService.savePolicyStructure(draft);
    const isUpdate = !!editId;

    this.status.set('saving');
    this.statusMessage.set(isUpdate ? 'Actualizando…' : 'Guardando…');
    request$.subscribe({
      next: (saved) => {
        this.status.set('saved');
        this.statusMessage.set(
          isUpdate
            ? `Proceso actualizado (id: ${saved.id}).`
            : `Proceso guardado (id: ${saved.id}).`
        );
        this.showToast({
          kind: 'success',
          title: isUpdate ? 'Proceso actualizado' : 'Proceso guardado',
          detail: `«${saved.name}» se registró correctamente.`
        });
        if (isUpdate) {
          // Keep the admin on the edit page with the diagram intact so they
          // can continue iterating. The backend already owns the updated
          // policy; no local state needs wiping.
          this.diagramState.clear();
        } else {
          // Wipe the canvas so the admin can author another process
          // immediately. The backend now owns this policy; we don't want the
          // auto-save to re-hydrate the stale draft on next navigation.
          void this.resetCanvas();
        }
      },
      error: (err) => {
        this.status.set('error');
        const msg = err?.error?.message ?? err?.message ?? 'Error desconocido';
        this.statusMessage.set(
          isUpdate ? `Error al actualizar: ${msg}` : `Error al guardar: ${msg}`
        );
        this.showToast({
          kind: 'error',
          title: isUpdate ? 'No se pudo actualizar el proceso' : 'No se pudo guardar el proceso',
          detail: msg
        });
      }
    });
  }

  // ── Edit mode (metadata-only preload) ───────────────────────────────

  private loadPolicyForEdit(id: string): void {
    this.policyService.getPolicy(id).subscribe({
      next: (policy) => {
        this.suppressAutoSave = true;
        this.policyName.set(policy.name || 'Proceso sin título');
        this.policyDescription.set(policy.description ?? '');
        this.startFormDefinition.set(policy.startFormDefinition ?? null);
        this.startFormSchema.set(policy.startFormSchema ?? null);

        // Rehydrate the canvas from the persisted BPMN XML so every shape,
        // waypoint, lane and custom extension (workflow:formId,
        // workflow:assignedUserId, …) reappears exactly as the admin left
        // it. If the XML is missing (older policies created before this
        // field was wired up) we fall back to an empty canvas and warn.
        void this.restoreDiagramFromXml(policy.bpmnXml ?? null);
      },
      error: (err) => {
        this.showToast({
          kind: 'error',
          title: 'No se pudo cargar la política',
          detail:
            (err as { error?: { message?: string } })?.error?.message ??
            (err as { message?: string })?.message ??
            'Inténtalo nuevamente.'
        });
      }
    });
  }

  /**
   * Walks every element currently in the modeler's registry and runs the
   * three per-element hydrators. Called immediately after a successful
   * `importXML` so the live state maps mirror what the diagram actually
   * declares before the admin makes any change. Idempotent — each
   * hydrator no-ops when the map already has an entry for that element.
   */
  private rehydrateLiveStateFromXml(): void {
    if (!this.modeler) return;
    const registry = this.modeler.get<any>('elementRegistry');
    const elements: any[] = registry.getAll();
    for (const element of elements) {
      if (!element?.businessObject) continue;
      this.hydrateFormIdFromXml(element);
      this.hydrateAssignedUserFromXml(element);
      this.hydrateAssignmentTypeFromXml(element);
    }
  }

  private async restoreDiagramFromXml(xml: string | null): Promise<void> {
    if (!this.modeler) return;

    if (!xml || !xml.trim()) {
      setTimeout(() => (this.suppressAutoSave = false), 0);
      this.showToast({
        kind: 'success',
        title: 'Política cargada',
        detail:
          'El lienzo quedó en blanco porque esta política no conserva el ' +
          'diagrama original. Al guardar lo registraremos para futuras ediciones.'
      });
      return;
    }

    try {
      await this.modeler.importXML(ensureWorkflowNamespace(xml));
      // Eagerly rehydrate the per-element state maps from the BPMN extension
      // attributes the moment the diagram is back in memory. Without this,
      // `assignedUserIdsByElementId` (and the form/assignment-type siblings)
      // start empty in edit mode — they only got populated when the admin
      // manually selected an element. Saving while still in that empty state
      // shipped `assignedUserIds: []` to the backend and silently wiped out
      // every previously-persisted assignee on activities the admin never
      // re-opened. Hydrating up front keeps the live state in sync with what
      // is actually drawn on the canvas.
      this.rehydrateLiveStateFromXml();
      setTimeout(() => (this.suppressAutoSave = false), 0);
      this.showToast({
        kind: 'success',
        title: 'Política cargada',
        detail: 'Se restauró el diagrama tal como se guardó por última vez.'
      });
    } catch (err) {
      console.error('Failed to re-import stored BPMN XML', err);
      setTimeout(() => (this.suppressAutoSave = false), 0);
      this.showToast({
        kind: 'error',
        title: 'No se pudo reconstruir el diagrama',
        detail:
          'El XML guardado no es válido. Puedes redibujar el proceso y ' +
          'guardarlo nuevamente para reemplazarlo.'
      });
    }
  }

  // ── Toast (success / error banner) ──────────────────────────────────

  /**
   * Pop a toast banner. Auto-dismisses after 3.5 s for success and 6 s
   * for errors (longer, so the admin can actually read the detail before
   * it disappears). Calling again replaces any in-flight toast cleanly.
   */
  showToast(payload: { kind: 'success' | 'error'; title: string; detail?: string }): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast.set(payload);
    const ttl = payload.kind === 'error' ? 6000 : 3500;
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.toast.set(null);
    }, ttl);
  }

  dismissToast(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toast.set(null);
  }

  /**
   * Resets the modeler to a blank starter diagram and clears every piece
   * of per-diagram state. Used after a successful save and by the
   * "Nuevo" toolbar button (with a confirm gate in {@link newDiagram}).
   */
  private async resetCanvas(): Promise<void> {
    if (!this.modeler) return;
    this.suppressAutoSave = true;
    this.diagramState.clear();

    try {
      await this.modeler.importXML(EMPTY_POLICY_DIAGRAM);
    } catch (err) {
      console.error('Failed to load empty diagram', err);
    }

    this.selected.set(null);
    this.selectedName.set('');
    this.formIdsByElementId.set({});
    this.assignedUserIdsByElementId.set({});
    this.assignmentTypesByElementId.set({});
    this.policyName.set('');
    this.policyDescription.set('');
    this.startFormDefinition.set(null);
    this.startFormSchema.set(null);
    this.editingPolicyId.set(null);
    this.status.set('idle');
    this.statusMessage.set('');
    this.validationErrors.set([]);

    setTimeout(() => {
      this.suppressAutoSave = false;
    }, 0);
  }

  // ── Download menu ───────────────────────────────────────────────────

  toggleExportMenu(): void {
    this.exportMenuOpen.update((v) => !v);
  }

  closeExportMenu(): void {
    this.exportMenuOpen.set(false);
  }

  async downloadBpmn(): Promise<void> {
    if (!this.modeler) return;
    this.closeExportMenu();
    try {
      const xml = await this.exporter.exportXml(this.modeler);
      this.exporter.downloadText(xml, `${this.fileBaseName()}.bpmn`, 'application/xml');
    } catch (err) {
      console.error('Export BPMN failed', err);
    }
  }

  async downloadSvg(): Promise<void> {
    if (!this.modeler) return;
    this.closeExportMenu();
    try {
      const svg = await this.exporter.exportSvg(this.modeler);
      this.exporter.downloadText(svg, `${this.fileBaseName()}.svg`, 'image/svg+xml');
    } catch (err) {
      console.error('Export SVG failed', err);
    }
  }

  async downloadPng(): Promise<void> {
    if (!this.modeler) return;
    this.closeExportMenu();
    try {
      const blob = await this.exporter.exportPng(this.modeler, 2);
      this.exporter.downloadBlob(blob, `${this.fileBaseName()}.png`);
    } catch (err) {
      console.error('Export PNG failed', err);
    }
  }

  private fileBaseName(): string {
    return this.policyName().trim().replace(/\s+/g, '_') || 'proceso';
  }

  // ── New diagram (explicit reset) ───────────────────────────────────

  async newDiagram(): Promise<void> {
    if (!this.modeler) return;
    const confirmed = window.confirm(
      '¿Crear un nuevo proceso? Se descartará el diagrama actual y no se podrá recuperar.'
    );
    if (!confirmed) return;
    await this.resetCanvas();
  }
}
