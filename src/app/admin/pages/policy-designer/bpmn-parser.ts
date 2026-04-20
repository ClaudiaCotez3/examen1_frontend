import {
  ActivityDraft,
  ActivityType,
  FlowDraft,
  FlowType,
  LaneDraft
} from '../../../core/models/policy.model';
import { FormDefinition } from '../../../core/models/form.model';

/**
 * Namespaced attributes written into a Task's BPMN business object so the
 * diagram round-trips form metadata across save/reload cycles without
 * requiring a custom moddle descriptor.
 *
 *   - {@link FORM_ID_KEY} stores the *catalog reference* (preferred). Forms
 *     are authored once in the Form Management module and referenced by id.
 *   - {@link FORM_EXTENSION_KEY} held the inline JSON definition in the
 *     legacy "form authored inside the activity" model. Still read for
 *     backwards compatibility with diagrams saved before the catalog existed.
 */
export const FORM_ID_KEY = 'workflow:formId';
export const FORM_EXTENSION_KEY = 'workflow:formDefinition';
/**
 * Catalog user id assigned to an activity at design time. Persisted as a
 * namespaced attribute on the Task's businessObject so it survives BPMN
 * export/reload cycles, exactly like {@link FORM_ID_KEY}.
 */
export const ASSIGNED_USER_KEY = 'workflow:assignedUserId';
/**
 * Business requirements (documents / inputs) the customer must provide for a
 * Task. Stored as a JSON-serialized array of strings on the business object
 * so it round-trips through BPMN export/reload like the other custom attrs.
 */
export const REQUIREMENTS_KEY = 'workflow:requirements';

/**
 * Reads the catalog form id persisted on a Task's extensionElements.
 * Returns null when no form is attached.
 */
export function readFormIdExtension(el: BpmnElement): string | null {
  const bo = el.businessObject as Record<string, unknown>;
  const ext = bo['extensionElements'] as Record<string, unknown> | undefined;
  const attrs = bo['$attrs'] as Record<string, unknown> | undefined;
  const raw = attrs?.[FORM_ID_KEY] ?? ext?.[FORM_ID_KEY];
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

/**
 * Reads the set of operators assigned to a Task's extensionElements.
 *
 * Accepts three persisted shapes to keep older diagrams readable:
 *   - JSON array string, e.g. `["u1","u2"]` (current format)
 *   - Plain string, e.g. `"u1"`            (legacy single-assignee format)
 *   - Missing / empty value                 → returns `[]`
 */
export function readAssignedUsersExtension(el: BpmnElement): string[] {
  const bo = el.businessObject as Record<string, unknown>;
  const ext = bo['extensionElements'] as Record<string, unknown> | undefined;
  const attrs = bo['$attrs'] as Record<string, unknown> | undefined;
  const raw = attrs?.[ASSIGNED_USER_KEY] ?? ext?.[ASSIGNED_USER_KEY];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    } catch {
      return [];
    }
  }
  return [trimmed];
}

/**
 * Reads the business requirements (array of strings) persisted on a Task's
 * extensionElements. Tolerates missing / malformed JSON and returns an empty
 * array so the designer can safely initialize the UI.
 */
export function readRequirementsExtension(el: BpmnElement): string[] {
  const bo = el.businessObject as Record<string, unknown>;
  const ext = bo['extensionElements'] as Record<string, unknown> | undefined;
  const attrs = bo['$attrs'] as Record<string, unknown> | undefined;
  const raw = attrs?.[REQUIREMENTS_KEY] ?? ext?.[REQUIREMENTS_KEY];
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/**
 * Reads the JSON form schema persisted on a Task's extensionElements.
 * Tolerates missing / malformed values and simply returns null so the
 * designer falls back to the in-memory draft map.
 */
export function readFormExtension(el: BpmnElement): FormDefinition | null {
  const bo = el.businessObject as Record<string, unknown>;
  const ext = bo['extensionElements'] as Record<string, unknown> | undefined;
  const attrs = bo['$attrs'] as Record<string, unknown> | undefined;
  const raw = attrs?.[FORM_EXTENSION_KEY] ?? ext?.[FORM_EXTENSION_KEY];
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as FormDefinition;
    return parsed?.fields ? parsed : null;
  } catch {
    return null;
  }
}

