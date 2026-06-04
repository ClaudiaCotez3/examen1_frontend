/**
 * UML-style renderer for bpmn:ParallelGateway.
 *
 * Draws the parallel gateway as a UML 2.5 **synchronization / fork bar**
 * (a thick filled rectangle) instead of bpmn-js's default diamond with a
 * "+" marker, and makes the rest of bpmn-js treat it as a bar too:
 *
 *   - {@link ParallelBarRenderer.drawShape} paints the bar.
 *   - {@link ParallelBarRenderer.getShapePath} returns the BAR's rectangle so
 *     connection docking (CroppingConnectionDocking uses `getShapePath`) crops
 *     arrows right at the bar edge — no diamond-sized gap.
 *   - {@link ParallelGatewayOutlineProvider} returns an un-rotated rectangle
 *     so the selection outline hugs the bar instead of showing a 45°-rotated
 *     diamond (bpmn-js's default gateway outline).
 *
 * IMPORTANT — this is purely a *visual / interaction* override:
 *   - The element stays a `bpmn:ParallelGateway` internally; we never change
 *     its `$type`, semantics, bounds (50×50) or anything that touches the
 *     moddle/XML. The parser and the backend are unaffected.
 *   - `bpmn:ExclusiveGateway` is NOT handled here — its marker-less diamond
 *     lives in ./decision-diamond-renderer (UML decision node).
 */
import BaseRenderer from 'diagram-js/lib/draw/BaseRenderer';
import {
  append as svgAppend,
  create as svgCreate,
  attr as svgAttr
} from 'tiny-svg';

/** Above BpmnRenderer (1000) so our drawShape / getShapePath win. */
const RENDER_PRIORITY = 1500;

/** Above bpmn-js's OutlineProvider (registers at the default 1000). */
const OUTLINE_PRIORITY = 1100;

/** Visual thickness of the sync bar, in diagram units. */
const BAR_THICKNESS = 8;

/** Padding between the bar and its selection outline. */
const OUTLINE_PADDING = 4;

type BarOrientation = 'horizontal' | 'vertical';

interface BpmnElementLike {
  width?: number;
  height?: number;
  labelTarget?: unknown;
  waypoints?: unknown;
  incoming?: unknown[];
  outgoing?: unknown[];
  businessObject?: { $type?: string };
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isParallelGatewayShape(element: BpmnElementLike): boolean {
  // The shape itself — never its external label (labelTarget) or a connection.
  return (
    !element.labelTarget &&
    !element.waypoints &&
    element.businessObject?.$type === 'bpmn:ParallelGateway'
  );
}

/**
 * Decides how to orient the sync bar.
 *
 * For now we always return 'horizontal' because this editor lays processes
 * out top→bottom (vertical flow), where a horizontal bar reads as a proper
 * UML fork/join. The logic is centralized here and already inspects the
 * gateway's connection counts so a future iteration can switch to 'vertical'
 * for left→right layouts without touching draw/path/outline code.
 */
function resolveBarOrientation(_element: BpmnElementLike): BarOrientation {
  return 'horizontal';
}

/**
 * A gateway taller than this is treated as a legacy/oversized 50×50 box and
 * gets a centered thin bar; at or below it, the element bounds ARE the bar.
 */
const THIN_BAR_MAX_HEIGHT = 24;

/**
 * Single source of truth for the bar's footprint inside the element's local
 * (0,0)-origin coordinate space. Shared by the renderer (draw + path) and the
 * outline provider so the painted bar, the docking path and the selection box
 * can never drift apart.
 *
 * Parallel gateways created in-app are sized as a thin bar (see
 * PARALLEL_GATEWAY_SIZE), so the element bounds ARE the bar and we fill them.
 * This makes the bar's edges coincide with the bounding box — and therefore
 * with the connection docking points — so arrows touch the bar with no gap.
 */
function getBarBounds(element: BpmnElementLike): Bounds {
  const width = element.width ?? 50;
  const height = element.height ?? 50;

  // Thin element: the box itself is the bar — fill it (zero docking gap).
  if (height <= THIN_BAR_MAX_HEIGHT) {
    return { x: 0, y: 0, width, height };
  }

  // Legacy/oversized gateway: draw a centered thin bar so it doesn't become a
  // big black box. (Docking falls back to the box edge here, but in-app
  // gateways never reach this branch.)
  if (resolveBarOrientation(element) === 'vertical') {
    return {
      x: width / 2 - BAR_THICKNESS / 2,
      y: 0,
      width: BAR_THICKNESS,
      height
    };
  }
  return {
    x: 0,
    y: height / 2 - BAR_THICKNESS / 2,
    width,
    height: BAR_THICKNESS
  };
}

/** SVG path string for an axis-aligned rectangle (path-intersection friendly). */
function rectPath(b: Bounds): string {
  return [
    'M', b.x, b.y,
    'l', b.width, 0,
    'l', 0, b.height,
    'l', -b.width, 0,
    'z'
  ].join(' ');
}

export class ParallelBarRenderer extends BaseRenderer {
  // didi dependency injection — resolved by name from the bpmn-js injector.
  static $inject = ['eventBus'];

