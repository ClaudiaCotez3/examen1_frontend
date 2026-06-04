/**
 * UML-style bpmn-js extensions for the Policy Designer.
 *
 * These are loaded via `new BpmnModeler({ additionalModules: [...] })`. Each
 * is a self-contained didi module that only customizes presentation/behavior
 * — none of them change BPMN $types or the exported XML semantics. To turn
 * the UML styling off, simply omit {@link umlExtensionsModules} from the
 * modeler config.
 */
import parallelBarRendererModule from './parallel-bar-renderer';
import decisionDiamondRendererModule from './decision-diamond-renderer';
import verticalAutoPlaceModule from './vertical-auto-place';

export { createVerticalParticipant } from './vertical-pool';
export {
  createParallelGatewayShape,
  PARALLEL_GATEWAY_SIZE,
  PARALLEL_BAR_ICON_DATA_URI,
  EXCLUSIVE_GATEWAY_ICON_CLASS
} from './parallel-gateway';
export {
  COLUMN_FIRST_LEFT_X,
  COLUMN_TOP_Y,
  COLUMN_WIDTH,
  COLUMN_HEIGHT,
  COLUMN_GAP,
  COLUMN_GATEWAY_FAN,
  COLUMN_NODE_STEP_Y
} from './vertical-pool';

/** Drop-in array for BpmnModeler's `additionalModules`. */
export const umlExtensionsModules = [
  parallelBarRendererModule,
  decisionDiamondRendererModule,
  verticalAutoPlaceModule
];
