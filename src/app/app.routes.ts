import { Routes } from '@angular/router';

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
    children: [
      {
        path: 'admin',
        loadComponent: () =>
          import('./admin/pages/dashboard/dashboard.component').then((m) => m.DashboardComponent)
      },
      {
        path: 'admin/policies/new',
        loadComponent: () =>
          import('./admin/pages/policy-designer/policy-designer.component').then(
            (m) => m.PolicyDesignerComponent
          )
      },
      {
        path: 'operator',
        loadComponent: () =>
          import('./operator/pages/task-monitor/task-monitor.component').then(
            (m) => m.TaskMonitorComponent
          )
      },
      {
        path: 'consultation',
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
