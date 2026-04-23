import {
  ActivityDraft,
  ActivityKind,
  ActivityType,
  AssignmentType,
  FlowDraft,
  FlowType,
  LaneDraft
} from '../../../core/models/policy.model';
import { FormDefinition } from '../../../core/models/form.model';

/**
 * Namespaced attributes written into a Task's BPMN business object so the
 * diagram round-trips custom metadata across save/reload cycles without
 * requiring a moddle descriptor extension.
 *
 *   - {@link FORM_ID_KEY}        catalog form reference.
 *   - {@link ASSIGNED_USER_KEY}  JSON array of operator ids.
 *   - {@link ASSIGNMENT_TYPE_KEY} how assignment is resolved at runtime.
 */
export const FORM_ID_KEY = 'workflow:formId';
export const FORM_EXTENSION_KEY = 'workflow:formDefinition';
export const ASSIGNED_USER_KEY = 'workflow:assignedUserId';
export const ASSIGNMENT_TYPE_KEY = 'workflow:assignmentType';

const VALID_ASSIGNMENT_TYPES: AssignmentType[] = [
  'SPECIFIC_USER',
  'CANDIDATE_USERS',
  'DEPARTMENT'
];

export function readFormIdExtension(el: BpmnElement): string | null {
  const bo = el.businessObject as Record<string, unknown>;
  const ext = bo['extensionElements'] as Record<string, unknown> | undefined;
  const attrs = bo['$attrs'] as Record<string, unknown> | undefined;
  const raw = attrs?.[FORM_ID_KEY] ?? ext?.[FORM_ID_KEY];
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

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

export function readAssignmentTypeExtension(el: BpmnElement): AssignmentType | null {
  const bo = el.businessObject as Record<string, unknown>;
  const ext = bo['extensionElements'] as Record<string, unknown> | undefined;
  const attrs = bo['$attrs'] as Record<string, unknown> | undefined;
  const raw = attrs?.[ASSIGNMENT_TYPE_KEY] ?? ext?.[ASSIGNMENT_TYPE_KEY];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim() as AssignmentType;
  return VALID_ASSIGNMENT_TYPES.includes(trimmed) ? trimmed : null;
}

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

/**
 * Restricted set of BPMN types the designer understands. Anything outside
 * this list is ignored by {@link extractPolicyGraph} so a diagram accidentally
 * containing a legacy UserTask, SubProcess, InclusiveGateway, etc. simply
 * won't appear in the backend payload.
 */
const ACTIVITY_NODE_TYPES = new Set([
  'bpmn:Task',
  'bpmn:StartEvent',
  'bpmn:EndEvent',
  'bpmn:ExclusiveGateway',
  'bpmn:ParallelGateway'
]);

function mapActivityType(bpmnType: string): ActivityType {
  if (bpmnType === 'bpmn:StartEvent') return 'START';
  if (bpmnType === 'bpmn:EndEvent') return 'END';
  if (bpmnType.endsWith('Gateway')) return 'DECISION';
  return 'TASK';
}

function mapFlowType(el: BpmnElement, sourceActivityType: ActivityType | undefined): FlowType {
  if (el.businessObject.conditionExpression) return 'CONDITIONAL';
  if (sourceActivityType === 'DECISION') return 'CONDITIONAL';
  return 'LINEAR';
}

/**
 * Traverses the bpmn-js ElementRegistry and produces the {lanes, activities, flows}
 * JSON expected by the backend's `POST /api/policies/full` endpoint.
 *
 * Form resolution order (highest precedence first):
 *   1. `formIdsByClientId` + `catalogResolver` — current-session assignment.
 *   2. `formsByClientId` — legacy in-memory inline definitions.
 *   3. extensionElements `workflow:formId` read from the BPMN XML.
 *   4. extensionElements `workflow:formDefinition` (legacy inline JSON).
 */
export function extractPolicyGraph(
  elements: BpmnElement[],
  formsByClientId: Record<string, FormDefinition | null> = {},
  formIdsByClientId: Record<string, string | null> = {},
  catalogResolver: (id: string) => FormDefinition | null = () => null,
  assignedUserIdsByClientId: Record<string, string[]> = {},
  assignmentTypesByClientId: Record<string, AssignmentType> = {}
): ParsedDiagram {
  const lanes: LaneDraft[] = [];
  const laneIdByElementId: Record<string, string> = {};
  const laneElements = elements.filter((e) => e.businessObject.$type === 'bpmn:Lane');

  laneElements.forEach((lane, idx) => {
    const clientId = lane.id;
    laneIdByElementId[lane.id] = clientId;
    lanes.push({
      clientId,
      name: lane.businessObject.name?.trim() || `Departamento ${idx + 1}`,
      position: idx
    });
  });

  const elementToLane: Record<string, string> = {};
  for (const lane of laneElements) {
    const refs = lane.businessObject.flowNodeRef ?? [];
    for (const ref of refs) {
      elementToLane[ref.id] = lane.id;
    }
  }

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
    const hasForm = !!formDefinition && (formDefinition.fields?.length ?? 0) > 0;
    const requiresForm = hasForm;
    const activityKind: ActivityKind = hasForm ? 'FORM_TASK' : 'APPROVAL_TASK';

    const liveAssignedUserIds = assignedUserIdsByClientId[clientId];
    const xmlAssignedUserIds = readAssignedUsersExtension(el);
    const assignedUserIds =
      liveAssignedUserIds !== undefined ? liveAssignedUserIds : xmlAssignedUserIds;
    const primaryAssignedUserId = assignedUserIds.length > 0 ? assignedUserIds[0] : null;

    const liveAssignmentType = assignmentTypesByClientId[clientId];
    const xmlAssignmentType = readAssignmentTypeExtension(el);
    const assignmentType: AssignmentType =
      liveAssignmentType ?? xmlAssignmentType ?? 'DEPARTMENT';

    activities.push({
      clientId,
      name: el.businessObject.name?.trim() || defaultActivityName(type),
      type,
      laneRef,
      requiresForm,
      formDefinition: formDefinition ?? null,
      activityKind,
      assignmentType,
      assignedUserId: primaryAssignedUserId,
      assignedUserIds
    });
  }

  const flows: FlowDraft[] = [];
  for (const el of elements) {
    if (el.businessObject.$type !== 'bpmn:SequenceFlow') continue;
    const sourceId = el.businessObject.sourceRef?.id;
    const targetId = el.businessObject.targetRef?.id;
    if (!sourceId || !targetId) continue;
    // Drop flows whose endpoints aren't in our supported node set — otherwise
    // the backend would receive dangling references.
    if (!activityTypeById[sourceId] || !activityTypeById[targetId]) continue;
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
      return 'Inicio';
    case 'END':
      return 'Fin';
    case 'DECISION':
      return 'Decisión';
    default:
      return 'Actividad';
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

/**
 * Truly blank BPMN document: an empty process with an empty plane. bpmn-js
 * renders a clean canvas so the admin can author the diagram from scratch
 * (drag a start event, add a pool, etc.) without a pre-seeded skeleton to
 * delete first. Used as the starting state and after a successful save.
 */
export const EMPTY_POLICY_DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_1" targetNamespace="http://workflow.local/">
  <bpmn:process id="Process_1" isExecutable="false" />
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1" />
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
