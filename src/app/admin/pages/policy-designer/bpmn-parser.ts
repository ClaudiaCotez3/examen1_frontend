import {
  ActivityDraft,
  ActivityType,
  FlowDraft,
  FlowType,
  LaneDraft
} from '../../../core/models/policy.model';

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
 */
export function extractPolicyGraph(elements: BpmnElement[]): ParsedDiagram {
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
    activities.push({
      clientId,
      name: el.businessObject.name?.trim() || defaultActivityName(type),
      type,
      laneRef,
      requiresForm: false
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
    errors.push('Diagram must contain at least one Start event.');
  }
  if (ends.length < 1) {
    errors.push('Diagram must contain at least one End event.');
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
        `Disconnected activities: ${orphans.map((o) => o.name || o.clientId).join(', ')}`
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
