import { FormDefinition, FormField, FormFieldType } from '../../../core/models/form.model';

/**
 * Loose typing for the bpmn.io form-js schema. The library exports a richer
 * type, but we only ever inspect the small subset that maps to the backend's
 * {@link FormDefinition}, so a structural shape is enough — and avoids
 * coupling our service layer to the editor package.
 */
export interface FormJsSchema {
  type?: string;
  components?: FormJsComponent[];
  schemaVersion?: number;
  [key: string]: unknown;
}

export interface FormJsComponent {
  id?: string;
  type: string;
  key?: string;
  label?: string;
  values?: Array<{ label?: string; value: string }>;
  validate?: { required?: boolean; [k: string]: unknown };
  components?: FormJsComponent[];
  [key: string]: unknown;
}

/**
 * Maps a form-js component `type` to the backend's {@link FormFieldType}.
 *
 * The backend only understands four primitive kinds (text/number/date/select);
 * anything else is filtered out at translation time so save payloads stay
 * compatible. Keep the map small and explicit — adding a type here is the
 * contract for round-tripping a new field.
 */
const TYPE_MAP: Record<string, FormFieldType> = {
  textfield: 'text',
  textarea: 'text',
  number: 'number',
  datetime: 'date',
  date: 'date',
  select: 'select',
  radio: 'select',
  checklist: 'select'
};

/**
 * Walks every component in a form-js schema (depth-first) so we also pick up
 * fields nested inside groups, dynamiclists, etc. Layout-only nodes are
 * skipped naturally because they don't carry a `key`.
 */
function flattenComponents(components: FormJsComponent[] | undefined): FormJsComponent[] {
  if (!components) return [];
  const out: FormJsComponent[] = [];
  for (const c of components) {
    out.push(c);
    if (c.components?.length) {
      out.push(...flattenComponents(c.components));
    }
  }
  return out;
}

/**
 * Translates a form-js schema into the simple {@link FormDefinition} the
 * backend persists on each activity. Unsupported component types are
 * dropped silently — they remain in the form-js schema (still re-editable in
 * the builder) but won't be sent to the runtime.
 */
export function formJsSchemaToDefinition(schema: FormJsSchema | null): FormDefinition {
  if (!schema?.components?.length) {
    return { fields: [] };
  }

  const fields: FormField[] = [];
  for (const c of flattenComponents(schema.components)) {
    const mappedType = TYPE_MAP[c.type];
    if (!mappedType || !c.key) continue;

    const field: FormField = {
      name: c.key,
      label: c.label || c.key,
      type: mappedType,
      required: !!c.validate?.required
    };
    if (mappedType === 'select') {
      field.options = (c.values ?? [])
        .map((v) => v.value)
        .filter((v) => typeof v === 'string' && v.length > 0);
    }
    fields.push(field);
  }

  return { fields };
}

/**
 * Builds a *fresh* form-js schema from an existing {@link FormDefinition}.
 *
 * Used when loading a legacy catalog entry that pre-dates the form-js editor:
 * we still have the simple `fields[]` representation but no form-js schema to
 * import, so we synthesize one. After the user saves, both shapes coexist.
 */
export function definitionToFormJsSchema(def: FormDefinition | null): FormJsSchema {
  const components: FormJsComponent[] = (def?.fields ?? []).map((f) => {
    const base: FormJsComponent = {
      type: backwardType(f.type),
      key: f.name,
      label: f.label || f.name,
      validate: { required: !!f.required }
    } as FormJsComponent;

    if (f.type === 'select') {
      (base as FormJsComponent).values = (f.options ?? []).map((opt) => ({
        label: opt,
        value: opt
      }));
    }
    return base;
  });

  return {
    type: 'default',
    components,
    schemaVersion: 19
  };
}

function backwardType(type: FormFieldType): string {
  switch (type) {
    case 'text': return 'textfield';
    case 'number': return 'number';
    case 'date': return 'datetime';
    case 'select': return 'select';
  }
}
