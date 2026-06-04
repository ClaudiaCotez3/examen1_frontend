/**
 * Vertical "department" pools — UML 2.5 activity-partition look.
 *
 * In this editor every department is an independent `bpmn:Participant`
 * (pool), NOT a `bpmn:Lane`. To get the UML column layout we create each
 * pool as a VERTICAL pool (`isHorizontal=false`) and lay successive pools
 * out left→right instead of stacking them as full-width horizontal bands.
 *
 * bpmn-js 18 supports vertical pools natively:
 *   - `ElementFactory.createParticipantShape` applies `isHorizontal` onto the
 *     shape's DI (node_modules/bpmn-js/.../modeling/ElementFactory.js).
 *   - `IsHorizontalFix` only forces `isHorizontal=true` when it is
 *     `undefined`, so an explicit `false` survives move/create/resize.
 *   - `isHorizontal` is standard BPMN DI, so it round-trips through
 *     import/export with no custom moddle extension.
 *
 * Keeping the Participant model means the parser, the backend payload and the
 * Lane/Activity/Flow mapping are all unchanged — only the visual orientation
 * and the layout axis differ.
 */

/** Left edge of the first column. */
export const COLUMN_FIRST_LEFT_X = 160;
/** Top edge shared by every column. */
export const COLUMN_TOP_Y = 80;
/** Default column width (one department). */
export const COLUMN_WIDTH = 280;
/** Default column height. Tall enough for a short top→bottom flow. */
export const COLUMN_HEIGHT = 600;
/** Horizontal gap between adjacent columns. */
export const COLUMN_GAP = 40;

/** Horizontal fan-out (px from center) for gateway branches in a column. */
export const COLUMN_GATEWAY_FAN = 90;
/** Vertical step between successive nodes stacked inside a column. */
export const COLUMN_NODE_STEP_Y = 120;

interface ElementFactoryLike {
  createParticipantShape(attrs: Record<string, unknown>): unknown;
}

/**
 * Creates a vertical (column) Participant shape ready to be dropped on the
 * canvas. `isExpanded:true` makes the factory attach a fresh `bpmn:Process`
 * via `processRef` (so internal tasks bind to a real process, not the
 * collaboration root); `isHorizontal:false` is what makes it a column.
 */
export function createVerticalParticipant(elementFactory: ElementFactoryLike): unknown {
  return elementFactory.createParticipantShape({
    type: 'bpmn:Participant',
    isExpanded: true,
    isHorizontal: false,
    width: COLUMN_WIDTH,
    height: COLUMN_HEIGHT
  });
}
