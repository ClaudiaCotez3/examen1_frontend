/**
 * Vertical auto-placement for the UML-style editor.
 *
 * bpmn-js places auto-appended elements (context-pad buttons, the "…" append
 * popup) to the RIGHT of the source. This module flips that to BELOW the
 * source so the diagram grows top→bottom like a UML activity diagram:
 *
 *     Inicio
 *       ↓
 *     Actividad
 *       ↓
 *     Fin
 *
 * How it hooks in (verified against the installed sources):
 *   - `diagram-js` AutoPlace.append() fires `eventBus.fire('autoPlace', …)`
 *     and uses the FIRST position a listener returns
 *     (node_modules/diagram-js/lib/features/auto-place/AutoPlace.js).
 *   - The default right-ward handlers run at priorities 100 (diagram-js),
 *     1000 (bpmn-js BpmnAutoPlace) and 2000 (GridSnappingAutoPlaceBehavior,
 *     which actually wins today).
 *   - We register at 2500 so our "below" position short-circuits all of them.
 *
 * Manual drag from the palette uses `create.start` (NOT autoPlace), so this
 * does not affect hand placement — only the one-click append flow.
 */
import { getMid } from 'diagram-js/lib/layout/LayoutUtil';

/** Above GridSnappingAutoPlaceBehavior (2000) so our position wins. */
const HIGH_PRIORITY = 2500;

/** Vertical gap between a source and its auto-placed successor. */
const DISTANCE = 80;

/** Horizontal fan-out (px) applied to successive branches of a gateway. */
const FAN = 90;

interface ShapeLike {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  outgoing?: unknown[];
  businessObject?: { $type?: string };
}

interface AutoPlaceContext {
  source: ShapeLike;
  shape: ShapeLike;
}

interface InjectorLike {
  get<T = unknown>(name: string, strict: false): T | null;
}

const GATEWAY_RE =
  /^bpmn:(ExclusiveGateway|InclusiveGateway|ParallelGateway|EventBasedGateway|ComplexGateway)$/;

function isGateway(el: ShapeLike): boolean {
  return GATEWAY_RE.test(el.businessObject?.$type ?? '');
}

/**
 * Computes the position (CENTER point, as bpmn-js expects) for `shape`
 * placed directly below `source`.
 *
 * When the source is a gateway we fan successive branches out horizontally
 * so multiple outgoing flows don't overlap: first branch left of center,
 * second right, then further out. This mirrors the fan logic already used by
 * the AI placement path in the designer component, but on the X axis because
 * the flow now runs downward.
 */
function belowPosition(source: ShapeLike, shape: ShapeLike): { x: number; y: number } {
  const sourceMid = getMid(source as never) as { x: number; y: number };
  const sourceBottom = (source.y ?? 0) + (source.height ?? 0);
  const shapeHeight = shape.height ?? 0;

  let x = sourceMid.x;
  if (isGateway(source)) {
    const existing = source.outgoing?.length ?? 0;
    const fanOffsets = [-FAN, FAN, -FAN * 2, FAN * 2, 0];
    x = sourceMid.x + (fanOffsets[existing] ?? 0);
  }

  const y = sourceBottom + DISTANCE + shapeHeight / 2;
  return { x, y };
}

/**
 * @param eventBus diagram-js EventBus
 * @param injector didi injector (used to grab gridSnapping defensively)
 */
export function VerticalAutoPlace(eventBus: any, injector: InjectorLike): void {
  // gridSnapping is part of the default BpmnModeler, but resolve it
  // defensively so the module still works if snapping is ever disabled.
  const gridSnapping = injector.get<{ snapValue(v: number, opts?: unknown): number }>(
    'gridSnapping',
    false
  );

  eventBus.on('autoPlace', HIGH_PRIORITY, (context: AutoPlaceContext) => {
    const { source, shape } = context;
    const position = belowPosition(source, shape);

    if (gridSnapping) {
      position.x = gridSnapping.snapValue(position.x);
      position.y = gridSnapping.snapValue(position.y);
    }

    // Returning a defined value makes diagram-js use it and skip the
    // remaining (right-ward) handlers.
    return position;
  });
}

VerticalAutoPlace.$inject = ['eventBus', 'injector'];

/**
 * additionalModules entry. `__init__` instantiates the behavior so its
 * eventBus listener is wired up at modeler startup.
 */
const verticalAutoPlaceModule = {
  __init__: ['verticalAutoPlace'],
  verticalAutoPlace: ['type', VerticalAutoPlace]
};

export default verticalAutoPlaceModule;
