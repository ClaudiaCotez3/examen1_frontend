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
export const BRANCH_LABEL_KEY = 'workflow:branchLabel';

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

/**
 * Reads the branch label the admin attached to a flow coming out of a
 * DECISION gateway. Returns null if absent or not a string.
 */
export function readBranchLabelExtension(el: BpmnElement): string | null {
  const bo = el.businessObject as Record<string, unknown>;
  const ext = bo['extensionElements'] as Record<string, unknown> | undefined;
  const attrs = bo['$attrs'] as Record<string, unknown> | undefined;
  const raw = attrs?.[BRANCH_LABEL_KEY] ?? ext?.[BRANCH_LABEL_KEY];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
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
  /** Diagram-space bounds, populated for shapes (lanes, tasks, events). */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
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

/**
 * Geometric fallback: returns the lane id that visually contains the given
 * shape, or null if no lane wraps it. Used when bpmn-js failed to populate
 * `flowNodeRef` on the lane (a common case when the admin drops an activity
 * on top of a lane after it was already drawn — the modeler keeps them as
 * siblings instead of parenting the activity into the lane). Without this
 * fallback every such activity defaults to "lane[0]" or to the synthetic
 * "Default" lane and the operator Kanban shows the wrong área.
 */
function findContainingLaneId(activity: BpmnElement, lanes: BpmnElement[]): string | null {
  if (typeof activity.x !== 'number' || typeof activity.y !== 'number') return null;
  const cx = activity.x + (activity.width ?? 0) / 2;
  const cy = activity.y + (activity.height ?? 0) / 2;
  for (const lane of lanes) {
    if (
      typeof lane.x === 'number' &&
      typeof lane.y === 'number' &&
      typeof lane.width === 'number' &&
      typeof lane.height === 'number' &&
      cx >= lane.x &&
      cx <= lane.x + lane.width &&
      cy >= lane.y &&
      cy <= lane.y + lane.height
    ) {
      return lane.id;
    }
  }
  return null;
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
  assignmentTypesByClientId: Record<string, AssignmentType> = {},
  branchLabelsByFlowId: Record<string, string> = {}
): ParsedDiagram {
  const lanes: LaneDraft[] = [];
  const laneIdByElementId: Record<string, string> = {};
  // Accept both bpmn:Lane (the usual case) and bpmn:Participant (when the
  // admin draws pools instead of plain lanes). Either acts as a "department"
  // container for downstream tasks.
  const laneElements = elements.filter(
    (e) => e.businessObject.$type === 'bpmn:Lane'
        || e.businessObject.$type === 'bpmn:Participant'
  );

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
    const laneRef = hasLanes
      ? elementToLane[el.id]
        ?? findContainingLaneId(el, laneElements)
        ?? lanes[0].clientId
      : 'lane_default';
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
  // Track (source→target) edges already added so a message flow doesn't
  // duplicate an existing sequence flow between the same pair of nodes.
  const seenEdges = new Set<string>();

  // Helper: safely extract the id of a sourceRef/targetRef. bpmn-js usually
  // stores these as BO references with `.id`, but cross-pool MessageFlows
  // created via `modeling.connect(... { type: 'bpmn:MessageFlow' })`
  // occasionally land with the property pointing to the bpmn-js Shape
  // (which also has an `.id`) or even a string id directly. Cover all
  // three shapes so START/END/gateway flows aren't silently dropped.
  const extractRefId = (ref: unknown): string | null => {
    if (!ref) return null;
    if (typeof ref === 'string') return ref;
    if (typeof ref === 'object' && ref && 'id' in ref) {
      const id = (ref as { id: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  };

  // Pass 1 — read flows via the connection elements' businessObjects. This
  // is the canonical path and gives us per-flow metadata like
  // conditionExpression and branchLabel extensions.
  for (const el of elements) {
    const type = el.businessObject.$type;
    if (type !== 'bpmn:SequenceFlow' && type !== 'bpmn:MessageFlow') continue;
    let sourceId = extractRefId(el.businessObject.sourceRef);
    let targetId = extractRefId(el.businessObject.targetRef);
    // Fallback to the bpmn-js Connection's source/target shapes when the
    // businessObject's references are missing or unresolved.
    if (!sourceId) sourceId = extractRefId((el as unknown as { source?: { id?: string } }).source);
    if (!targetId) targetId = extractRefId((el as unknown as { target?: { id?: string } }).target);
    if (!sourceId || !targetId) continue;
    if (!activityTypeById[sourceId] || !activityTypeById[targetId]) continue;
    const edgeKey = `${sourceId}->${targetId}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    const liveBranchLabel = branchLabelsByFlowId[el.id];
    const branchLabel = liveBranchLabel !== undefined && liveBranchLabel !== ''
      ? liveBranchLabel
      : readBranchLabelExtension(el);
    flows.push({
      sourceRef: sourceId,
      targetRef: targetId,
      type: type === 'bpmn:MessageFlow'
        ? 'LINEAR'
        : mapFlowType(el, activityTypeById[sourceId]),
      condition: el.businessObject.conditionExpression?.body ?? null,
      branchLabel
    });
  }

  // Pass 2 — walk every activity shape's `incoming` AND `outgoing`
  // connections and add any edge that didn't survive Pass 1. bpmn-js
  // keeps these arrays in sync with the live diagram even when the BPMN
  // serialization on the businessObject hasn't caught up (e.g., a cross-
  // pool MessageFlow whose sourceRef/targetRef ended up undefined in
  // moddle). Without this, START / END / Gateway nodes occasionally end
  // up reported as "actividades desconectadas" right after the AI
  // assistant builds the diagram.
  type ConnLike = {
    id?: string;
    source?: { id?: string; businessObject?: { $type?: string } };
    target?: { id?: string; businessObject?: { $type?: string } };
    businessObject?: {
      $type?: string;
      conditionExpression?: { body?: string };
    };
  };
  for (const el of elements) {
    if (!ACTIVITY_NODE_TYPES.has(el.businessObject?.$type)) continue;
    const both: ConnLike[] = [
      ...(((el as unknown as { outgoing?: ConnLike[] }).outgoing) ?? []),
      ...(((el as unknown as { incoming?: ConnLike[] }).incoming) ?? [])
    ];
    for (const conn of both) {
      const source = conn?.source;
      const target = conn?.target;
      if (!source?.id || !target?.id) continue;
      const sType = source.businessObject?.$type ?? '';
      const tType = target.businessObject?.$type ?? '';
      if (!ACTIVITY_NODE_TYPES.has(sType)) continue;
      if (!ACTIVITY_NODE_TYPES.has(tType)) continue;
      const sourceId = source.id;
      const targetId = target.id;
      const edgeKey = `${sourceId}->${targetId}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      const connId = conn.id ?? '';
      const connType = conn.businessObject?.$type ?? '';
      const liveBranchLabel = connId ? branchLabelsByFlowId[connId] : undefined;
      const branchLabel = liveBranchLabel !== undefined && liveBranchLabel !== ''
        ? liveBranchLabel
        : readBranchLabelExtension(conn as unknown as BpmnElement);
      flows.push({
        sourceRef: sourceId,
        targetRef: targetId,
        type: connType === 'bpmn:MessageFlow'
          ? 'LINEAR'
          : mapFlowType(conn as unknown as BpmnElement, activityTypeById[sourceId]),
        condition: conn.businessObject?.conditionExpression?.body ?? null,
        branchLabel
      });
    }
  }

  // Pass 3 — last-resort registry scan. We treat ANYTHING in the element
  // list that has both a `.source` and a `.target` shape (regardless of
  // its `$type`) as a candidate connection. This rescues edges that
  // bpmn-js stored with an unexpected $type, or whose moddle BO never
  // had its sourceRef/targetRef wired AND that don't appear in any
  // activity's incoming/outgoing for some reason. We only accept the
  // edge when both endpoints are already in the activity index, so we
  // never invent flows out of stray UI shapes (labels, frames, etc.).
  for (const el of elements) {
    const anyEl = el as unknown as {
      source?: { id?: string };
      target?: { id?: string };
      businessObject?: { $type?: string };
      id?: string;
    };
    const sourceId = anyEl.source?.id;
    const targetId = anyEl.target?.id;
    if (!sourceId || !targetId) continue;
    if (!activityTypeById[sourceId] || !activityTypeById[targetId]) continue;
    const edgeKey = `${sourceId}->${targetId}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    const connType = anyEl.businessObject?.$type ?? '';
    flows.push({
      sourceRef: sourceId,
      targetRef: targetId,
      type: connType === 'bpmn:MessageFlow'
        ? 'LINEAR'
        : mapFlowType(el, activityTypeById[sourceId]),
      condition: null,
      branchLabel: branchLabelsByFlowId[anyEl.id ?? ''] ?? null
    });
  }

  // Pass 4 — synthesize flows for any START / END that's still orphan
  // after passes 1-3. We pick the geometrically closest activity in the
  // same lane (or anywhere on the canvas as fallback) and emit a
  // synthetic LINEAR flow. Visually nothing shows because we're only
  // touching the parsed payload, not the bpmn-js diagram — but the
  // backend gets a connected graph and saves successfully.
  const reachable = new Set<string>();
  for (const f of flows) {
    reachable.add(f.sourceRef);
    reachable.add(f.targetRef);
  }
  const elementsById = new Map<string, BpmnElement>(
    elements.map((e) => [e.id, e])
  );
  const cx = (e: BpmnElement | undefined) =>
    e && typeof e.x === 'number' && typeof e.width === 'number'
      ? e.x + e.width / 2
      : 0;
  const TASK_LIKE = /^bpmn:(Task|UserTask|ServiceTask|ManualTask|ScriptTask|ExclusiveGateway|InclusiveGateway|ParallelGateway)$/;

  const findPartner = (orphan: ActivityDraft, direction: 'right' | 'left'): ActivityDraft | null => {
    const orphanShape = elementsById.get(orphan.clientId);
    const ox = cx(orphanShape);
    // Prefer activities in the same lane.
    const sameLane = activities.filter((a) =>
      a.clientId !== orphan.clientId && a.laneRef === orphan.laneRef
    );
    const pool = sameLane.length > 0 ? sameLane : activities.filter((a) => a.clientId !== orphan.clientId);
    const filtered = pool.filter((a) => TASK_LIKE.test(elementsById.get(a.clientId)?.businessObject?.$type ?? ''));
    if (filtered.length === 0) return null;
    filtered.sort((a, b) => {
      const ax = cx(elementsById.get(a.clientId));
      const bx = cx(elementsById.get(b.clientId));
      const ad = direction === 'right'
        ? (ax >= ox ? ax - ox : Number.MAX_SAFE_INTEGER)
        : (ax <= ox ? ox - ax : Number.MAX_SAFE_INTEGER);
      const bd = direction === 'right'
        ? (bx >= ox ? bx - ox : Number.MAX_SAFE_INTEGER)
        : (bx <= ox ? ox - bx : Number.MAX_SAFE_INTEGER);
      return ad - bd;
    });
    return filtered[0] && Number.isFinite(cx(elementsById.get(filtered[0].clientId)))
      ? filtered[0]
      : filtered[0] ?? null;
  };

  for (const a of activities) {
    if (reachable.has(a.clientId)) continue;
    if (a.type !== 'START' && a.type !== 'END') continue;
    const partner = a.type === 'START'
      ? (findPartner(a, 'right') ?? findPartner(a, 'left'))
      : (findPartner(a, 'left') ?? findPartner(a, 'right'));
    if (!partner) continue;
    const sourceRef = a.type === 'START' ? a.clientId : partner.clientId;
    const targetRef = a.type === 'START' ? partner.clientId : a.clientId;
    const edgeKey = `${sourceRef}->${targetRef}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    flows.push({
      sourceRef,
      targetRef,
      type: 'LINEAR',
      condition: null,
      branchLabel: null
    });
    reachable.add(sourceRef);
    reachable.add(targetRef);
    if (typeof console !== 'undefined') {
      console.info(
        `[bpmn-parser] synthesized flow ${a.type === 'START' ? 'from' : 'to'} ${a.name}`,
        { sourceRef, targetRef }
      );
    }
  }

  // Telemetry — when something STILL ends up missing from the flow list,
  // log enough state to diagnose it without a full debugger session.
  try {
    const orphans = activities
      .filter((a) => !reachable.has(a.clientId))
      .map((a) => `${a.type}:${a.name || a.clientId}`);
    if (orphans.length > 0 && typeof console !== 'undefined') {
      console.warn('[bpmn-parser] activities still orphan after Pass 4:', orphans);
    }
  } catch { /* ignore */ }

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
    // True orphan = clientId never appears as source/target on ANY flow.
    // We're tolerant of stray label / annotation shapes here: only the
    // five supported activity types matter, and the connectivity check
    // is purely against the flow set we'll send to the backend.
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
/**
 * Namespace URI we use for the {@code workflow:*} extension attributes
 * (formId, assignedUserId, assignmentType, requirements). bpmn-js will
 * only serialize attributes that live under a namespace declared on the
 * root <bpmn:definitions> element — without this declaration, anything
 * we put into a businessObject's `$attrs` bag is silently dropped on
 * export, breaking the collaboration round-trip.
 */
export const WORKFLOW_NAMESPACE_URI = 'http://workflow.local/bpmn';

/**
 * Ensures the loaded diagram XML declares the {@code xmlns:workflow}
 * namespace so any subsequent export round-trips our extension attrs.
 * Tolerant: if the declaration is already there, returns the XML
 * unchanged.
 */
export function ensureWorkflowNamespace(xml: string): string {
  if (!xml || xml.includes('xmlns:workflow=')) return xml;
  return xml.replace(
    /<bpmn:definitions(\s|>)/,
    `<bpmn:definitions xmlns:workflow="${WORKFLOW_NAMESPACE_URI}"$1`
  );
}

export const EMPTY_POLICY_DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  xmlns:workflow="${WORKFLOW_NAMESPACE_URI}"
                  id="Definitions_1" targetNamespace="http://workflow.local/">
  <bpmn:process id="Process_1" isExecutable="false" />
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1" />
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