/** Shape returned by bpmn-js ElementRegistry.getAll(). */
interface BpmnElement {
  id: string;
  type: string;
  businessObject: {
    id: string;
    $type: string;
    name?: string;
    flowNodeRef?: Array<{ id: string }>;
    sourceRef?: { id: string };
    targetRef?: { id: string };
    conditionExpression?: { body?: string };
    [key: string]: unknown;
  };
}

export interface ParsedDiagram {
  lanes: LaneDraft[];
  activities: ActivityDraft[];
  flows: FlowDraft[];
}

const ACTIVITY_NODE_TYPES = new Set([
  'bpmn:Task',
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ManualTask',
  'bpmn:ScriptTask',
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:ExclusiveGateway',
  'bpmn:InclusiveGateway',
  'bpmn:ParallelGateway',
  'bpmn:EventBasedGateway'
]);

function mapActivityType(bpmnType: string): ActivityType {
  if (bpmnType === 'bpmn:StartEvent') {
    return 'START';
  }
  if (bpmnType === 'bpmn:EndEvent') {
    return 'END';
  }
  if (bpmnType.endsWith('Gateway')) {
    return 'DECISION';
  }
  return 'TASK';
}

function mapFlowType(el: BpmnElement, sourceActivityType: ActivityType | undefined): FlowType {
  if (el.businessObject.conditionExpression) {
    return 'CONDITIONAL';
  }
  if (sourceActivityType === 'DECISION') {
    return 'CONDITIONAL';
  }
  return 'LINEAR';
}

/**
 * Traverses the bpmn-js ElementRegistry and produces the {lanes, activities, flows}
 * JSON expected by the backend's `POST /api/policies/full` endpoint.
 *
 * Form resolution order (highest precedence first):
 *   1. `formIdsByClientId` + `catalogResolver` — current-session assignment
 *      from the Policy Designer's "Assign Form" dropdown.
 *   2. `formsByClientId` — legacy in-memory inline definitions (kept for
 *      backwards compatibility with diagrams that pre-date the catalog).
 *   3. extensionElements `workflow:formId` read from the BPMN XML, resolved
 *      via `catalogResolver` if available.
 *   4. extensionElements `workflow:formDefinition` (legacy inline JSON).
 *
 * The output activity always carries a denormalized `formDefinition`, so the
 * backend contract stays unchanged regardless of how the form was sourced.
 *
 * @param elements           raw result of `elementRegistry.getAll()`
 * @param formsByClientId    legacy inline form definitions keyed by element.id
 * @param formIdsByClientId  catalog form ids assigned via the sidebar dropdown
 * @param catalogResolver    function that returns a FormDefinition for a given
 *                           catalog id, or null if missing. Provided by the
 *                           Policy Designer (delegates to FormCatalogService).
 */
