/**
 * Custom BPMN palette provider.
 *
 * The stock bpmn-js palette is correct but minimal: a single gateway icon,
 * a single task, no labels for the implicit groupings. For business users
 * we want a richer, categorized layout (Actividades / Decisiones / Eventos
 * / Otros) so finding the right shape is a glance, not a search.
 *
 * Layout strategy
 *   - Group keys stay in English (`activity`, `gateway`, `event`, `other`)
 *     so the existing bpmn-js separator logic keeps working unchanged.
 *   - Spanish category labels are rendered by CSS in `styles.scss` via
 *     `[data-group="…"]::before` rules — keeping markup out of the entries
 *     map means the entries themselves stay drag-and-droppable as-is.
 *   - The default provider runs first (priority 1000); ours is registered
 *     at priority 500 so we can mutate / replace its entries.
 */

interface BpmnModelerLike {
  get<T = any>(name: string, strict?: boolean): T;
}

interface PaletteOption {
  /** Stable id under which the entry lives in the palette map. */
  id: string;
  /** BPMN $type to instantiate when dragged onto the canvas. */
  type: string;
  /** Internal group key (drives CSS-based section labels). */
  group: 'event' | 'activity' | 'gateway' | 'other';
  /** Tooltip text shown on hover. */
  title: string;
  /** bpmn-icon-* CSS class for the icon. */
  className: string;
  /** Optional initial businessObject overrides (e.g. isExpanded). */
  options?: Record<string, unknown>;
}

const PALETTE_OPTIONS: PaletteOption[] = [
  // Eventos
  { id: 'create.start-event', type: 'bpmn:StartEvent', group: 'event', title: 'Crear evento de inicio', className: 'bpmn-icon-start-event-none' },
  { id: 'create.intermediate-event', type: 'bpmn:IntermediateThrowEvent', group: 'event', title: 'Crear evento intermedio', className: 'bpmn-icon-intermediate-event-none' },
  { id: 'create.end-event', type: 'bpmn:EndEvent', group: 'event', title: 'Crear evento de fin', className: 'bpmn-icon-end-event-none' },

  // Actividades
  { id: 'create.task', type: 'bpmn:Task', group: 'activity', title: 'Crear tarea', className: 'bpmn-icon-task' },
  { id: 'create.user-task', type: 'bpmn:UserTask', group: 'activity', title: 'Crear tarea de usuario', className: 'bpmn-icon-user-task' },
  { id: 'create.service-task', type: 'bpmn:ServiceTask', group: 'activity', title: 'Crear tarea de servicio', className: 'bpmn-icon-service-task' },
  { id: 'create.manual-task', type: 'bpmn:ManualTask', group: 'activity', title: 'Crear tarea manual', className: 'bpmn-icon-manual-task' },
  { id: 'create.script-task', type: 'bpmn:ScriptTask', group: 'activity', title: 'Crear tarea de script', className: 'bpmn-icon-script-task' },
  { id: 'create.subprocess-expanded', type: 'bpmn:SubProcess', group: 'activity', title: 'Crear subproceso', className: 'bpmn-icon-subprocess-expanded', options: { isExpanded: true } },
  { id: 'create.call-activity', type: 'bpmn:CallActivity', group: 'activity', title: 'Invocar otro proceso', className: 'bpmn-icon-call-activity' },

  // Decisiones (gateways)
  { id: 'create.exclusive-gateway', type: 'bpmn:ExclusiveGateway', group: 'gateway', title: 'Decisión exclusiva (XOR)', className: 'bpmn-icon-gateway-xor' },
  { id: 'create.parallel-gateway', type: 'bpmn:ParallelGateway', group: 'gateway', title: 'Paralelo (AND)', className: 'bpmn-icon-gateway-parallel' },
  { id: 'create.inclusive-gateway', type: 'bpmn:InclusiveGateway', group: 'gateway', title: 'Decisión inclusiva (OR)', className: 'bpmn-icon-gateway-or' },
  { id: 'create.event-gateway', type: 'bpmn:EventBasedGateway', group: 'gateway', title: 'Por evento', className: 'bpmn-icon-gateway-eventbased' },

  // Otros (datos, anotaciones, colaboración)
  { id: 'create.data-object', type: 'bpmn:DataObjectReference', group: 'other', title: 'Objeto de datos', className: 'bpmn-icon-data-object' },
  { id: 'create.data-store', type: 'bpmn:DataStoreReference', group: 'other', title: 'Almacén de datos', className: 'bpmn-icon-data-store' },
  { id: 'create.text-annotation', type: 'bpmn:TextAnnotation', group: 'other', title: 'Nota / comentario', className: 'bpmn-icon-text-annotation' },
  { id: 'create.group', type: 'bpmn:Group', group: 'other', title: 'Agrupar', className: 'bpmn-icon-group' }
];

/**
 * Replaces the default palette with a richer, categorized version. The tool
 * group at the top (hand / lasso / space / global-connect) is preserved as-is
 * because it isn't a BPMN-element category and users already recognize it.
 */
