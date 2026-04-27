import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { AuthService } from '../../../core/services/auth.service';
import { LayoutStateService } from '../../../core/services/layout-state.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.scss'
})
export class NavbarComponent {
  private readonly authService = inject(AuthService);
  private readonly layout = inject(LayoutStateService);

  readonly currentUser = this.authService.currentUser;
  readonly primaryRole = computed(() => this.currentUser()?.roles?.[0] ?? '');
  readonly sidebarOpen = this.layout.sidebarOpen;

  logout(): void {
    this.authService.logout();
  }

  toggleSidebar(): void {
    this.layout.toggleSidebar();
  }
}