export function extractPolicyGraph(
  elements: BpmnElement[],
  formsByClientId: Record<string, FormDefinition | null> = {},
  formIdsByClientId: Record<string, string | null> = {},
  catalogResolver: (id: string) => FormDefinition | null = () => null,
  assignedUserIdsByClientId: Record<string, string[]> = {}
): ParsedDiagram {
  const lanes: LaneDraft[] = [];
  const laneIdByElementId: Record<string, string> = {};
  const laneElements = elements.filter((e) => e.businessObject.$type === 'bpmn:Lane');

  laneElements.forEach((lane, idx) => {
    const clientId = lane.id;
    laneIdByElementId[lane.id] = clientId;
    lanes.push({
      clientId,
      name: lane.businessObject.name?.trim() || `Lane ${idx + 1}`,
      position: idx
    });
  });

  // Build child→lane map via Lane.flowNodeRef
  const elementToLane: Record<string, string> = {};
  for (const lane of laneElements) {
    const refs = lane.businessObject.flowNodeRef ?? [];
    for (const ref of refs) {
      elementToLane[ref.id] = lane.id;
    }
  }

  // Fallback lane when the diagram has no lanes (BPMN plane without participant)
  const hasLanes = lanes.length > 0;
  if (!hasLanes) {
    lanes.push({ clientId: 'lane_default', name: 'Default', position: 0 });
  }

  const activities: ActivityDraft[] = [];
  const activityTypeById: Record<string, ActivityType> = {};

  for (const el of elements) {
    if (!ACTIVITY_NODE_TYPES.has(el.businessObject.$type)) {
      continue;
    }
    const type = mapActivityType(el.businessObject.$type);
    const laneRef = hasLanes ? elementToLane[el.id] ?? lanes[0].clientId : 'lane_default';
    const clientId = el.id;
    activityTypeById[clientId] = type;

    // Resolve the form attached to this activity (see header docstring for
    // precedence rules). The assigned formId from the catalog wins over any
    // legacy inline definition.
    const liveFormId = formIdsByClientId[clientId];
    const xmlFormId = readFormIdExtension(el);
    const effectiveFormId =
      liveFormId !== undefined ? liveFormId : xmlFormId;

    let formDefinition: FormDefinition | null = null;
    if (effectiveFormId) {
      formDefinition = catalogResolver(effectiveFormId);
    }
    if (!formDefinition) {
      const liveForm = formsByClientId[clientId];
      const xmlForm = readFormExtension(el);
      formDefinition = liveForm !== undefined ? liveForm : xmlForm;
    }
    const requiresForm =
      !!formDefinition && (formDefinition.fields?.length ?? 0) > 0;

    // Resolve the assigned users the same way as the form: in-session map
    // first, then any value persisted in the BPMN XML. The singular
    // `assignedUserId` field is derived from the first id for back-compat
    // with backends that still model one assignee per activity.
    const liveAssignedUserIds = assignedUserIdsByClientId[clientId];
    const xmlAssignedUserIds = readAssignedUsersExtension(el);
    const assignedUserIds =
      liveAssignedUserIds !== undefined ? liveAssignedUserIds : xmlAssignedUserIds;
    const primaryAssignedUserId = assignedUserIds.length > 0 ? assignedUserIds[0] : null;

    activities.push({
      clientId,
      name: el.businessObject.name?.trim() || defaultActivityName(type),
      type,
      laneRef,
      requiresForm,
      formDefinition: formDefinition ?? null,
      assignedUserId: primaryAssignedUserId,
      assignedUserIds
    });
  }

  const flows: FlowDraft[] = [];
  for (const el of elements) {
    if (el.businessObject.$type !== 'bpmn:SequenceFlow') {
      continue;
    }
    const sourceId = el.businessObject.sourceRef?.id;
    const targetId = el.businessObject.targetRef?.id;
    if (!sourceId || !targetId) {
      continue;
    }
    flows.push({
      sourceRef: sourceId,
      targetRef: targetId,
      type: mapFlowType(el, activityTypeById[sourceId]),
      condition: el.businessObject.conditionExpression?.body ?? null
    });
  }

  return { lanes, activities, flows };
}

function defaultActivityName(type: ActivityType): string {
  switch (type) {
    case 'START':
      return 'Start';
    case 'END':
      return 'End';
    case 'DECISION':
      return 'Decision';
    default:
      return 'Activity';
  }
}

export interface GraphValidation {
  ok: boolean;
  errors: string[];
}

export function validateGraph(graph: ParsedDiagram): GraphValidation {
  const errors: string[] = [];

  const starts = graph.activities.filter((a) => a.type === 'START');
  const ends = graph.activities.filter((a) => a.type === 'END');
  if (starts.length < 1) {
    errors.push('El diagrama debe contener al menos un evento de Inicio.');
  }
  if (ends.length < 1) {
    errors.push('El diagrama debe contener al menos un evento de Fin.');
  }

  if (graph.activities.length > 1) {
    const connected = new Set<string>();
    for (const f of graph.flows) {
      connected.add(f.sourceRef);
      connected.add(f.targetRef);
    }
    const orphans = graph.activities.filter((a) => !connected.has(a.clientId));
    if (orphans.length > 0) {
      errors.push(
        `Actividades desconectadas: ${orphans.map((o) => o.name || o.clientId).join(', ')}`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Starter diagram with a Collaboration + Participant + two empty Lanes. */
export const EMPTY_POLICY_DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_1" targetNamespace="http://workflow.local/">
  <bpmn:collaboration id="Collaboration_1">
    <bpmn:participant id="Participant_1" name="Policy" processRef="Process_1" />
  </bpmn:collaboration>
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_Customer" name="Customer Service" />
      <bpmn:lane id="Lane_Ops" name="Operations" />
    </bpmn:laneSet>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">
      <bpmndi:BPMNShape id="Participant_1_di" bpmnElement="Participant_1" isHorizontal="true">
        <dc:Bounds x="160" y="80" width="720" height="300" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_Customer_di" bpmnElement="Lane_Customer" isHorizontal="true">
        <dc:Bounds x="190" y="80" width="690" height="150" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_Ops_di" bpmnElement="Lane_Ops" isHorizontal="true">
        <dc:Bounds x="190" y="230" width="690" height="150" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
