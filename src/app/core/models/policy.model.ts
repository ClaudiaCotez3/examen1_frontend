import { FormDefinition } from './form.model';

export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type ActivityType = 'START' | 'TASK' | 'DECISION' | 'END';
export type FlowType = 'LINEAR' | 'CONDITIONAL' | 'PARALLEL' | 'LOOP';

/**
 * How the workflow engine should assign this activity at runtime. The three
 * modes map directly to the three options surfaced in the sidebar so the
 * backend can spawn the right kind of work item.
 *
 *   - `SPECIFIC_USER`    → exactly one operator, hard-assigned.
 *   - `CANDIDATE_USERS`  → a pool of operators; any member can pick it up.
 *   - `DEPARTMENT`       → no named operators; anyone in the lane/department
 *                          is eligible.
 */
export type AssignmentType = 'SPECIFIC_USER' | 'CANDIDATE_USERS' | 'DEPARTMENT';

/**
 * Whether this activity gathers data (FORM_TASK) or simply captures a human
 * approve/reject decision (APPROVAL_TASK). Inferred from the presence of a
 * Form assignment — callers should never set this manually.
 */
export type ActivityKind = 'FORM_TASK' | 'APPROVAL_TASK';

export interface LaneDraft {
  clientId: string;
  name: string;
  position: number;
}

export interface ActivityDraft {
  clientId: string;
  name: string;
  type: ActivityType;
  laneRef: string;
  /**
   * True when a form is attached. Inferred from `formDefinition`; never set
   * manually by the UI so the two fields can never disagree.
   */
  requiresForm?: boolean;
  formDefinition?: FormDefinition | null;
  /** FORM_TASK when a form is attached, APPROVAL_TASK otherwise. */
  activityKind?: ActivityKind;
  /** How assignment is resolved at runtime — see {@link AssignmentType}. */
  assignmentType?: AssignmentType;
  /**
   * Single default operator. Retained for back-compat with backends that still
   * consume one assignee per activity. When multiple operators are assigned,
   * this mirrors {@link assignedUserIds}`[0]`.
   */
  assignedUserId?: string | null;
  /**
   * Full set of operators assigned to this activity at design time. Multiple
   * assignees reflect real-world workflows where any member of a team may
   * pick up the task.
   */
  assignedUserIds?: string[];
}

export interface FlowDraft {
  sourceRef: string;
  targetRef: string;
  type: FlowType;
  condition?: string | null;
  /**
   * Branch label set by the admin on flows leaving a DECISION gateway
   * (typically "APROBADO" / "RECHAZADO"). Carried over the wire as
   * {@code workflow:branchLabel} so the workflow engine can match the
   * operator's decision to the right branch at runtime.
   */
  branchLabel?: string | null;
}

export interface PolicyDraft {
  name: string;
  description?: string;
  status?: PolicyStatus;
  /**
   * Raw BPMN 2.0 XML as exported by the visual designer. Persisted so that
   * reopening a policy in the Políticas catalog rehydrates the canvas with
   * the exact geometry the admin authored — shapes, waypoints, lanes and
   * custom extension attributes survive the round-trip.
   */
  bpmnXml?: string;
  /**
   * Dynamic form schema collected from the customer at process initiation.
   * Replaces the old free-text "requisitos previos" list: instead of a text
   * bullet, the consultor fills a structured form and the data travels with
   * the case file from the moment it is created.
   */
  startFormDefinition?: FormDefinition | null;
  /**
   * form-js editor schema kept alongside {@link startFormDefinition} so the
   * admin re-opens the start form in the builder with the same layout,
   * labels and component order they authored (the structured definition
   * alone would lose advanced field configuration).
   */
  startFormSchema?: unknown | null;
  lanes: LaneDraft[];
  activities: ActivityDraft[];
  flows: FlowDraft[];
}

export interface LaneResponse {
  id: string;
  policyId: string;
  name: string;
  position: number;
}

export interface ActivityResponse {
  id: string;
  policyId: string;
  laneId: string;
  name: string;
  type: ActivityType;
  requiresForm: boolean;
  formDefinition?: FormDefinition | null;
}

export interface FlowResponse {
  id: string;
  sourceActivityId: string;
  targetActivityId: string;
  type: FlowType;
  condition: string | null;
}

export interface PolicyResponse {
  id: string;
  name: string;
  description: string | null;
  status: PolicyStatus;
  /** Monotonically increasing version number of the active definition. */
  version?: number;
  /** Raw BPMN 2.0 XML, when one was persisted by the designer. */
  bpmnXml?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Dynamic start form the consultor fills to initiate a case. */
  startFormDefinition?: FormDefinition | null;
  /** form-js editor schema for the start form. */
  startFormSchema?: unknown | null;
  lanes?: LaneResponse[];
  activities?: ActivityResponse[];
  flows?: FlowResponse[];
}
