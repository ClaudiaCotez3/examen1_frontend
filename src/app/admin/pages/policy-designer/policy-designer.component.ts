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
import { FormCatalogEntry } from '../../../core/models/form-catalog.model';
import { FormCatalogService } from '../../../core/services/form-catalog.service';
import { Role } from '../../../core/models/role.model';
import { User } from '../../../core/models/user.model';
import { RoleService } from '../../../core/services/role.service';
import { UserService } from '../../../core/services/user.service';
import { BpmnExportService } from '../../../core/services/bpmn-export.service';
import { DiagramStateService } from '../../../core/services/diagram-state.service';
import {
  ASSIGNED_USER_KEY,
  ASSIGNMENT_TYPE_KEY,
  EMPTY_POLICY_DIAGRAM,
  FORM_ID_KEY,
  ParsedDiagram,
  extractPolicyGraph,
  readAssignedUsersExtension,
  readAssignmentTypeExtension,
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
  private modeler: BpmnModeler | null = null;

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
   * Requisitos previos of the *process* (e.g. "Documento de identidad",
   * "Factura de luz"). Not per activity — they must be satisfied before the
   * process can be initiated at all.
   */
  readonly prerequisites = signal<string[]>([]);

  // ── Selection + per-activity state ────────────────────────────────────
  readonly selected = signal<SelectedNode | null>(null);
  readonly selectedName = signal('');

  readonly formIdsByElementId = signal<Record<string, string | null>>({});

  readonly availableForms = computed<FormCatalogEntry[]>(() => this.catalog.entries());

  readonly assignedUserIdsByElementId = signal<Record<string, string[]>>({});

  /** Assignment mode per activity. Defaults to DEPARTMENT on first select. */
  readonly assignmentTypesByElementId = signal<Record<string, AssignmentType>>({});

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
    const startingXml = draft?.xml ?? EMPTY_POLICY_DIAGRAM;
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
      this.prerequisites.set(draft.prerequisites ?? []);
      this.formIdsByElementId.set(draft.formIds ?? {});
      this.assignedUserIdsByElementId.set(draft.assignedUserIds ?? {});
      this.assignmentTypesByElementId.set(draft.assignmentTypes ?? {});
    }

    if (editId) {
      this.editingPolicyId.set(editId);
      this.loadPolicyForEdit(editId);
    }

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

    eventBus.on('commandStack.changed', () => this.scheduleAutoSave());

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
    this.modeler?.destroy();
    this.modeler = null;
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
        prerequisites: this.prerequisites(),
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

  // ── Process-level prerequisites ─────────────────────────────────────

  addPrerequisite(): void {
    this.prerequisites.update((list) => [...list, '']);
    this.scheduleAutoSave();
  }

  updatePrerequisite(index: number, value: string): void {
    this.prerequisites.update((list) => {
      if (index < 0 || index >= list.length) return list;
      const next = list.slice();
      next[index] = value;
      return next;
    });
    this.scheduleAutoSave();
  }

  removePrerequisite(index: number): void {
    this.prerequisites.update((list) => {
      if (index < 0 || index >= list.length) return list;
      const next = list.slice();
      next.splice(index, 1);
      return next;
    });
    this.scheduleAutoSave();
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
    if (!this.modeler) return;
    const registry = this.modeler.get<any>('elementRegistry');
    const modeling = this.modeler.get<any>('modeling');
    const element = registry.get(elementId);
    if (!element) return;

    const payload: Record<string, string | null> = {};
    payload[FORM_ID_KEY] = formId;
    try {
      modeling.updateProperties(element, payload);
    } catch {
      const attrs = (element.businessObject as any).$attrs ?? {};
      attrs[FORM_ID_KEY] = formId ?? undefined;
      (element.businessObject as any).$attrs = attrs;
    }
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
    if (!this.modeler) return;
    const registry = this.modeler.get<any>('elementRegistry');
    const modeling = this.modeler.get<any>('modeling');
    const element = registry.get(elementId);
    if (!element) return;

    const payload: Record<string, string | null> = {};
    payload[ASSIGNMENT_TYPE_KEY] = type;
    try {
      modeling.updateProperties(element, payload);
    } catch {
      const attrs = (element.businessObject as any).$attrs ?? {};
      attrs[ASSIGNMENT_TYPE_KEY] = type;
      (element.businessObject as any).$attrs = attrs;
    }
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
    if (!this.modeler) return;
    const registry = this.modeler.get<any>('elementRegistry');
    const modeling = this.modeler.get<any>('modeling');
    const element = registry.get(elementId);
    if (!element) return;

    const serialized = list.length > 0 ? JSON.stringify(list) : null;
    const payload: Record<string, string | null> = {};
    payload[ASSIGNED_USER_KEY] = serialized;
    try {
      modeling.updateProperties(element, payload);
    } catch {
      const attrs = (element.businessObject as any).$attrs ?? {};
      attrs[ASSIGNED_USER_KEY] = serialized ?? undefined;
      (element.businessObject as any).$attrs = attrs;
    }
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
      this.assignmentTypesByElementId()
    );
  }

  runValidation(): boolean {
    const graph = this.collectGraph();
    if (!graph) {
      this.validationErrors.set(['El modelador no está listo.']);
      return false;
    }
    const result = validateGraph(graph);
    this.validationErrors.set(result.errors);
    if (result.ok) {
      this.statusMessage.set('El diagrama es válido.');
      this.status.set('idle');
    } else {
      this.statusMessage.set('El diagrama tiene errores de validación.');
      this.status.set('error');
    }
    return result.ok;
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

    const cleanedPrerequisites = this.prerequisites()
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

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
      prerequisites: cleanedPrerequisites,
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
        this.prerequisites.set(policy.prerequisites ?? []);

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
      await this.modeler.importXML(xml);
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
    this.prerequisites.set([]);
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
