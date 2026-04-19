import { Routes } from '@angular/router';

import { authGuard } from './core/guards/auth.guard';
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
        path: 'admin/policies/new',
        canActivate: [roleGuard],
        data: { roles: [RoleName.ADMIN] },
        loadComponent: () =>
          import('./admin/pages/policy-designer/policy-designer.component').then(
            (m) => m.PolicyDesignerComponent
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
        path: 'operator/start',
        canActivate: [roleGuard],
        data: { roles: [RoleName.OPERATOR, RoleName.SUPERVISOR, RoleName.ADMIN] },
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

      { path: '', pathMatch: 'full', redirectTo: 'admin' }
    ]
  },
  { path: '**', redirectTo: 'login' }
];
