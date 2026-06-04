/**
 * Shared bits for the UML "parallel gateway as a bar" treatment.
 *
 * The key insight behind the *size*: bpmn-js routes a connection's endpoint to
 * the target's BOUNDING-BOX edge (ManhattanLayout `getDockingPoint`), and only
 * then crops it against the shape path. A thin bar centered inside a 50×50 box
 * can never touch the arrow, because the arrow stops at the box edge ~21px
 * away. The fix is to make the gateway's bounding box BE the bar (thin), so the
 * box edge == the bar edge and arrows dock flush against it.
 *
 * `ElementFactory.create` assigns explicit `width`/`height` AFTER
 * `getDefaultSize`, so passing this size when creating the shape overrides the
 * default 50×50 without any custom factory.
 */
export const PARALLEL_GATEWAY_SIZE = { width: 90, height: 10 };

/**
 * Icon class for the EXCLUSIVE gateway entry in palettes/menus. We use the
 * plain (marker-less) diamond `bpmn-icon-gateway-none` so the decision node
 * shows as a clean rombo WITHOUT the "X" marker.
 */
export const EXCLUSIVE_GATEWAY_ICON_CLASS = 'bpmn-icon-gateway-none';

/**
 * Data-URI icon for the PARALLEL gateway entry: a small horizontal bar that
 * mirrors the rendered sync bar. Used as `imageUrl` (supported by the palette,
 * context pad and popup menu) instead of the default diamond-with-"+" glyph.
 */
export const PARALLEL_BAR_ICON_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" fill="#000000">
       <rect x="3" y="9" width="16" height="4" rx="2"/>
     </svg>`
  );

interface ElementFactoryLike {
  createShape(attrs: Record<string, unknown>): unknown;
}

/**
 * Creates a `bpmn:ParallelGateway` shape sized as a thin bar. Internally it is
 * still a plain ParallelGateway — only its bounds (and thus its rendering and
 * docking footprint) change.
 */
export function createParallelGatewayShape(elementFactory: ElementFactoryLike): unknown {
  return elementFactory.createShape({
    type: 'bpmn:ParallelGateway',
    width: PARALLEL_GATEWAY_SIZE.width,
    height: PARALLEL_GATEWAY_SIZE.height
  });
}
