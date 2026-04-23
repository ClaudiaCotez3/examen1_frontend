/**
 * Custom BPMN context-pad customization.
 *
 * Two enhancements over the stock bpmn-js context pad:
 *
 *  1. {@link registerGatewayContextPadEntries} — replaces the single gateway
 *     icon with two explicit buttons (XOR / AND). Fewer clicks than the
 *     wrench/replace menu and matches the restricted element set.
 *
 *  2. {@link registerAppendElementPopup} — adds a "…" button whose click
 *     opens a categorized, searchable popup listing the supported appendable
 *     element types. Mirrors the "Append element" dialog from Camunda Web
 *     Modeler but restricted to our subset.
 */

interface BpmnModelerLike {
  get<T = any>(name: string, strict?: boolean): T;
}

interface GatewayEntry {
  type: string;
  title: string;
  className: string;
}

const GATEWAY_TYPES: GatewayEntry[] = [
  {
    type: 'bpmn:ExclusiveGateway',
    title: 'Agregar decisión exclusiva (XOR)',
    className: 'bpmn-icon-gateway-xor'
  },
  {
    type: 'bpmn:ParallelGateway',
    title: 'Agregar paralelo (AND)',
    className: 'bpmn-icon-gateway-parallel'
  }
];

/**
 * Replaces the default `append.gateway` context-pad entry with one button per
 * supported gateway type. Safe to call multiple times — bpmn-js tolerates
 * multiple registered providers and we only mutate the entries map.
 */
export function registerGatewayContextPadEntries(modeler: BpmnModelerLike): void {
  const contextPad = modeler.get<any>('contextPad');
  const elementFactory = modeler.get<any>('elementFactory');
  const create = modeler.get<any>('create');
  // autoPlace is optional in some bpmn-js builds; tolerate its absence.
  const autoPlace = (() => {
    try {
      return modeler.get<any>('autoPlace');
    } catch {
      return null;
    }
  })();

  const buildGatewayEntry = (gw: GatewayEntry) => ({
    group: 'model',
    className: gw.className,
    title: gw.title,
    action: {
      click: (event: any, target: any) => {
        const shape = elementFactory.createShape({ type: gw.type });
        if (autoPlace) {
          autoPlace.append(target, shape);
        } else {
          create.start(event, shape, { source: target });
        }
      },
      dragstart: (event: any, target: any) => {
        const shape = elementFactory.createShape({ type: gw.type });
        create.start(event, shape, { source: target });
      }
    }
  });

  contextPad.registerProvider(500, {
    getContextPadEntries: () => (entries: Record<string, any>) => {
      if (!entries['append.gateway']) return entries;

      delete entries['append.gateway'];

      GATEWAY_TYPES.forEach((gw, idx) => {
        entries[`append.gateway-${idx}`] = buildGatewayEntry(gw);
      });

      return entries;
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
// Append-element popup ("..." button + categorized search)
// ──────────────────────────────────────────────────────────────────────

interface AppendOption {
  type: string;
  label: string;
  group: { id: string; name: string };
  className: string;
  /** Extra search keywords so users can find a type by intent. */
  search?: string;
}

const GROUP_ACTIVITIES = { id: 'activities', name: 'Actividades' };
const GROUP_GATEWAYS = { id: 'gateways', name: 'Decisiones' };
const GROUP_EVENTS = { id: 'events', name: 'Eventos' };

/**
 * Restricted catalog of appendable element types. Only the subset that maps
 * to our backend workflow model is exposed; every other BPMN construct
 * (user/service/script/manual tasks, subprocesses, call activities,
 * inclusive/event-based/complex gateways, intermediate events, data objects,
 * text annotations) is intentionally omitted.
 */
const APPEND_OPTIONS: AppendOption[] = [
  { type: 'bpmn:Task', label: 'Actividad', group: GROUP_ACTIVITIES, className: 'bpmn-icon-task', search: 'actividad tarea task' },

  { type: 'bpmn:ExclusiveGateway', label: 'Decisión exclusiva (XOR)', group: GROUP_GATEWAYS, className: 'bpmn-icon-gateway-xor', search: 'xor exclusive si no decision' },
  { type: 'bpmn:ParallelGateway', label: 'Paralelo (AND)', group: GROUP_GATEWAYS, className: 'bpmn-icon-gateway-parallel', search: 'and parallel paralelo simultaneo' },

  { type: 'bpmn:EndEvent', label: 'Fin', group: GROUP_EVENTS, className: 'bpmn-icon-end-event-none', search: 'end fin terminar' }
];

/** Provider id under which we expose the categorized append menu. */
const APPEND_POPUP_ID = 'workflow-append-element';

/**
 * Inline SVG used as the "..." icon. Encoded as a data-URI so we don't have
 * to ship an extra asset. The viewBox matches the bpmn-icon font sizing
 * (16×16) so it lines up with the rest of the context pad row.
 */
const DOTS_SVG_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#374151">
       <circle cx="3" cy="8" r="1.5"/>
       <circle cx="8" cy="8" r="1.5"/>
       <circle cx="13" cy="8" r="1.5"/>
     </svg>`
  );

/**
 * Adds a "…" button to the context pad of every appendable element. Clicking
 * it opens a popup-menu listing every supported element type, grouped by
 * category, with search.
 */
export function registerAppendElementPopup(modeler: BpmnModelerLike): void {
  const contextPad = modeler.get<any>('contextPad');
  const popupMenu = modeler.get<any>('popupMenu');
  const elementFactory = modeler.get<any>('elementFactory');
  const create = modeler.get<any>('create');
  const autoPlace = (() => {
    try {
      return modeler.get<any>('autoPlace');
    } catch {
      return null;
    }
  })();

  popupMenu.registerProvider(APPEND_POPUP_ID, {
    getPopupMenuEntries: (target: any) => () => {
      const entries: Record<string, any> = {};
      APPEND_OPTIONS.forEach((opt, idx) => {
        entries[`append-${idx}`] = {
          label: opt.label,
          group: opt.group,
          className: opt.className,
          search: opt.search,
          action: () => {
            const shape = elementFactory.createShape({ type: opt.type });
            if (autoPlace) {
              autoPlace.append(target, shape);
            } else {
              create.start({} as any, shape, { source: target });
            }
            popupMenu.close();
          }
        };
      });
      return entries;
    }
  });

  contextPad.registerProvider(400, {
    getContextPadEntries: () => (entries: Record<string, any>) => {
      const isAppendable =
        entries['append.gateway-0'] ||
        entries['append.task'] ||
        entries['append.end-event'] ||
        entries['append.intermediate-event'];
      if (!isAppendable) return entries;

      entries['append.anything'] = {
        group: 'model',
        imageUrl: DOTS_SVG_DATA_URI,
        title: 'Agregar elemento…',
        action: {
          click: (event: any, target: any) => {
            const position = {
              x: event.clientX ?? event.x ?? 0,
              y: event.clientY ?? event.y ?? 0,
              cursor: {
                x: event.clientX ?? event.x ?? 0,
                y: event.clientY ?? event.y ?? 0
              }
            };
            popupMenu.open(target, APPEND_POPUP_ID, position, {
              title: 'Agregar elemento',
              width: 320,
              search: true
            });
          }
        }
      };
      return entries;
    }
  });
}
