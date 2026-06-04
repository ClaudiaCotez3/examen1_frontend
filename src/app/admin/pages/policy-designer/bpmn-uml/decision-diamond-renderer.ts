/**
 * UML-style renderer for bpmn:ExclusiveGateway.
 *
 * Draws the exclusive gateway as a CLEAN diamond — exactly like bpmn-js's
 * default gateway shape but WITHOUT the "X" marker — so the canvas matches
 * the marker-less diamond icon shown in the palette (UML decision node).
 *
 * bpmn-js only paints the "X" when `di.isMarkerVisible` is true; rather than
 * mutating the DI (which would change the exported XML), we override the
 * drawing and simply never paint the marker.
 *
 * IMPORTANT — this is purely a *visual* override:
 *   - The element stays a `bpmn:ExclusiveGateway` internally; `$type`, DI,
 *     bounds (50×50) and exported XML are untouched.
 *   - {@link DecisionDiamondRenderer.getShapePath} reproduces bpmn-js's
 *     `getDiamondPath` verbatim (absolute coordinates), so connection
 *     cropping/docking behaves exactly as before.
 */
import BaseRenderer from 'diagram-js/lib/draw/BaseRenderer';
import {
  append as svgAppend,
  create as svgCreate,
  attr as svgAttr
} from 'tiny-svg';

/** Above BpmnRenderer (1000) so our marker-less drawShape wins. */
const RENDER_PRIORITY = 1500;

interface BpmnElementLike {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  labelTarget?: unknown;
  waypoints?: unknown;
  businessObject?: { $type?: string };
}

function isExclusiveGatewayShape(element: BpmnElementLike): boolean {
  // The shape itself — never its external label (labelTarget) or a connection.
  return (
    !element.labelTarget &&
    !element.waypoints &&
    element.businessObject?.$type === 'bpmn:ExclusiveGateway'
  );
}

/**
 * Diamond path in ABSOLUTE diagram coordinates — a verbatim copy of
 * bpmn-js's `getDiamondPath` (lib/draw/BpmnRenderUtil), so docking and
 * cropping stay byte-for-byte identical to the stock renderer.
 */
function diamondPath(shape: BpmnElementLike): string {
  const width = shape.width ?? 50;
  const height = shape.height ?? 50;
  const x = shape.x ?? 0;
  const y = shape.y ?? 0;
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  return [
    'M', x + halfWidth, y,
    'l', halfWidth, halfHeight,
    'l', -halfWidth, halfHeight,
    'l', -halfWidth, -halfHeight,
    'z'
  ].join(' ');
}

export class DecisionDiamondRenderer extends BaseRenderer {
  // didi dependency injection — resolved by name from the bpmn-js injector.
  static $inject = ['eventBus'];

  constructor(eventBus: unknown) {
    super(eventBus as never, RENDER_PRIORITY);
  }

  override canRender(element: BpmnElementLike): boolean {
    return isExclusiveGatewayShape(element);
  }

  /**
   * Same diamond bpmn-js draws (white fill, black stroke, rounded joins) —
   * minus the "X" marker.
   */
  override drawShape(parentGfx: SVGElement, element: BpmnElementLike): SVGElement {
    const width = element.width ?? 50;
    const height = element.height ?? 50;

    const points = [
      `${width / 2},0`,
      `${width},${height / 2}`,
      `${width / 2},${height}`,
      `0,${height / 2}`
    ].join(' ');

    const polygon = svgCreate('polygon') as SVGPolygonElement;
    svgAttr(polygon, {
      points,
      fill: '#ffffff',
      fillOpacity: 0.95,
      stroke: '#000000',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round'
    } as Record<string, unknown>);

    svgAppend(parentGfx, polygon);
    return polygon;
  }

  override getShapePath(shape: BpmnElementLike): string {
    return diamondPath(shape);
  }
}

/**
 * additionalModules entry. `__init__` forces eager instantiation so the
 * renderer registers itself before the first draw.
 */
const decisionDiamondRendererModule = {
  __init__: ['decisionDiamondRenderer'],
  decisionDiamondRenderer: ['type', DecisionDiamondRenderer]
};

export default decisionDiamondRendererModule;
