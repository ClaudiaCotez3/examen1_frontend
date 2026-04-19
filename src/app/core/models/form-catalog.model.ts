import { FormDefinition } from './form.model';
import { FormJsSchema } from '../../admin/pages/form-builder/form-js-translator';

/**
 * Reusable form definition stored in the catalog.
 *
 * The entry carries two parallel representations of the same form:
 *
 *   - {@link formJsSchema} is the rich bpmn.io form-js schema. It is the
 *     source of truth for *editing*: the FormBuilder loads it back into the
 *     form-js editor to round-trip drag-and-drop changes without losing
 *     layout / advanced field metadata that the simpler shape can't express.
 *
 *   - {@link formDefinition} is the simple `{fields:[]}` projection that the
 *     backend persists on each activity. Derived from `formJsSchema` at save
 *     time, it is what the runtime renderer (DynamicFormComponent in the
 *     operator's Task Monitor) consumes.
 *
 * Storing both means the editor can always re-import the original schema,
 * while the runtime stays decoupled from form-js (no extra runtime deps in
 * the operator bundle, no schema migration when bpmn.io evolves).
 */
export interface FormCatalogEntry {
  id: string;
  name: string;
  description?: string;
  /** Backend-facing projection — embedded into activities at save time. */
  formDefinition: FormDefinition;
  /** Source of truth for re-editing in the form-js editor. Optional only for
   *  legacy entries created before the editor was integrated. */
  formJsSchema?: FormJsSchema;
  createdAt: string;
  updatedAt: string;
}

/** Payload accepted by the catalog service when creating a form. */
export interface FormCatalogCreate {
  name: string;
  description?: string;
  formDefinition: FormDefinition;
  formJsSchema?: FormJsSchema;
}

/** Payload accepted by the catalog service when updating a form. */
export interface FormCatalogUpdate {
  name?: string;
  description?: string;
  formDefinition?: FormDefinition;
  formJsSchema?: FormJsSchema;
}
