/**
 * Dynamic-form types shared by the designer (form builder), the operator
 * runtime (dynamic renderer) and the services that talk to the backend.
 *
 * The set is intentionally narrow and controlled: every type below must
 * produce data. Decorative components (image, html, table, iframe, spacer,
 * separator, button…) are deliberately NOT representable in the JSON, which
 * is the contract that keeps forms business-oriented.
 */

export type FormFieldType =
  // ── Inputs ───────────────────────────────────────────
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'datetime'
  // ── Selection ────────────────────────────────────────
  | 'radio'      // single choice (one of `options`)
  | 'select'     // dropdown (one of `options`)
  | 'checkbox'   // boolean
  // ── File input ───────────────────────────────────────
  | 'file'
  // ── Optional / controlled ────────────────────────────
  | 'tags'         // multi-value free-entry (array of strings)
  | 'dynamic-list' // repeating rows with nested `fields`
  | 'group';       // logical grouping, exposes `fields` verbatim

export interface FormField {
  /** Backend-facing key (alphanumeric, snake/camel — no spaces). */
  name: string;
  /** Human label; when missing the runtime falls back to `name`. */
  label?: string;
  type: FormFieldType;
  required?: boolean;
  /** Allowed values for `radio` / `select`. */
  options?: string[];
  /**
   * Nested fields for `group` and `dynamic-list`. Dynamic lists emit an
   * array of objects — one per row — where each row is the nested schema.
   * Groups emit a single object keyed by the group's `name`.
   */
  fields?: FormField[];
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
