import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';

/** Gráfico sugerido por el analista de reportes. */
export interface ReportChart {
  type: 'bar' | 'line' | 'pie';
  label: string;
  labels: string[];
  values: number[];
}

/** Reporte estructurado devuelto por POST /ai/reports (Módulo 4). */
export interface SmartReport {
  title: string;
  summary: string;
  columns: string[];
  rows: Array<Array<string | number>>;
  chart: ReportChart | null;
  insights: string[];
}

/**
 * Módulo 4 — Reportes Inteligentes. El supervisor pregunta en lenguaje
 * natural y el sidecar FastAPI responde con un reporte estructurado
 * calculado sobre un dataset agregado determinista (la IA narra y
 * selecciona; los números los computa Python desde Mongo).
 */
@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.aiBaseUrl}/ai/reports`;

  ask(question: string): Observable<SmartReport> {
    return this.http.post<SmartReport>(this.url, { question });
  }
}
