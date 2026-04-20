/**
 * Spanish localization for the @bpmn-io/form-js editor (v1.21).
 *
 * Why a MutationObserver instead of a translate module?
 * -----------------------------------------------------
 * form-js v1 doesn't expose a DI-injected `translate` service the way bpmn-js
 * does — its UI is rendered by Preact components that hardcode English
 * strings as defaults. The clean alternative would be to fork the
 * PropertiesProvider, but that means reimplementing every entry definition
 * just to change a label, and re-syncing on every form-js bump.
 *
 * The pragmatic alternative is a thin observer that watches the editor host
 * and rewrites known English strings to Spanish. It's surgical (only known
 * keys), idempotent (won't double-translate), and resilient to form-js's
 * frequent re-renders. If form-js ever ships proper i18n we can delete this
 * file outright — no other code depends on it.
 *
 * Scope: covers the property-panel labels we keep visible plus the palette
 * tile names. Strings we don't translate stay in English (a deliberate
 * "incomplete > misleading" stance).
 */

/**
 * English → Spanish dictionary. Keys are matched against the *trimmed*
 * `textContent` of leaf elements, so values are simple strings with no
 * surrounding whitespace.
 */
const TRANSLATIONS: Record<string, string> = {
  // ── Property panel: group headers ────────────────────────────────
  'General': 'General',
  'Validation': 'Validación',
  // Datetime-only sibling group; translated for completeness.
  'Constraints': 'Restricciones',
  'Options source': 'Origen de opciones',
  'Static options': 'Opciones estáticas',
  'Options': 'Opciones',
  'Table headers': 'Encabezados de tabla',

  // ── Property panel: entry labels we keep visible ─────────────────
  'Field label': 'Nombre del campo',
  'Field description': 'Descripción',
  'Default value': 'Valor por defecto',
  'Required': 'Obligatorio',
  'Minimum length': 'Longitud mínima',
  'Maximum length': 'Longitud máxima',
  // Some form-js builds use these alternate strings:
  'Label': 'Nombre del campo',
  'Description': 'Descripción',
  'Min length': 'Longitud mínima',
  'Max length': 'Longitud máxima',
  'Value': 'Valor',
  'Identifier': 'Identificador',

  // ── Options entries ───────────────────────────────────────────────
  'Add value': 'Agregar opción',
  'Add static option': 'Agregar opción',
  'Predefined values': 'Valores predefinidos',
  'List of values': 'Lista de valores',
  'Input variable': 'Variable de entrada',

  // ── Properties panel placeholder (no field selected) ─────────────
  'Select a form field': 'Selecciona un campo del formulario',
  'No properties available': 'Sin propiedades disponibles',
  'Select a form element to edit its properties.': 'Selecciona un elemento del formulario para editar sus propiedades.',

  // ── Palette: section headers ─────────────────────────────────────
  'Basic input': 'Entradas básicas',
  'Selection': 'Selección',
  'Presentation': 'Presentación',
  'Container': 'Contenedor',
  'Action': 'Acciones',

  // ── Palette: component tile names ────────────────────────────────
  'Text field': 'Texto',
  'Text area': 'Texto largo',
  'Text view': 'Texto (solo lectura)',
  'Number': 'Número',
  'Datetime': 'Fecha / hora',
  'Date time': 'Fecha / hora',
  'Date': 'Fecha',
  'Time': 'Hora',
  'Checkbox': 'Casilla',
  'Checklist': 'Lista de casillas',
  'Checkbox group': 'Lista de casillas',
  'Radio': 'Opción única',
  'Radio group': 'Opción única',
  'Select': 'Lista desplegable',
  'Tag list': 'Etiquetas',
  'Image view': 'Imagen',
  'HTML view': 'HTML',
  'Spacer': 'Espacio',
  'Separator': 'Separador',
  'Group': 'Grupo',
  'Dynamic list': 'Lista dinámica',
  'Table': 'Tabla',
  'Document preview': 'Vista de documento',
  'IFrame': 'IFrame',
  'Button': 'Botón',
  'JSON form field': 'Campo JSON',
  'Expression field': 'Campo con expresión',

  // ── Editor toolbar / palette header ──────────────────────────────
  'Components': 'Componentes',
  'Form components': 'Componentes del formulario',
  'Properties': 'Propiedades',
  'Search': 'Buscar',
  'Search components': 'Buscar componentes',
  'No components found': 'Sin componentes',

  // ── Generic UI strings we leak ───────────────────────────────────
  'Add': 'Agregar',
  'Remove': 'Quitar',
  'Edit': 'Editar',
  'Delete': 'Eliminar',
  'Cancel': 'Cancelar',
  'Save': 'Guardar',
  'Submit': 'Enviar',
  'Reset': 'Reiniciar',
  'Yes': 'Sí',
  'No': 'No',
  'Loading': 'Cargando',
  'Loading...': 'Cargando…',

  // ── Common validation messages (rendered by the viewer in preview) ─
  'Field is required.': 'Este campo es obligatorio.',
  'Field must have minimum length of {minLength} characters.': 'El campo debe tener al menos {minLength} caracteres.',
  'Field must have maximum length of {maxLength} characters.': 'El campo debe tener máximo {maxLength} caracteres.'
};

/**
 * Marker class set on translated nodes so subsequent observer ticks skip
 * them. Cheaper than re-comparing the dictionary on every mutation, and
 * robust against form-js re-renders (when Preact re-mounts a component the
 * marker is gone and we translate again).
 */
const TRANSLATED_MARKER = 'fjs-i18n-es';

/**
 * Walk every text node under `root` and translate it in-place. Text nodes
 * carry the visible labels in form-js's Preact tree (the wrapping spans /
 * divs are styling chrome we don't want to touch).
 */
function translateUnder(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node.nodeValue;
    if (text) {
      const trimmed = text.trim();
      const replacement = TRANSLATIONS[trimmed];
      if (replacement && replacement !== trimmed) {
        // Preserve any leading/trailing whitespace the original had.
        node.nodeValue = text.replace(trimmed, replacement);
        // Mark the *parent* element so we don't keep re-walking the same
        // unchanged subtree on every observer tick.
        const parent = (node as Text).parentElement;
        if (parent) parent.classList.add(TRANSLATED_MARKER);
      }
    }
    node = walker.nextNode();
  }
}

/**
 * Set up Spanish localization for a form-js editor mounted under `host`.
 * Returns a dispose function that disconnects the observer (call from
 * the component's `ngOnDestroy`).
 */
export function setupSpanishLocalization(host: HTMLElement): () => void {
  // Initial pass — covers everything already rendered by the time we attach.
  translateUnder(host);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // characterData mutations: a text node was edited in place (rare but
      // happens on input rebinds). Re-translate just that node.
      if (m.type === 'characterData' && m.target.nodeType === Node.TEXT_NODE) {
        const text = m.target.nodeValue?.trim();
        if (text && TRANSLATIONS[text]) {
          m.target.nodeValue = (m.target.nodeValue ?? '').replace(text, TRANSLATIONS[text]);
        }
        continue;
      }
      // childList mutations: subtree changed — translate the new branches.
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        translateUnder(node as HTMLElement);
      });
    }
  });

  observer.observe(host, {
    childList: true,
    subtree: true,
    characterData: true
  });

  return () => observer.disconnect();
}
