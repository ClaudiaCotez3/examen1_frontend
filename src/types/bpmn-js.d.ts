declare module 'bpmn-js/lib/Modeler' {
  /** Minimal typing for bpmn-js Modeler. Expand as needed. */
  export default class BpmnModeler {
    constructor(options: { container: HTMLElement | string; keyboard?: { bindTo?: unknown } });
    importXML(xml: string): Promise<{ warnings: unknown[] }>;
    saveXML(options?: { format?: boolean }): Promise<{ xml: string }>;
    saveSVG(): Promise<{ svg: string }>;
    get<T = any>(name: string): T;
    on(event: string, callback: (ev: any) => void): void;
    off(event: string, callback?: (ev: any) => void): void;
    destroy(): void;
  }
}
