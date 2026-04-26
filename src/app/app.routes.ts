import { Routes } from '@angular/router';

import { authGuard } from './core/guards/auth.guard';
import { landingGuard } from './core/guards/landing.guard';
import { roleGuard } from './core/guards/role.guard';
import { RoleName } from './core/models/auth.model';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./auth/pages/login/login.component').then((m) => m.LoginComponent)
  },
  {
    path: '',
    loadComponent: () =>
      import('./shared/components/layout/layout.component').then((m) => m.LayoutComponent),
    canActivate: [authGuard],
    children: [
      // Admin — ADMIN only (matches backend /api/admin/**, /api/users/**, /api/roles/**, /api/business-policies/**)
      {
        path: 'admin',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/dashboard/dashboard.component').then((m) => m.DashboardComponent)
      },
      {
        path: 'admin/policies',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/policy-management/policy-management.component').then(
            (m) => m.PolicyManagementComponent
          )
      },
      {
        path: 'admin/policies/new',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/policy-designer/policy-designer.component').then(
            (m) => m.PolicyDesignerComponent
          )
      },
      {
        path: 'admin/policies/edit/:id',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/policy-designer/policy-designer.component').then(
            (m) => m.PolicyDesignerComponent
          )
      },
      {
        // Start-form editor: the admin lands here from the Policy Designer
        // ("Configurar formulario" button) to author the dynamic form the
        // consultor will fill when initiating a case. Reuses FormBuilder
        // via `data.mode`.
        path: 'admin/policies/start-form',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN], mode: 'policy-start' },
        loadComponent: () =>
          import('./admin/pages/form-builder/form-builder.component').then(
            (m) => m.FormBuilderComponent
          )
      },

      // Users — ADMIN. Catalog of accounts that can log into the system.
      // OPERATORs created here become assignable to BPMN activities.
      {
        path: 'users',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/user-management/user-management.component').then(
            (m) => m.UserManagementComponent
          )
      },
      {
        path: 'users/create',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/user-form/user-form.component').then(
            (m) => m.UserFormComponent
          )
      },
      {
        path: 'users/edit/:id',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/user-form/user-form.component').then(
            (m) => m.UserFormComponent
          )
      },

      // Forms — ADMIN. Catalog of reusable forms (list / create / edit).
      // Activities reference these by id from the Policy Designer.
      {
        path: 'forms',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/form-management/form-management.component').then(
            (m) => m.FormManagementComponent
          )
      },
      {
        path: 'forms/create',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/form-builder/form-builder.component').then(
            (m) => m.FormBuilderComponent
          )
      },
      {
        path: 'forms/edit/:id',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/form-builder/form-builder.component').then(
            (m) => m.FormBuilderComponent
          )
      },

      // Operator — OPERATOR, SUPERVISOR, ADMIN (matches backend /api/operator/**)
      { path: 'operator', pathMatch: 'full', redirectTo: 'operator/tasks' },
      {
        path: 'operator/tasks',
        canActivate: [roleGuard],
        data: { roles: [RoleName.OPERATOR, RoleName.SUPERVISOR, RoleName.ADMIN] },
        loadComponent: () =>
          import('./operator/pages/task-monitor/task-monitor.component').then(
            (m) => m.TaskMonitorComponent
          )
      },
      {
        // "Iniciar trámite" is a customer-facing action (consultor role).
        // Operators claim tasks; they don't start procedures.
        path: 'operator/start',
        canActivate: [roleGuard],
        data: { roles: [RoleName.CONSULTATION, RoleName.SUPERVISOR, RoleName.ADMIN] },
        loadComponent: () =>
          import('./operator/pages/start-process/start-process.component').then(
            (m) => m.StartProcessComponent
          )
      },

      // Consultation — CONSULTATION, SUPERVISOR, ADMIN (matches backend /api/consultation/**)
      {
        path: 'consultation',
        canActivate: [roleGuard],
        data: {
          roles: [RoleName.CONSULTATION, RoleName.SUPERVISOR, RoleName.ADMIN]
        },
        loadComponent: () =>
          import('./consultation/pages/consultation/consultation.component').then(
            (m) => m.ConsultationComponent
          )
      },

      // Empty path inside the layout → role-based dispatch.
      // The guard returns a UrlTree, so the EmptyComponent never renders;
      // the user is sent to /admin, /operator/tasks or /consultation
      // depending on their role (or back to /login if the session is gone).
      {
        path: '',
        pathMatch: 'full',
        canActivate: [landingGuard],
        loadComponent: () =>
          import('./shared/components/empty/empty.component').then((m) => m.EmptyComponent)
      }
    ]
  },
  { path: '**', redirectTo: 'login' }
];
