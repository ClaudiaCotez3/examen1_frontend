/**
 * Custom BPMN context-pad customization.
 *
 * Two enhancements over the stock bpmn-js context pad:
 *
 *  1. {@link registerGatewayContextPadEntries} — replaces the single gateway
 *     icon with three explicit buttons (XOR / AND / OR). Same UX Camunda
 *     Modeler uses; less discovery friction than the wrench/replace menu.
 *
 *  2. {@link registerAppendElementPopup} — adds a "…" button whose click
 *     opens a categorized, searchable popup of every appendable element
 *     type (tasks, gateways, events). Mirrors the "Append element" dialog
 *     that ships with the Camunda Web Modeler.
 *
 * Less common types (Event-based / Complex gateways, message events, etc.)
 * remain reachable via the popup or via the wrench/replace menu, so the
 * three-icon shortcut bar stays uncluttered.
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
  },
  {
    type: 'bpmn:InclusiveGateway',
    title: 'Agregar decisión inclusiva (OR)',
    className: 'bpmn-icon-gateway-or'
  }
];

/**
 * Replaces the default `append.gateway` context-pad entry with one button per
 * commonly used gateway type. Safe to call multiple times — bpmn-js tolerates
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

  // Priority < 1000 so we run AFTER the default ContextPadProvider has
  // populated its entries (otherwise `append.gateway` wouldn't exist yet).
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
const GROUP_GATEWAYS = { id: 'gateways', name: 'Decisiones (gateways)' };
const GROUP_EVENTS = { id: 'events', name: 'Eventos' };
const GROUP_OTHER = { id: 'other', name: 'Otros' };

/**
 * Catalog of element types the "Agregar elemento" popup will offer. Curated
 * to match a workflow-engine use case — we deliberately omit constructs
 * that don't map to our backend model (transactions, conversation nodes,
 * choreography, etc.).
 */
const APPEND_OPTIONS: AppendOption[] = [
  // Activities
  { type: 'bpmn:Task', label: 'Tarea', group: GROUP_ACTIVITIES, className: 'bpmn-icon-task', search: 'activity activity actividad' },
  { type: 'bpmn:UserTask', label: 'Tarea de usuario', group: GROUP_ACTIVITIES, className: 'bpmn-icon-user-task', search: 'user persona responsable' },
  { type: 'bpmn:ServiceTask', label: 'Tarea de servicio', group: GROUP_ACTIVITIES, className: 'bpmn-icon-service-task', search: 'service automatica api' },
  { type: 'bpmn:ManualTask', label: 'Tarea manual', group: GROUP_ACTIVITIES, className: 'bpmn-icon-manual-task', search: 'manual' },
  { type: 'bpmn:ScriptTask', label: 'Tarea de script', group: GROUP_ACTIVITIES, className: 'bpmn-icon-script-task', search: 'script codigo' },
  { type: 'bpmn:SubProcess', label: 'Subproceso', group: GROUP_ACTIVITIES, className: 'bpmn-icon-subprocess-collapsed', search: 'subprocess subproceso' },
  { type: 'bpmn:CallActivity', label: 'Invocar otro proceso', group: GROUP_ACTIVITIES, className: 'bpmn-icon-call-activity', search: 'call llamar invocar' },

  // Gateways
  { type: 'bpmn:ExclusiveGateway', label: 'Decisión exclusiva (XOR)', group: GROUP_GATEWAYS, className: 'bpmn-icon-gateway-xor', search: 'xor exclusive si no decision' },
  { type: 'bpmn:ParallelGateway', label: 'Paralelo (AND)', group: GROUP_GATEWAYS, className: 'bpmn-icon-gateway-parallel', search: 'and parallel paralelo simultaneo' },
  { type: 'bpmn:InclusiveGateway', label: 'Decisión inclusiva (OR)', group: GROUP_GATEWAYS, className: 'bpmn-icon-gateway-or', search: 'or inclusive multiple' },
  { type: 'bpmn:EventBasedGateway', label: 'Por evento', group: GROUP_GATEWAYS, className: 'bpmn-icon-gateway-eventbased', search: 'event evento' },
  { type: 'bpmn:ComplexGateway', label: 'Compleja', group: GROUP_GATEWAYS, className: 'bpmn-icon-gateway-complex', search: 'complex compleja' },

  // Events
  { type: 'bpmn:EndEvent', label: 'Fin', group: GROUP_EVENTS, className: 'bpmn-icon-end-event-none', search: 'end fin terminar' },
  { type: 'bpmn:IntermediateThrowEvent', label: 'Evento intermedio', group: GROUP_EVENTS, className: 'bpmn-icon-intermediate-event-none', search: 'intermedio throw' },
  { type: 'bpmn:IntermediateCatchEvent', label: 'Esperar evento', group: GROUP_EVENTS, className: 'bpmn-icon-intermediate-event-catch', search: 'catch wait esperar' },

  // Other
  { type: 'bpmn:TextAnnotation', label: 'Nota / comentario', group: GROUP_OTHER, className: 'bpmn-icon-text-annotation', search: 'note nota comentario' },
  { type: 'bpmn:DataObjectReference', label: 'Objeto de datos', group: GROUP_OTHER, className: 'bpmn-icon-data-object', search: 'data datos objeto' }
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
 * it opens a popup-menu (BPMN-styled, with search) listing every supported
 * element type, grouped by category.
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

  // 1. Popup menu provider — produces one entry per appendable element type.
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
            }
            popupMenu.close();
          }
        };
      });
      return entries;
    }
  });

  // 2. Context-pad entry — the "…" icon. Priority 400 < 500 < 1000 so this
  // runs LAST: after default entries are added and after the gateway-replace
  // provider has converted `append.gateway` into the three explicit buttons.
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
