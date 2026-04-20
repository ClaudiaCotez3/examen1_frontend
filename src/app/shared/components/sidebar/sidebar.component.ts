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
    { label: 'Dashboard', route: '/admin', icon: 'layout-dashboard', roles: [RoleName.ADMIN] },
    { label: 'Users', route: '/users', icon: 'users', roles: [RoleName.ADMIN] },
    { label: 'Forms', route: '/forms', icon: 'file-text', roles: [RoleName.ADMIN] },
    { label: 'Policy Designer', route: '/admin/policies/new', icon: 'workflow', roles: [RoleName.ADMIN] },
    {
      label: 'Start Process',
      route: '/operator/start',
      icon: 'play',
      roles: [RoleName.OPERATOR, RoleName.SUPERVISOR, RoleName.ADMIN]
    },
    {
      label: 'Task Monitor',
      route: '/operator/tasks',
      icon: 'clipboard-list',
      roles: [RoleName.OPERATOR, RoleName.SUPERVISOR, RoleName.ADMIN]
    },
    {
      label: 'Consultation',
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
