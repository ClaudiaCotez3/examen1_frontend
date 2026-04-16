export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type ActivityType = 'START' | 'TASK' | 'DECISION' | 'END';
export type FlowType = 'LINEAR' | 'CONDITIONAL' | 'PARALLEL' | 'LOOP';

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
  requiresForm?: boolean;
}

export interface FlowDraft {
  sourceRef: string;
  targetRef: string;
  type: FlowType;
  condition?: string | null;
}

export interface PolicyDraft {
  name: string;
  description?: string;
  status?: PolicyStatus;
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
  createdAt: string;
  updatedAt: string;
  lanes?: LaneResponse[];
  activities?: ActivityResponse[];
  flows?: FlowResponse[];
}
