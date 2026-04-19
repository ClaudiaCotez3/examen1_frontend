import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, LucideAngularModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]]
  });

  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  ngOnInit(): void {
    // Bounce already-authenticated users to their landing route.
    if (this.auth.isAuthenticated()) {
      const user = this.auth.getCurrentUser();
      if (user) {
        this.router.navigateByUrl(this.auth.resolveLandingRoute(user));
        return;
      }
    }
    if (this.route.snapshot.queryParamMap.get('sessionExpired') === '1') {
      this.info.set('Your session expired. Please sign in again.');
    }
  }

  submit(): void {
    if (this.loading()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.errorMessage.set(null);
    this.info.set(null);

    this.auth.login(this.form.getRawValue()).subscribe({
      next: (response) => {
        const redirectTo =
          this.route.snapshot.queryParamMap.get('redirectTo') ??
          this.auth.resolveLandingRoute(response.user);
        this.router.navigateByUrl(redirectTo);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.errorMessage.set(this.translateError(err));
      },
      complete: () => this.loading.set(false)
    });
  }

  private translateError(err: HttpErrorResponse): string {
    if (err.status === 0) return 'Cannot reach the server. Check your connection.';
    if (err.status === 401) return 'Invalid email or password.';
    if (err.status === 403) return 'Your account does not have access.';
    const serverMessage = (err.error as { message?: string } | null)?.message;
    return serverMessage ?? 'Unexpected error. Please try again.';
  }
}
