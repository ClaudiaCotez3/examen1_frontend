import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.scss'
})
export class NavbarComponent {
  private readonly authService = inject(AuthService);

  readonly currentUser = this.authService.currentUser;
  readonly primaryRole = computed(() => this.currentUser()?.roles?.[0] ?? '');

  logout(): void {
    this.authService.logout();
  }
}
