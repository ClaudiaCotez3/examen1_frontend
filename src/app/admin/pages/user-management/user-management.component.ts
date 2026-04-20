import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { forkJoin } from 'rxjs';

import { Role } from '../../../core/models/role.model';
import { User } from '../../../core/models/user.model';
import { RoleService } from '../../../core/services/role.service';
import { UserService } from '../../../core/services/user.service';

interface UserRow extends User {
  /** Resolved role name (e.g. "OPERATOR") for display + filtering. */
  roleName: string;
}

/**
 * Catalog view: lists every user account with role badges, status and the
 * primary CRUD actions (create / edit / change-role / delete).
 *
 * Role mutations are routed through the same `update()` endpoint as edits —
 * the dedicated "Change role" inline control is an ergonomic shortcut so the
 * admin doesn't need to navigate to the form just to flip a single field
 * (the most common bulk operation).
 */
@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './user-management.component.html',
  styleUrl: './user-management.component.scss'
})
export class UserManagementComponent implements OnInit {
  private readonly userService = inject(UserService);
  private readonly roleService = inject(RoleService);
  private readonly router = inject(Router);

  readonly rows = signal<UserRow[]>([]);
  readonly roles = signal<Role[]>([]);
  readonly loading = signal<boolean>(false);
  readonly errorMessage = signal<string>('');

  readonly search = signal<string>('');
  readonly roleFilter = signal<string>('ALL');

  readonly pendingDeleteId = signal<string>('');
  readonly pendingRoleChangeId = signal<string>('');

  readonly visible = computed<UserRow[]>(() => {
    const term = this.search().trim().toLowerCase();
    const role = this.roleFilter();
    return this.rows().filter((u) => {
      if (role !== 'ALL' && u.roleName !== role) return false;
      if (!term) return true;
      return (
        u.name.toLowerCase().includes(term) ||
        u.email.toLowerCase().includes(term)
      );
    });
  });

  ngOnInit(): void {
    this.loadAll();
  }

  loadAll(): void {
    this.loading.set(true);
    this.errorMessage.set('');
    // Roles must arrive before users so the role-name resolution is correct.
    forkJoin({
      roles: this.roleService.load(),
      users: this.userService.getAll()
    }).subscribe({
      next: ({ roles, users }) => {
        this.roles.set(roles);
        this.rows.set(users.map((u) => this.toRow(u, roles)));
        this.loading.set(false);
      },
      error: (err) => this.handleError(err, 'Failed to load users')
    });
  }

  private toRow(u: User, roles: Role[]): UserRow {
    const role = roles.find((r) => r.id === u.roleId);
    return { ...u, roleName: role?.name ?? '—' };
  }

  goToCreate(): void {
    this.router.navigate(['/users/create']);
  }

  goToEdit(user: UserRow): void {
    this.router.navigate(['/users/edit', user.id]);
  }

  // ── change role inline ────────────────────────────────────────────────

  startRoleChange(user: UserRow): void {
    this.pendingRoleChangeId.set(user.id);
  }

  cancelRoleChange(): void {
    this.pendingRoleChangeId.set('');
  }

  applyRoleChange(user: UserRow, newRoleId: string): void {
    if (!newRoleId || newRoleId === user.roleId) {
      this.cancelRoleChange();
      return;
    }
    this.userService
      .update(user.id, {
        name: user.name,
        email: user.email,
        roleId: newRoleId
      })
      .subscribe({
        next: () => {
          this.cancelRoleChange();
          this.loadAll();
        },
        error: (err) => this.handleError(err, 'Failed to change role')
      });
  }

  // ── delete with inline confirmation ───────────────────────────────────

  askDelete(user: UserRow): void {
    this.pendingDeleteId.set(user.id);
  }

  cancelDelete(): void {
    this.pendingDeleteId.set('');
  }

  confirmDelete(user: UserRow): void {
    this.userService.delete(user.id).subscribe({
      next: () => {
        this.pendingDeleteId.set('');
        this.loadAll();
      },
      error: (err) => {
        this.pendingDeleteId.set('');
        this.handleError(err, 'Failed to delete user');
      }
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────

  badgeClassFor(roleName: string): string {
    switch (roleName) {
      case 'ADMIN': return 'badge badge--admin';
      case 'OPERATOR': return 'badge badge--operator';
      case 'SUPERVISOR': return 'badge badge--supervisor';
      case 'CONSULTATION': return 'badge badge--consultation';
      default: return 'badge';
    }
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : d.toLocaleDateString();
  }

  dismissError(): void {
    this.errorMessage.set('');
  }

  private handleError(err: unknown, fallback: string): void {
    this.loading.set(false);
    const msg =
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback;
    this.errorMessage.set(msg);
  }
}
