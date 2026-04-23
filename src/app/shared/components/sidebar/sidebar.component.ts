import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import { RoleName } from '../../../core/models/auth.model';
import { AuthService } from '../../../core/services/auth.service';

interface NavItem {
  label: string;
  route: string;
  icon: string;
  roles: string[];
  /**
   * When true, routerLinkActive only highlights the entry on an exact URL
   * match. Needed for parent routes like `/admin` that would otherwise stay
   * lit while the user is on a child route (`/admin/policies`, `/admin/policies/new`).
   */
  exact?: boolean;
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, LucideAngularModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  private readonly auth = inject(AuthService);

  private readonly items: NavItem[] = [
    {
      label: 'Panel',
      route: '/admin',
      icon: 'layout-dashboard',
      roles: [RoleName.ADMIN],
      exact: true
    },
    { label: 'Usuarios', route: '/users', icon: 'users', roles: [RoleName.ADMIN] },
    { label: 'Formularios', route: '/forms', icon: 'file-text', roles: [RoleName.ADMIN] },
    {
      label: 'Diseñador de procesos',
      route: '/admin/policies/new',
      icon: 'workflow',
      roles: [RoleName.ADMIN]
    },
    {
      label: 'Políticas',
      route: '/admin/policies',
      icon: 'book-open',
      roles: [RoleName.ADMIN],
      exact: true
    },
    {
      label: 'Iniciar trámite',
      route: '/operator/start',
      icon: 'play',
      roles: [RoleName.OPERATOR, RoleName.SUPERVISOR, RoleName.ADMIN]
    },
    {
      label: 'Monitor de tareas',
      route: '/operator/tasks',
      icon: 'clipboard-list',
      roles: [RoleName.OPERATOR, RoleName.SUPERVISOR, RoleName.ADMIN]
    },
    {
      label: 'Consultas',
      route: '/consultation',
      icon: 'search',
      roles: [RoleName.CONSULTATION, RoleName.SUPERVISOR, RoleName.ADMIN]
    }
  ];

  readonly visibleItems = computed<NavItem[]>(() => {
    // Re-evaluate whenever the current user changes.
    this.auth.currentUser();
    return this.items.filter((item) => this.auth.hasAnyRole(item.roles));
  });
}
