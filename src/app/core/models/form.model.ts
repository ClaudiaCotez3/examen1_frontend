/**
 * Dynamic-form types shared by the designer (form builder), the operator
 * runtime (dynamic renderer) and the services that talk to the backend.
 *
 * Mirrors the backend DTOs (FormDefinitionDTO / FormFieldDTO / FormResponseDTO).
 */

export type FormFieldType = 'text' | 'number' | 'date' | 'select';

export interface FormField {
  name: string;
  label?: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[];
}

export interface FormDefinition {
  fields: FormField[];
}

export interface ActivityForm {
  activityId: string;
  activityName: string;
  requiresForm: boolean;
  formDefinition: FormDefinition | null;
}

export interface FormSubmissionRequest {
  formData: Record<string, unknown>;
}

export interface FormResponse {
  id: string;
  activityInstanceId: string;
  formData: Record<string, unknown>;
  submittedBy: string | null;
  submittedAt: string | null;
}
