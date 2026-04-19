export const RoleName = {
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR',
  CONSULTATION: 'CONSULTATION',
  SUPERVISOR: 'SUPERVISOR'
} as const;

export type RoleName = (typeof RoleName)[keyof typeof RoleName];

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  roles: string[];
}

export interface LoginResponse {
  token: string;
  tokenType: string;
  expiresInMs: number;
  user: AuthUser;
}
