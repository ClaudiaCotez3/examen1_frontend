import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import { Role } from '../../../core/models/role.model';
import { UserRequest } from '../../../core/models/user.model';
import { RoleService } from '../../../core/services/role.service';
import { UserService } from '../../../core/services/user.service';

/**
 * Single component handling both user *creation* and *edition*.
 *
 * Mode is inferred from the route param `:id`:
 *   - present  → editing (password is optional, untouched if blank)
 *   - absent   → creating (password is required)
 *
 * Role IDs are resolved from the catalog at submit time, so the dropdown
 * shows human names while the request payload carries the persisted id.
 */
@Component({
  selector: 'app-user-form',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './user-form.component.html',
  styleUrl: './user-form.component.scss'
})
export class UserFormComponent implements OnInit {
  private readonly userService = inject(UserService);
  private readonly roleService = inject(RoleService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly editingId = signal<string | null>(null);
  readonly roles = signal<Role[]>([]);

  readonly fullName = signal<string>('');
  readonly email = signal<string>('');
  readonly password = signal<string>('');
  readonly roleId = signal<string>('');

  readonly status = signal<'idle' | 'saving' | 'error'>('idle');
  readonly errorMessage = signal<string>('');
  readonly fieldErrors = signal<Record<string, string>>({});

  readonly isEditing = computed<boolean>(() => this.editingId() !== null);

  readonly canSubmit = computed<boolean>(() => {
    const errors: Record<string, string> = {};
    if (!this.fullName().trim()) errors['fullName'] = 'Required';
    if (!this.email().trim()) errors['email'] = 'Required';
    if (!this.roleId()) errors['roleId'] = 'Required';
    if (!this.isEditing() && !this.password().trim()) {
      errors['password'] = 'Required';
    }
    if (this.password() && this.password().length < 8) {
      errors['password'] = 'Min 8 characters';
    }
    return Object.keys(errors).length === 0;
  });

  ngOnInit(): void {
    this.roleService.load().subscribe({
      next: (roles) => {
        this.roles.set(roles);
        // Default to OPERATOR for new users — the most common case in this
        // workflow tool.
        if (!this.editingId() && !this.roleId()) {
          const op = roles.find((r) => r.name === 'OPERATOR');
          if (op) this.roleId.set(op.id);
        }
      },
      error: () => this.setError('Failed to load roles')
    });

    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.editingId.set(id);
      this.loadExisting(id);
    }
  }

  private loadExisting(id: string): void {
    this.userService.getById(id).subscribe({
      next: (u) => {
        this.fullName.set(u.name);
        this.email.set(u.email);
        this.roleId.set(u.roleId);
        // Password intentionally left blank — server keeps the old hash if
        // we omit the field at update time.
      },
      error: () => this.setError('Failed to load user')
    });
  }

  validate(): boolean {
    const errors: Record<string, string> = {};
    if (!this.fullName().trim()) errors['fullName'] = 'Full name is required';
    if (!this.email().trim()) {
      errors['email'] = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email().trim())) {
      errors['email'] = 'Invalid email format';
    }
    if (!this.roleId()) errors['roleId'] = 'Role is required';
    if (!this.isEditing()) {
      if (!this.password()) errors['password'] = 'Password is required';
      else if (this.password().length < 8) errors['password'] = 'Min 8 characters';
    } else if (this.password() && this.password().length < 8) {
      errors['password'] = 'Min 8 characters (or leave blank to keep current)';
    }
    this.fieldErrors.set(errors);
    return Object.keys(errors).length === 0;
  }

  submit(): void {
    if (!this.validate()) return;

    const payload: UserRequest = {
      name: this.fullName().trim(),
      email: this.email().trim(),
      roleId: this.roleId()
    };
    if (this.password().trim()) {
      payload.password = this.password();
    }

    this.status.set('saving');
    this.errorMessage.set('');

    const editing = this.editingId();
    const obs = editing
      ? this.userService.update(editing, payload)
      : this.userService.create(payload);

    obs.subscribe({
      next: () => this.router.navigate(['/users']),
      error: (err) => {
        this.status.set('error');
        const msg =
          (err as { error?: { message?: string } })?.error?.message ??
          (err as { message?: string })?.message ??
          'Failed to save user';
        this.errorMessage.set(msg);
      }
    });
  }

  cancel(): void {
    this.router.navigate(['/users']);
  }

  hasError(field: string): boolean {
    return !!this.fieldErrors()[field];
  }

  errorFor(field: string): string {
    return this.fieldErrors()[field] ?? '';
  }

  private setError(msg: string): void {
    this.status.set('error');
    this.errorMessage.set(msg);
  }
}
