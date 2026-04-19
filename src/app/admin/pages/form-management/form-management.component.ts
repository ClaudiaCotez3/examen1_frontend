import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import { FormCatalogEntry } from '../../../core/models/form-catalog.model';
import { FormCatalogService } from '../../../core/services/form-catalog.service';

/**
 * Catalog view: lists all reusable forms with create / edit / delete actions.
 *
 * Only authoring lives here. Form *assignment* to BPMN activities happens
 * inside the Policy Designer; runtime *rendering* happens in the Task Monitor.
 * This separation keeps the form lifecycle (define → assign → render) clean.
 */
@Component({
  selector: 'app-form-management',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, LucideAngularModule],
  templateUrl: './form-management.component.html',
  styleUrl: './form-management.component.scss'
})
export class FormManagementComponent {
  private readonly catalog = inject(FormCatalogService);
  private readonly router = inject(Router);

  readonly search = signal<string>('');
  readonly pendingDeleteId = signal<string>('');

  readonly entries = computed<FormCatalogEntry[]>(() => {
    const term = this.search().trim().toLowerCase();
    const all = this.catalog.entries();
    if (!term) return all;
    return all.filter(
      (e) =>
        e.name.toLowerCase().includes(term) ||
        (e.description ?? '').toLowerCase().includes(term)
    );
  });

  goToCreate(): void {
    this.router.navigate(['/forms/create']);
  }

  goToEdit(id: string): void {
    this.router.navigate(['/forms/edit', id]);
  }

  askDelete(entry: FormCatalogEntry): void {
    this.pendingDeleteId.set(entry.id);
  }

  cancelDelete(): void {
    this.pendingDeleteId.set('');
  }

  confirmDelete(entry: FormCatalogEntry): void {
    this.catalog.delete(entry.id).subscribe({
      next: () => this.pendingDeleteId.set(''),
      error: () => this.pendingDeleteId.set('')
    });
  }

  fieldCount(entry: FormCatalogEntry): number {
    return entry.formDefinition?.fields?.length ?? 0;
  }

  formatDate(value: string): string {
    if (!value) return '—';
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : d.toLocaleString();
  }
}
