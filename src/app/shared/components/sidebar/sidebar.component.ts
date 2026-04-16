import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

interface NavItem {
  label: string;
  route: string;
  icon: string;
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, LucideAngularModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  readonly items: NavItem[] = [
    { label: 'Dashboard', route: '/admin', icon: 'layout-dashboard' },
    { label: 'Policy Designer', route: '/admin/policies/new', icon: 'workflow' },
    { label: 'Tasks', route: '/operator', icon: 'clipboard-list' },
    { label: 'Consultation', route: '/consultation', icon: 'search' }
  ];
}
