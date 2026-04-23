/**
 * Custom BPMN palette provider.
 *
 * This workflow designer targets business users, so the palette is restricted
 * to the small subset of BPMN elements we actually support at runtime:
 *
 *   - Start Event
 *   - End Event
 *   - Task (Activity)
 *   - Exclusive Gateway (Decision)
 *   - Parallel Gateway
 *   - Participant / Lane (Department)
 *
 * Everything else (user/service/script tasks, subprocesses, intermediate
 * events, inclusive/event-based gateways, data objects, text annotations,
 * groups) is intentionally omitted.
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
  group: 'event' | 'activity' | 'gateway' | 'lane';
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
  { id: 'create.end-event', type: 'bpmn:EndEvent', group: 'event', title: 'Crear evento de fin', className: 'bpmn-icon-end-event-none' },

  // Actividades
  { id: 'create.task', type: 'bpmn:Task', group: 'activity', title: 'Crear actividad', className: 'bpmn-icon-task' },

  // Decisiones (gateways)
  { id: 'create.exclusive-gateway', type: 'bpmn:ExclusiveGateway', group: 'gateway', title: 'Decisión exclusiva (XOR)', className: 'bpmn-icon-gateway-xor' },
  { id: 'create.parallel-gateway', type: 'bpmn:ParallelGateway', group: 'gateway', title: 'Paralelo (AND)', className: 'bpmn-icon-gateway-parallel' },

  // Lanes (pools / carriles = departamentos)
  { id: 'create.participant-expanded', type: 'bpmn:Participant', group: 'lane', title: 'Crear departamento', className: 'bpmn-icon-participant', options: { isExpanded: true } }
];

/**
 * Replaces the default palette with a restricted, categorized version. The
 * tool group at the top (hand / lasso / space / global-connect) is preserved
 * as-is because it isn't a BPMN-element category and users already recognize it.
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
      // Participant (pool) needs the specialized factory so the process
      // reference + horizontal orientation get wired up correctly.
      if (opt.type === 'bpmn:Participant') {
        const participant = elementFactory.createParticipantShape(
          (opt.options as any)?.isExpanded ?? true
        );
        create.start(event, participant);
        return;
      }

      const shape = elementFactory.createShape({
        type: opt.type,
        ...(opt.options ?? {})
      });

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
  lane: 'Departamentos'
};

const COLLAPSED_STORAGE_KEY = 'policy-designer:palette-collapsed:v2';

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

/** All categories expanded initially — the restricted set fits without overflow. */
function defaultState(): Record<string, boolean> {
  return Object.keys(COLLAPSIBLE_GROUPS).reduce<Record<string, boolean>>(
    (acc, k) => ((acc[k] = false), acc),
    {}
  );
}
