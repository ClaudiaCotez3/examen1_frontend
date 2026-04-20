import { Injectable } from '@angular/core';

/**
 * Narrow structural type for the parts of a bpmn-js Modeler instance we touch.
 * Kept local so this service doesn't force the full bpmn-js types into every
 * caller and stays trivially mockable in tests.
 */
interface BpmnModelerLike {
  saveXML(opts?: { format?: boolean }): Promise<{ xml: string }>;
  saveSVG(): Promise<{ svg: string }>;
}

/**
 * Stateless helpers for turning the current modeler state into files the
 * business user can download. The modeler itself is still owned by the
 * Policy Designer component (it's tied to a ViewChild container), but all
 * serialization lives here so the component stays focused on UI.
 */
@Injectable({ providedIn: 'root' })
export class BpmnExportService {
  /** Pretty-printed BPMN 2.0 XML. Thin wrapper; kept so callers have one API. */
  async exportXml(modeler: BpmnModelerLike): Promise<string> {
    const { xml } = await modeler.saveXML({ format: true });
    return xml;
  }

  /** Raw SVG string of the current diagram. */
  async exportSvg(modeler: BpmnModelerLike): Promise<string> {
    const { svg } = await modeler.saveSVG();
    return svg;
  }

  /**
   * Render the diagram SVG into a PNG Blob via a canvas. The SVG is converted
   * through an `Image` element backed by a Blob URL — this keeps the canvas
   * "un-tainted" so `toBlob()` succeeds even in Chrome's strict mode.
   *
   * @param scale device-pixel multiplier. 2× gives crisp renders on HiDPI.
   */
  async exportPng(modeler: BpmnModelerLike, scale = 2): Promise<Blob> {
    const svg = await this.exportSvg(modeler);
    return this.svgStringToPngBlob(svg, scale);
  }

  /** Triggers a browser download for an arbitrary Blob. */
  downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // Revoke on next tick so Safari has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  /** Convenience: download a text payload with the right MIME type. */
  downloadText(text: string, filename: string, mime: string): void {
    this.downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
  }

  private svgStringToPngBlob(svg: string, scale: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();

      img.onload = () => {
        try {
          // Fall back to bounding rect when naturalWidth is 0 (some SVGs lack
          // intrinsic size; bpmn-js output always sets width/height but guard
          // anyway).
          const w = img.naturalWidth || 1200;
          const h = img.naturalHeight || 800;
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas 2D context unavailable'));
            return;
          }
          // White background so PNG viewers don't render a transparent blob.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.setTransform(scale, 0, 0, scale, 0, 0);
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Canvas toBlob returned null'));
          }, 'image/png');
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load SVG for PNG conversion'));
      };
      img.src = url;
    });
  }
}