export function registerCustomPalette(modeler: BpmnModelerLike): void {
  const palette = modeler.get<any>('palette');
  const create = modeler.get<any>('create');
  const elementFactory = modeler.get<any>('elementFactory');
  const handTool = modeler.get<any>('handTool');
  const lassoTool = modeler.get<any>('lassoTool');
  const spaceTool = modeler.get<any>('spaceTool');
  const globalConnect = modeler.get<any>('globalConnect');

  const buildCreateEntry = (opt: PaletteOption) => {
    const start = (event: any) => {
      const shape = elementFactory.createShape({
        type: opt.type,
        ...(opt.options ?? {})
      });

      // Subprocess needs a child start event for proper rendering, mirror
      // bpmn-js's default behavior so dragging a subprocess "just works".
      if (opt.type === 'bpmn:SubProcess') {
        const child = elementFactory.createShape({
          type: 'bpmn:StartEvent',
          x: 40,
          y: 82,
          parent: shape
        });
        create.start(event, [shape, child], { hints: { autoSelect: [shape] } });
        return;
      }

      create.start(event, shape);
    };

    return {
      group: opt.group,
      className: opt.className,
      title: opt.title,
      action: { dragstart: start, click: start }
    };
  };

  // Priority 500 < 1000 (default) so this runs AFTER the default provider
  // and we can wholesale-replace its entries with our curated set.
  palette.registerProvider(500, {
    getPaletteEntries: () => () => {
      const entries: Record<string, any> = {
        // Tools (kept in Spanish to match the rest of the UI).
        'hand-tool': {
          group: 'tools',
          className: 'bpmn-icon-hand-tool',
          title: 'Mover lienzo',
          action: { click: (event: any) => handTool.activateHand(event) }
        },
        'lasso-tool': {
          group: 'tools',
          className: 'bpmn-icon-lasso-tool',
          title: 'Selección por lazo',
          action: { click: (event: any) => lassoTool.activateSelection(event) }
        },
        'space-tool': {
          group: 'tools',
          className: 'bpmn-icon-space-tool',
          title: 'Insertar/quitar espacio',
          action: { click: (event: any) => spaceTool.activateSelection(event) }
        },
        'global-connect-tool': {
          group: 'tools',
          className: 'bpmn-icon-connection-multi',
          title: 'Conectar elementos',
          action: { click: (event: any) => globalConnect.start(event) }
        },
        'tool-separator': { group: 'tools', separator: true }
      };

      PALETTE_OPTIONS.forEach((opt) => {
        entries[opt.id] = buildCreateEntry(opt);
      });

      return entries;
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
// Collapsible categories
// ──────────────────────────────────────────────────────────────────────

const COLLAPSIBLE_GROUPS: Record<string, string> = {
  event: 'Eventos',
  activity: 'Actividades',
  gateway: 'Decisiones',
  other: 'Otros'
};

const COLLAPSED_STORAGE_KEY = 'policy-designer:palette-collapsed:v1';

/**
 * Turn each BPMN palette category into an accordion section: collapsed by
 * default (so the palette doesn't overflow the canvas) and toggled via a
 * clickable header injected at the top of each `.group[data-group=…]`.
 *
 * The state per-section is persisted in localStorage so the user's choices
 * survive page reloads. Re-applies on `palette.changed` because diagram-js
 * rebuilds the palette DOM whenever providers register / re-register.
 */
export function setupCollapsiblePaletteSections(modeler: BpmnModelerLike): void {
  const eventBus = modeler.get<any>('eventBus');

  const loadState = (): Record<string, boolean> => {
    try {
      const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      // Backfill missing groups with the default (collapsed).
      return { ...defaultState(), ...parsed };
    } catch {
      return defaultState();
    }
  };

  const saveState = (state: Record<string, boolean>): void => {
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* private mode / quota — degrade silently */
    }
  };

  const collapsed = loadState();

  const apply = () => {
    // Defer to next tick so diagram-js has finished writing the DOM.
    setTimeout(() => {
      const container = document.querySelector('.djs-palette');
      if (!container) return;

      const groups = container.querySelectorAll<HTMLElement>(
        '.djs-palette-entries .group'
      );
      groups.forEach((group) => {
        const key = group.getAttribute('data-group');
        if (!key || !(key in COLLAPSIBLE_GROUPS)) return;

        // Inject the toggle header once per group element. Subsequent
        // palette.changed events just re-sync the collapsed class.
        let header = group.querySelector<HTMLButtonElement>(
          '.palette-section-toggle'
        );
        if (!header) {
          header = document.createElement('button');
          header.type = 'button';
          header.className = 'palette-section-toggle';
          header.innerHTML = `
            <span class="palette-section-toggle__chevron" aria-hidden="true">▸</span>
            <span class="palette-section-toggle__label">${COLLAPSIBLE_GROUPS[key]}</span>
          `;
          header.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            collapsed[key] = !collapsed[key];
            group.classList.toggle('is-collapsed', collapsed[key]);
            saveState(collapsed);
          });
          group.prepend(header);
        }

        group.classList.toggle('is-collapsed', !!collapsed[key]);
      });
    }, 0);
  };

  eventBus.on('palette.changed', apply);
  apply();
}

/** All categories collapsed initially so the palette stays compact. */
function defaultState(): Record<string, boolean> {
  return Object.keys(COLLAPSIBLE_GROUPS).reduce<Record<string, boolean>>(
    (acc, k) => ((acc[k] = true), acc),
    {}
  );
}
