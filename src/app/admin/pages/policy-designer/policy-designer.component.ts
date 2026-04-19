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
import {
  EMPTY_POLICY_DIAGRAM,
  FORM_ID_KEY,
  ParsedDiagram,
  extractPolicyGraph,
  readFormIdExtension,
  validateGraph
} from './bpmn-parser';

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
  private readonly router = inject(Router);
  private modeler: BpmnModeler | null = null;

  readonly policyName = signal('New Policy');
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

  async ngAfterViewInit(): Promise<void> {
    this.modeler = new BpmnModeler({
      container: this.canvasRef.nativeElement,
      keyboard: { bindTo: document }
    });

    try {
      await this.modeler.importXML(EMPTY_POLICY_DIAGRAM);
    } catch (err) {
      console.error('Failed to import starter diagram', err);
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

      // Lazy-hydrate the form-id state from any previously saved XML.
      this.hydrateFormIdFromXml(element);
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
  }

  ngOnDestroy(): void {
    this.modeler?.destroy();
    this.modeler = null;
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

  // ── Save / export ───────────────────────────────────────────────────────

  private collectGraph(): ParsedDiagram | null {
    if (!this.modeler) return null;
    const registry = this.modeler.get<any>('elementRegistry');
    const all = registry.getAll();
    return extractPolicyGraph(
      all,
      {},
      this.formIdsByElementId(),
      (id) => this.catalog.getSync(id)?.formDefinition ?? null
    );
  }

  runValidation(): boolean {
    const graph = this.collectGraph();
    if (!graph) {
      this.validationErrors.set(['Modeler is not ready.']);
      return false;
    }
    const result = validateGraph(graph);
    this.validationErrors.set(result.errors);
    if (result.ok) {
      this.statusMessage.set('Diagram is valid.');
      this.status.set('idle');
    } else {
      this.statusMessage.set('Diagram has validation errors.');
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
    this.statusMessage.set('Saving…');
    this.policyService.savePolicyStructure(draft).subscribe({
      next: (saved) => {
        this.status.set('saved');
        this.statusMessage.set(`Policy saved (id: ${saved.id}).`);
      },
      error: (err) => {
        this.status.set('error');
        const msg = err?.error?.message ?? err?.message ?? 'Unknown error';
        this.statusMessage.set(`Save failed: ${msg}`);
      }
    });
  }

  async exportXml(): Promise<void> {
    if (!this.modeler) return;
    try {
      const { xml } = await this.modeler.saveXML({ format: true });
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.policyName().replace(/\s+/g, '_') || 'policy'}.bpmn`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed', err);
    }
  }

  async resetDiagram(): Promise<void> {
    if (!this.modeler) return;
    await this.modeler.importXML(EMPTY_POLICY_DIAGRAM);
    this.selected.set(null);
    this.selectedName.set('');
    this.formIdsByElementId.set({});
    this.status.set('idle');
    this.statusMessage.set('');
    this.validationErrors.set([]);
  }
}
