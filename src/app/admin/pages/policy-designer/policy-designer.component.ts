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
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import BpmnModeler from 'bpmn-js/lib/Modeler';

import { PolicyService } from '../../../core/services/policy.service';
import { PolicyDraft } from '../../../core/models/policy.model';
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
  EMPTY_POLICY_DIAGRAM,
  FORM_ID_KEY,
  ParsedDiagram,
  REQUIREMENTS_KEY,
  extractPolicyGraph,
  readAssignedUsersExtension,
  readFormIdExtension,
  readRequirementsExtension,
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

/** BPMN $types that accept a dynamic form (user-level work items). */
const FORMABLE_TYPES = new Set([
  'bpmn:Task',
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ManualTask',
  'bpmn:ScriptTask'
]);

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
  private readonly exporter = inject(BpmnExportService);
  private readonly diagramState = inject(DiagramStateService);
  private modeler: BpmnModeler | null = null;

  /** Debounce handle for auto-save; cleared/rescheduled on each edit. */
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Skip auto-save while the initial XML import/restore is in flight. */
  private suppressAutoSave = true;
  /** Reactive flag used by the toolbar to show "Guardando..." / timestamp. */
  readonly lastSavedAt = this.diagramState.lastSavedAt;
  /** Dropdown open-state for the "Descargar" export menu. */
  readonly exportMenuOpen = signal(false);

  readonly policyName = signal('Nueva política');
  readonly policyDescription = signal('');

  readonly selected = signal<SelectedNode | null>(null);
  readonly selectedName = signal('');

  /**
   * Catalog form id assigned to each BPMN element, keyed by element.id.
   *
   * This map is the authoritative source of "which form is attached to which
   * activity" during an editing session. It is merged into the diagram XML
   * (via FORM_ID_KEY on each Task) and resolved against the live catalog at
   * save time so the backend receives the full FormDefinition denormalized.
   */
  readonly formIdsByElementId = signal<Record<string, string | null>>({});

  /** Live snapshot of the catalog, used by the "Assign form" dropdown. */
  readonly availableForms = computed<FormCatalogEntry[]>(() => this.catalog.entries());

  /**
   * Operator ids assigned to each BPMN element, keyed by element.id. Multi-
   * value to reflect real-world practice (a task can be picked up by any
   * member of a team). Same persistence pattern as {@link formIdsByElementId}:
   * authoritative during the editing session, mirrored into the BPMN XML
   * as a JSON array, and consumed by `extractPolicyGraph` at save time.
   */
  readonly assignedUserIdsByElementId = signal<Record<string, string[]>>({});

  /**
   * Business requirements (customer-provided inputs like "Documento de
   * identidad", "Factura de luz") attached to each Task, keyed by element.id.
   * Authoritative during the editing session; mirrored into the BPMN XML via
   * {@link REQUIREMENTS_KEY} so the diagram round-trips.
   */
  readonly requirementsByElementId = signal<Record<string, string[]>>({});

  /** Full user list pulled from the backend; used to render the dropdown. */
  readonly allUsers = signal<User[]>([]);
  /** Role catalog cache so we can filter `allUsers` by role name. */
  readonly allRoles = signal<Role[]>([]);

  /**
   * Operators only — the dropdown deliberately excludes ADMIN/SUPERVISOR/
   * CONSULTATION because those roles are not workflow executors. Listing
   * them would tempt assigning work that they cannot pick up at runtime.
   */
  readonly operatorUsers = computed<User[]>(() => {
    const opRole = this.allRoles().find((r) => r.name === 'OPERATOR');
    if (!opRole) return [];
    return this.allUsers().filter((u) => u.roleId === opRole.id && u.active);
  });

  /** Ids assigned to the currently selected activity (empty array when none). */
  readonly selectedAssignedUserIds = computed<string[]>(() => {
    const node = this.selected();
    if (!node) return [];
    return this.assignedUserIdsByElementId()[node.elementId] ?? [];
  });

  /** Resolved User objects for the currently assigned ids (for chip list). */
  readonly assignedUsers = computed<User[]>(() => {
    const ids = this.selectedAssignedUserIds();
    if (ids.length === 0) return [];
    const index = new Map(this.allUsers().map((u) => [u.id, u]));
    return ids.map((id) => index.get(id)).filter((u): u is User => !!u);
  });

  /** Operators that can still be added to the current activity. */
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

  /** Form id assigned to the currently selected element, or empty string. */
  readonly selectedFormId = computed<string>(() => {
    const node = this.selected();
    if (!node) return '';
    return this.formIdsByElementId()[node.elementId] ?? '';
  });

  /** Resolved catalog entry for the selected element's assigned form. */
  readonly assignedForm = computed<FormCatalogEntry | null>(() => {
    const id = this.selectedFormId();
    if (!id) return null;
    return this.availableForms().find((f) => f.id === id) ?? null;
  });

  /** Requirements list attached to the currently selected activity. */
  readonly selectedRequirements = computed<string[]>(() => {
    const node = this.selected();
    if (!node) return [];
    return this.requirementsByElementId()[node.elementId] ?? [];
  });

  async ngAfterViewInit(): Promise<void> {
    // Load the user catalog + role catalog in parallel so the "Assign user"
    // dropdown is ready as soon as an activity is selected.
    this.userService.getAll().subscribe({
      next: (users) => this.allUsers.set(users),
      error: (err) => console.warn('Failed to load users', err)
    });
    this.roleService.load().subscribe({
      next: (roles) => this.allRoles.set(roles),
      error: (err) => console.warn('Failed to load roles', err)
    });

    this.modeler = new BpmnModeler({
      container: this.canvasRef.nativeElement,
      keyboard: { bindTo: document }
    });

    // Replace the single "append gateway" context-pad icon with three
    // explicit gateway-type buttons (XOR / AND / OR) so business users
    // don't have to discover the wrench/replace menu.
    registerGatewayContextPadEntries(this.modeler);
    // Add a "…" button to the context pad that opens a categorized,
    // searchable popup of every element type that can be appended.
    registerAppendElementPopup(this.modeler);
    // Replace the default left palette with a richer, Spanish-labeled,
    // categorized layout (Eventos / Actividades / Decisiones / Otros).
    registerCustomPalette(this.modeler);
    // Make each category an accordion (collapsed by default) so the
    // palette doesn't overflow the canvas when there are many entries.
    setupCollapsiblePaletteSections(this.modeler);

    // Restore the previous editing session if one was persisted by the
    // auto-saver. Fall back to the starter diagram for a brand-new session.
    const draft = this.diagramState.load();
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
      this.policyName.set(draft.name || 'Nueva política');
      this.policyDescription.set(draft.description || '');
      this.formIdsByElementId.set(draft.formIds ?? {});
      this.assignedUserIdsByElementId.set(draft.assignedUserIds ?? {});
      this.requirementsByElementId.set(draft.requirements ?? {});
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

      // Lazy-hydrate the form-id + assigned-user + requirements state from any
      // previously saved XML so the sidebar reflects the persisted assignment.
      this.hydrateFormIdFromXml(element);
      this.hydrateAssignedUserFromXml(element);
      this.hydrateRequirementsFromXml(element);
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

    // Auto-save: any shape move, rename, connection, or property change
    // fires commandStack.changed. We debounce writes so rapid edits (e.g.
    // dragging an element) don't spam localStorage.
    eventBus.on('commandStack.changed', () => this.scheduleAutoSave());

    // The initial importXML itself fires commandStack events; unblock
    // persistence only after the first tick has settled.
    setTimeout(() => {
      this.suppressAutoSave = false;
    }, 0);
  }

  ngOnDestroy(): void {
    // Flush any pending auto-save before tearing down so the user doesn't
    // lose the last edit when they navigate away within the debounce window.
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
      // Fire-and-forget; we're unmounting so we can't await.
      void this.persistDraft();
    }
    this.modeler?.destroy();
    this.modeler = null;
  }

  // ── Auto-save (debounced) ───────────────────────────────────────────

  /** Called when the policy name / description changes in the toolbar. */
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

  /** Serialize current modeler state + sidebar maps into the draft store. */
  private async persistDraft(): Promise<void> {
    if (!this.modeler) return;
    try {
      const xml = await this.exporter.exportXml(this.modeler);
      this.diagramState.save({
        name: this.policyName(),
        description: this.policyDescription(),
        xml,
        formIds: this.formIdsByElementId(),
        assignedUserIds: this.assignedUserIdsByElementId(),
        requirements: this.requirementsByElementId()
      });
    } catch (err) {
      console.warn('Auto-save failed', err);
    }
  }

  /** Push the inline name edit into the bpmn-js model via Modeling service. */
  applyNameChange(): void {
    const node = this.selected();
    if (!this.modeler || !node) return;

    const elementRegistry = this.modeler.get<any>('elementRegistry');
    const modeling = this.modeler.get<any>('modeling');
    const element = elementRegistry.get(node.elementId);
    if (!element) return;
    modeling.updateProperties(element, { name: this.selectedName() });
  }

  // ── Form assignment ──────────────────────────────────────────────────

  /**
   * Assigns a catalog form to the currently selected activity. Pass an empty
   * string to detach. The assignment is persisted both in memory and inside
   * the BPMN XML so it survives export/reload cycles.
   */
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
      // Some moddle setups reject unknown namespaces; fall back to $attrs.
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

  // ── User assignment (multi-assignee) ─────────────────────────────────

  /**
   * Add an operator to the currently selected activity. Duplicates are
   * ignored silently so the dropdown can stay a plain `<select>` without
   * extra guards.
   */
  addUserToActivity(userId: string): void {
    const node = this.selected();
    if (!node || !userId) return;
    const current = this.assignedUserIdsByElementId()[node.elementId] ?? [];
    if (current.includes(userId)) return;
    const nextList = [...current, userId];
    this.persistAssignedUsers(node.elementId, nextList);
  }

  /** Remove a specific operator from the currently selected activity. */
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

  // ── Requirements (customer-provided inputs) ─────────────────────────

  /** Append an empty requirement so the UI can render an editable row. */
  addRequirement(): void {
    const node = this.selected();
    if (!node) return;
    const current = this.requirementsByElementId()[node.elementId] ?? [];
    const nextList = [...current, ''];
    this.persistRequirements(node.elementId, nextList);
  }

  /** Update one requirement by index. Empty strings are kept while editing. */
  updateRequirement(index: number, value: string): void {
    const node = this.selected();
    if (!node) return;
    const current = this.requirementsByElementId()[node.elementId] ?? [];
    if (index < 0 || index >= current.length) return;
    const nextList = current.slice();
    nextList[index] = value;
    this.persistRequirements(node.elementId, nextList);
  }

  /** Remove a requirement row. */
  removeRequirement(index: number): void {
    const node = this.selected();
    if (!node) return;
    const current = this.requirementsByElementId()[node.elementId] ?? [];
    if (index < 0 || index >= current.length) return;
    const nextList = current.slice();
    nextList.splice(index, 1);
    this.persistRequirements(node.elementId, nextList);
  }

  private persistRequirements(elementId: string, list: string[]): void {
    const next = { ...this.requirementsByElementId(), [elementId]: list };
    this.requirementsByElementId.set(next);
    this.writeRequirementsToBpmn(elementId, list);
  }

  private writeRequirementsToBpmn(elementId: string, list: string[]): void {
    if (!this.modeler) return;
    const registry = this.modeler.get<any>('elementRegistry');
    const modeling = this.modeler.get<any>('modeling');
    const element = registry.get(elementId);
    if (!element) return;

    // Strip trailing empty rows before persisting; empty strings are fine in
    // the live signal (so users can type) but shouldn't leak into the XML.
    const cleaned = list.map((s) => s.trim()).filter((s) => s.length > 0);
    const serialized = cleaned.length > 0 ? JSON.stringify(cleaned) : null;

    const payload: Record<string, string | null> = {};
    payload[REQUIREMENTS_KEY] = serialized;
    try {
      modeling.updateProperties(element, payload);
    } catch {
      const attrs = (element.businessObject as any).$attrs ?? {};
      attrs[REQUIREMENTS_KEY] = serialized ?? undefined;
      (element.businessObject as any).$attrs = attrs;
    }
  }

  private hydrateRequirementsFromXml(element: any): void {
    if (!element?.businessObject) return;
    const elementId = element.id;
    if (Object.prototype.hasOwnProperty.call(this.requirementsByElementId(), elementId)) {
      return;
    }
    const fromXml = readRequirementsExtension(element);
    if (fromXml.length === 0) return;
    const next = { ...this.requirementsByElementId(), [elementId]: fromXml };
    this.requirementsByElementId.set(next);
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
      this.assignedUserIdsByElementId()
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
      return;
    }
    const graph = this.collectGraph();
    if (!graph) return;

    const draft: PolicyDraft = {
      name: this.policyName().trim() || 'Untitled Policy',
      description: this.policyDescription().trim() || undefined,
      status: 'DRAFT',
      lanes: graph.lanes,
      activities: graph.activities,
      flows: graph.flows
    };

    this.status.set('saving');
    this.statusMessage.set('Guardando…');
    this.policyService.savePolicyStructure(draft).subscribe({
      next: (saved) => {
        this.status.set('saved');
        this.statusMessage.set(`Política guardada (id: ${saved.id}).`);
        // The backend now owns this policy; drop the local draft so the next
        // session starts fresh instead of re-hydrating an obsolete version.
        this.diagramState.clear();
      },
      error: (err) => {
        this.status.set('error');
        const msg = err?.error?.message ?? err?.message ?? 'Error desconocido';
        this.statusMessage.set(`Error al guardar: ${msg}`);
      }
    });
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
    return this.policyName().trim().replace(/\s+/g, '_') || 'policy';
  }

  // ── New diagram (explicit reset) ───────────────────────────────────

  /**
   * Clears the draft and loads the starter diagram. Requires explicit
   * confirmation so users don't wipe work by mis-clicking the button.
   */
  async newDiagram(): Promise<void> {
    if (!this.modeler) return;
    const confirmed = window.confirm(
      '¿Crear un nuevo diagrama? Se descartará el diagrama actual y no se podrá recuperar.'
    );
    if (!confirmed) return;

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
    this.requirementsByElementId.set({});
    this.policyName.set('Nueva política');
    this.policyDescription.set('');
    this.status.set('idle');
    this.statusMessage.set('');
    this.validationErrors.set([]);

    setTimeout(() => {
      this.suppressAutoSave = false;
    }, 0);
  }
}
