import { FormDefinition, FormField, FormFieldType } from '../../../core/models/form.model';

/**
 * Loose typing for the bpmn.io form-js schema. We only inspect the small
 * subset that maps to the backend's {@link FormDefinition}, so a structural
 * shape is enough — and avoids coupling our service layer to the editor pkg.
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
  path?: string;
  label?: string;
  values?: Array<{ label?: string; value: string }>;
  validate?: { required?: boolean; [k: string]: unknown };
  components?: FormJsComponent[];
  [key: string]: unknown;
}

/**
 * form-js component types we accept and the {@link FormFieldType} they map
 * to. Anything outside this map is dropped at translation time — so even if
 * the palette filter is bypassed (manual schema edit, stale draft), the
 * backend still only ever sees approved field types.
 *
 * Presentation-only types (image, html, table, iframe, separator, spacer,
 * button, textview, expression, json) are intentionally absent.
 */
const TYPE_MAP: Record<string, FormFieldType> = {
  // Inputs
  textfield: 'text',
  textarea: 'textarea',
  number: 'number',
  datetime: 'datetime',
  date: 'date',
  time: 'datetime',
  // Selection
  radio: 'radio',
  select: 'select',
  checkbox: 'checkbox',
  // File input
  filepicker: 'file',
  // Optional (controlled)
  taglist: 'tags',
  dynamiclist: 'dynamic-list',
  group: 'group'
};

/** form-js component types that act as containers with nested components. */
const CONTAINER_TYPES = new Set(['group', 'dynamiclist']);

/**
 * Translates a form-js schema into the simple {@link FormDefinition} the
 * backend persists. Unsupported component types are dropped silently.
 *
 * Nested components inside `group` / `dynamiclist` are preserved as
 * {@link FormField#fields}, so the backend JSON mirrors the hierarchy in
 * the designer.
 */
export function formJsSchemaToDefinition(schema: FormJsSchema | null): FormDefinition {
  if (!schema?.components?.length) {
    return { fields: [] };
  }
  return { fields: translateComponents(schema.components) };
}

function translateComponents(components: FormJsComponent[] | undefined): FormField[] {
  if (!components) return [];
  const fields: FormField[] = [];
  for (const c of components) {
    const field = translateComponent(c);
    if (field) fields.push(field);
  }
  return fields;
}

function translateComponent(c: FormJsComponent): FormField | null {
  const mapped = TYPE_MAP[c.type];
  if (!mapped) return null;

  // Groups don't need a key — they're just a logical wrapper — but every
  // other field does (no key == no data == not a form field).
  const key = c.key || c.path;
  if (!key && mapped !== 'group') return null;

  const field: FormField = {
    name: key || fallbackName(c, mapped),
    label: c.label || key || '',
    type: mapped,
    required: !!c.validate?.required
  };

  if (mapped === 'radio' || mapped === 'select') {
    field.options = (c.values ?? [])
      .map((v) => v.value)
      .filter((v) => typeof v === 'string' && v.length > 0);
  }

  if (CONTAINER_TYPES.has(c.type) && c.components?.length) {
    field.fields = translateComponents(c.components);
  }

  return field;
}

/**
 * Deterministic fallback name for groups that the admin never named. Uses
 * the component id when available, otherwise a stable prefix + index.
 */
function fallbackName(c: FormJsComponent, type: FormFieldType): string {
  if (c.id) return c.id;
  return `${type}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Builds a *fresh* form-js schema from an existing {@link FormDefinition}.
 * Used when loading a legacy catalog entry that pre-dates the form-js
 * editor — we still have the simple `fields[]` representation but no
 * form-js schema to import, so we synthesize one.
 */
export function definitionToFormJsSchema(def: FormDefinition | null): FormJsSchema {
  return {
    type: 'default',
    components: toFormJsComponents(def?.fields ?? []),
    schemaVersion: 19
  };
}

function toFormJsComponents(fields: FormField[]): FormJsComponent[] {
  return fields.map((f) => {
    const base: FormJsComponent = {
      type: toFormJsType(f.type),
      key: f.name,
      label: f.label || f.name,
      validate: { required: !!f.required }
    };

    if ((f.type === 'radio' || f.type === 'select') && f.options?.length) {
      base.values = f.options.map((opt) => ({ label: opt, value: opt }));
    }

    if ((f.type === 'group' || f.type === 'dynamic-list') && f.fields?.length) {
      base.components = toFormJsComponents(f.fields);
    }
    return base;
  });
}

function toFormJsType(type: FormFieldType): string {
  switch (type) {
    case 'text': return 'textfield';
    case 'textarea': return 'textarea';
    case 'number': return 'number';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'radio': return 'radio';
    case 'select': return 'select';
    case 'checkbox': return 'checkbox';
    case 'file': return 'filepicker';
    case 'tags': return 'taglist';
    case 'dynamic-list': return 'dynamiclist';
    case 'group': return 'group';
  }
}