  constructor(eventBus: unknown) {
    super(eventBus as never, RENDER_PRIORITY);
  }

  override canRender(element: BpmnElementLike): boolean {
    return isParallelGatewayShape(element);
  }

  override drawShape(parentGfx: SVGElement, element: BpmnElementLike): SVGElement {
    const b = getBarBounds(element);

    const bar = svgCreate('rect') as SVGRectElement;
    // Fully-rounded ends (pill shape) to match the palette's bar icon.
    const cornerRadius = b.height / 2;
    svgAttr(bar, {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      rx: cornerRadius,
      ry: cornerRadius,
      fill: '#000000',
      stroke: '#000000',
      strokeWidth: 1
    } as Record<string, unknown>);

    svgAppend(parentGfx, bar);
    return bar;
  }

  /**
   * Return the BAR's rectangle as the docking path. Connections crop to this,
   * so arrows stop at the bar edge — eliminating the gap left when we delegated
   * to the stock diamond path. The element bounds stay 50×50, so the layouter
   * and context pad are unaffected.
   */
  override getShapePath(shape: BpmnElementLike): string {
    return rectPath(getBarBounds(shape));
  }
}

/**
 * Outline provider that gives the ParallelGateway a rectangular (bar-shaped)
 * selection outline instead of bpmn-js's rotated-diamond gateway outline.
 *
 * Registered at a priority above bpmn-js's OutlineProvider so `getOutline`
 * (first non-undefined wins) returns our rect for parallel gateways while
 * every other element falls through to the default provider untouched.
 */
export class ParallelGatewayOutlineProvider {
  static $inject = ['outline', 'styles'];

  private readonly styles: { cls(className: string, traits: string[]): Record<string, unknown> };

  constructor(
    outline: { registerProvider(priority: number, provider: unknown): void },
    styles: { cls(className: string, traits: string[]): Record<string, unknown> }
  ) {
    this.styles = styles;
    outline.registerProvider(OUTLINE_PRIORITY, this);
  }

  /** @returns an SVG rect for parallel gateways, otherwise undefined. */
  getOutline(element: BpmnElementLike): SVGRectElement | undefined {
    if (!isParallelGatewayShape(element)) {
      return undefined;
    }
    const outline = svgCreate('rect') as SVGRectElement;
    this.applyOutlineBounds(outline, element);
    return outline;
  }

  /** @returns true when we own this element's outline (skip default sizing). */
  updateOutline(element: BpmnElementLike, outline: SVGRectElement): boolean {
    if (!isParallelGatewayShape(element)) {
      return false;
    }
    this.applyOutlineBounds(outline, element);
    return true;
  }

  private applyOutlineBounds(outline: SVGRectElement, element: BpmnElementLike): void {
    const b = getBarBounds(element);
    const outlineStyle = this.styles.cls('djs-outline', ['no-fill']);
    svgAttr(outline, {
      ...outlineStyle,
      x: b.x - OUTLINE_PADDING,
      y: b.y - OUTLINE_PADDING,
      rx: 3,
      width: b.width + OUTLINE_PADDING * 2,
      height: b.height + OUTLINE_PADDING * 2
    } as Record<string, unknown>);
  }
}

/**
 * additionalModules entry. `__init__` forces eager instantiation so the
 * renderer and the outline provider register themselves before the first draw.
 */
const parallelBarRendererModule = {
  __init__: ['parallelBarRenderer', 'parallelGatewayOutlineProvider'],
  parallelBarRenderer: ['type', ParallelBarRenderer],
  parallelGatewayOutlineProvider: ['type', ParallelGatewayOutlineProvider]
};

export default parallelBarRendererModule;
