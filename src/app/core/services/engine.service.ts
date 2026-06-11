import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';

/** Prioridad derivada de riesgo × demora. */
export type PriorityLevel = 'ALTA' | 'MEDIA' | 'BAJA';

export interface CaseActivityPrediction {
  actividad: string;
  etaMinutos: number;
  riesgo: number;
}

/** Respuesta de GET /engine/predict/{tramiteId}. */
export interface CasePrediction {
  tramiteId: string;
  /** Sólo viene en la cola priorizada. */
  code?: string | null;
  etaMinutos: number;
  riesgo: number;
  prioridad: PriorityLevel;
  prioridadScore?: number;
  actividades: CaseActivityPrediction[];
  /** 'tensorflow' | 'heuristic' | 'n/a' — de dónde salió la predicción. */
  model: string;
  summary: string;
}

export interface PrioritiesResponse {
  items: CasePrediction[];
  model: string;
  summary: string;
}

export interface EngineAnomalyItem {
  caseId: string;
  code: string | null;
  activityName: string | null;
  laneName: string | null;
  leadMinutes: number;
  reconError: number;
  explanation: string;
}

export interface EngineAnomalyResponse {
  items: EngineAnomalyItem[];
  model: string;
  summary: string;
}

export interface AssignmentCandidate {
  operatorId: string;
  operator: string;
  etaMinutos: number;
  riesgo: number;
}

export interface AssignmentRecommendation {
  activityId: string;
  activityName?: string | null;
  recommended?: AssignmentCandidate;
  candidates: AssignmentCandidate[];
  model: string;
  summary: string;
}

export interface EngineStatus {
  modelsTrained: boolean;
  encodersLoaded: boolean;
  tensorflowAvailable: boolean;
  activitiesKnown: number;
  operatorsKnown: number;
  modelsDir: string;
}

/**
 * Cliente del "motor inteligente de enrutamiento y riesgos" (TensorFlow).
 * Vive en el mismo sidecar FastAPI que InsightsService — el auth
 * interceptor inyecta el mismo JWT, que el servicio Python verifica con
 * el secreto HS256 compartido con Spring Boot.
 *
 * Predice demora (ETA), riesgo y prioridad por trámite, detecta
 * anomalías con un autoencoder y recomienda la mejor asignación de
 * operador para una actividad.
 */
@Injectable({ providedIn: 'root' })
export class EngineService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.aiBaseUrl}/engine`;

  /** ¿Están los modelos TF entrenados/cargados? */
  getStatus(): Observable<EngineStatus> {
    return this.http.get<EngineStatus>(`${this.base}/status`);
  }

  /** Demora, riesgo y prioridad de un trámite en curso. */
  predictCase(tramiteId: string): Observable<CasePrediction> {
    return this.http.get<CasePrediction>(`${this.base}/predict/${tramiteId}`);
  }

  /** Cola de trámites activos ordenada por prioridad (riesgo × demora). */
  getPriorities(limit = 20): Observable<PrioritiesResponse> {
    return this.http.get<PrioritiesResponse>(`${this.base}/priorities`, {
      params: { limit }
    });
  }

  /** Anomalías de duración detectadas con el autoencoder TensorFlow. */
  getAnomalies(): Observable<EngineAnomalyResponse> {
    return this.http.get<EngineAnomalyResponse>(`${this.base}/anomalies`);
  }

  /** Recomienda a qué operador asignar una actividad (mejor enrutamiento). */
  recommendAssignment(
    activityId: string,
    candidateOperatorIds: string[]
  ): Observable<AssignmentRecommendation> {
    return this.http.post<AssignmentRecommendation>(`${this.base}/recommend-assignment`, {
      activityId,
      candidateOperatorIds
    });
  }
}
