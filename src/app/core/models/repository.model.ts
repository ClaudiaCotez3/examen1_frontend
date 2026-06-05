/**
 * Repositorio Documental (admin) — mirrors the backend DTOs of
 * /api/admin/repository/** (Opción B: customer as first-class entity).
 */

/** One client row; id `"unidentified"` groups legacy unlinked trámites. */
export interface ClientSummary {
  id: string;
  name: string | null;
  email: string | null;
  ci: string | null;
  caseCount: number;
  documentCount: number;
  lastCaseAt: string | null;
}

export interface RepositoryOverview {
  totalClients: number;
  totalCases: number;
  totalDocuments: number;
  clients: ClientSummary[];
}

export interface ClientCase {
  id: string;
  code: string;
  /** activo | finalizado (raw backend status). */
  status: string;
  policyName: string | null;
  documentCount: number;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface ClientCases {
  client: ClientSummary;
  cases: ClientCase[];
}
