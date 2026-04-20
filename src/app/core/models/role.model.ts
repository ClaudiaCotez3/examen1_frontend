/**
 * Role descriptor returned by the backend.
 *
 * Roles are persisted server-side (each row has its own ObjectId), so the
 * frontend cannot hard-code role IDs. The {@link RoleName} enum in
 * `auth.model.ts` continues to define the canonical *names* of the four
 * roles the workflow is built around (ADMIN / OPERATOR / SUPERVISOR /
 * CONSULTATION), and we resolve from name → id at runtime via
 * {@link RoleService.getByName}.
 */
export interface Role {
  id: string;
  name: string;
  description?: string;
}

export interface RoleRequest {
  name: string;
  description?: string;
}
