/**
 * Palette filter for the @bpmn-io/form-js editor.
 *
 * Goal
 * ----
 * Keep the builder business-oriented by exposing ONLY components that
 * capture or structure data. Decorative/presentation tiles (image, html,
 * table, iframe, separator, spacer, button, text view, JSON, expression…)
 * are hidden from the palette.
 *
 * Why CSS instead of DOM removal?
 * -------------------------------
 * The first version of this filter called `.remove()` on disallowed tiles,
 * but form-js renders the palette with Preact: its Virtual DOM still holds
 * every entry, so the next reconciliation (triggered by — ironically — our
 * own `remove()` mutation, or by a search-input keystroke) re-inserts the
 * tile. Using a scoped stylesheet makes the hide rule immune to Preact's
 * re-renders: the VDOM puts the node back, the CSS keeps it invisible,
 * and the user never sees the flash.
 *
 * Scope
 * -----
 * The filter only affects the supplied editor host. The rules target
 * `[data-field-type]` values (form-js's stable tile identifier) and the
 * `[data-group-id]` values on palette sections. Both are documented in
 * form-js's source and have been stable across the v1.x series.
 *
 * Defense in depth
 * ----------------
 * Even if a tile escapes this filter (CSS stripped, dev-tools toggle), the
 * translator independently drops any component with an unapproved `type`
 * at save time — so the backend payload never carries a decorative field.
 */

/**
 * Allow-list: tiles whose `[data-field-type]` is NOT in this set get
 * hidden by the injected rule list.
 */
const ALLOWED_FIELD_TYPES: readonly string[] = [
  // Inputs
  'textfield',
  'textarea',
  'number',
  'datetime',
  // Selection
  'radio',
  'select',
  'checkbox',
  // File
  'filepicker',
  // Optional (controlled)
  'taglist',
  'dynamiclist',
  'group'
] as const;

/**
 * Palette sections (matched on {@code [data-group-id]}) that we hide
 * wholesale. After removing every tile they contained, the section header
 * would otherwise sit empty with no children.
 */
const HIDDEN_GROUP_IDS: readonly string[] = [
  'presentation', // Image / HTML / Table / Spacer / Separator / Text view / Document preview / iFrame
  'action'        // Button
] as const;

/**
 * Wraps a value for safe inclusion inside a CSS attribute selector. Only
 * ASCII alphanumerics + `-` / `_` appear in form-js identifiers, so a
 * strict allow-list regex is sufficient — and safer than escaping.
 */
function escapeCssIdentifier(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : '';
}

/**
 * Builds the CSS source that hides everything outside the allow-list.
 * Produces two families of rules:
 *
 *   1. Per-section hide: `.form-builder-host [data-group-id="presentation"]`
 *      — collapses the whole "Presentación" / "Acciones" blocks.
 *   2. Per-tile hide: `.form-builder-host [data-field-type]:not([data-field-type="..."])…`
 *      — any tile whose type isn't explicitly allowed.
 *
 * The {@code hostSelector} scopes the rules so the page-level CSSOM can
 * carry multiple editor instances without cross-contamination.
 */
function buildCss(hostSelector: string): string {
  const allowedAttr = ALLOWED_FIELD_TYPES
    .map(escapeCssIdentifier)
    .filter((t) => t.length > 0)
    .map((t) => `[data-field-type="${t}"]`)
    .join('');

  const blockedGroups = HIDDEN_GROUP_IDS
    .map(escapeCssIdentifier)
    .filter((id) => id.length > 0)
    .map((id) => `${hostSelector} .fjs-palette-group[data-group-id="${id}"]`)
    .join(',\n');

  const tileRule =
    `${hostSelector} .fjs-palette-field[data-field-type]:not(${allowedAttr
      .split('][')
      .join('],[data-field-type][')}) { display: none !important; }`;

  // ^ We want "NOT any allowed type". The simplest robust form:
  //   .fjs-palette-field:not([data-field-type="A"]):not([data-field-type="B"])…
  const chainedNegation = ALLOWED_FIELD_TYPES
    .map(escapeCssIdentifier)
    .filter((t) => t.length > 0)
    .map((t) => `:not([data-field-type="${t}"])`)
    .join('');

  const tileHide =
    `${hostSelector} .fjs-palette-field[data-field-type]${chainedNegation} { display: none !important; }`;

  // Ignore the fallback tileRule — chainedNegation is the version that
  // actually holds in browsers. Keeping the definition above for reference.
  void tileRule;

  const groupHide = blockedGroups ? `${blockedGroups} { display: none !important; }` : '';

  return [tileHide, groupHide].filter(Boolean).join('\n');
}

/**
 * Installs the palette filter by injecting a scoped stylesheet into the
 * editor host. Returns a dispose function that removes the stylesheet.
 *
 * The stylesheet is attached as a `<style>` child of the host (not
 * `<head>`) so multiple editor instances stay isolated and cleanup is
 * straightforward — just remove the host and the style goes with it.
 */
export function setupPaletteFilter(host: HTMLElement): () => void {
  // Stable per-host class used as the CSS scope. If a previous instance
  // left one behind, reuse it; otherwise mint a fresh one.
  const SCOPE_CLASS = 'fjs-palette-scope';
  host.classList.add(SCOPE_CLASS);

  const style = document.createElement('style');
  style.setAttribute('data-fjs-palette-filter', '1');
  style.textContent = buildCss(`.${SCOPE_CLASS}`);
  host.appendChild(style);

  return () => {
    try {
      style.remove();
    } catch {
      /* host already torn down */
    }
  };
}
