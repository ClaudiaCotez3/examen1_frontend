export interface User {
  id: string;
  name: string;
  email: string;
  roleId: string;
  active: boolean;
  createdAt: string;
}

export interface UserRequest {
  name: string;
  email: string;
  password?: string;
  roleId: string;
}
