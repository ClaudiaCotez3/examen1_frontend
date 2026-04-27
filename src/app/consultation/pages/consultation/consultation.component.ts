import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import {
  ConsultationCase,
  ConsultationService
} from '../../../core/services/consultation.service';

type SearchField = 'email' | 'name' | 'ci';
type LoadStatus = 'idle' | 'loading' | 'error';

@Component({
  selector: 'app-consultation',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './consultation.component.html',
  styleUrl: './consultation.component.scss'
})
export class ConsultationComponent {
  private readonly consultation = inject(ConsultationService);

  /** Active search field — drives both the input placeholder and the
   *  query param the request lands on. */
  readonly searchField = signal<SearchField>('email');

  readonly searchTerm = signal<string>('');
  readonly status = signal<LoadStatus>('idle');
  readonly errorMessage = signal<string>('');
  readonly cases = signal<ConsultationCase[]>([]);

  /** When the consultor clicks one card, we expand its timeline below. */
  readonly selectedCaseId = signal<string | null>(null);

  readonly hasResults = computed<boolean>(() => this.cases().length > 0);

  readonly placeholder = computed<string>(() => {
    switch (this.searchField()) {
      case 'name':  return 'Escribe el nombre del cliente…';
      case 'ci':    return 'Escribe la cédula / CI del cliente…';
      default:      return 'Escribe el correo del cliente…';
    }
  });

  setField(field: SearchField): void {
    this.searchField.set(field);
  }

  search(): void {
    const term = this.searchTerm().trim();
    if (!term) {
      this.cases.set([]);
      this.selectedCaseId.set(null);
      this.errorMessage.set('Escribe un valor para buscar.');
      this.status.set('error');
      return;
    }

    const query = { [this.searchField()]: term };
    this.status.set('loading');
    this.errorMessage.set('');
    this.consultation.search(query).subscribe({
      next: (cases) => {
        const list = cases ?? [];
        this.cases.set(list);
        // Single match → auto-expand the timeline so the consultor sees
        // the area progress without an extra click. Multiple matches
        // stay collapsed so they don't dominate the screen.
        this.selectedCaseId.set(list.length === 1 ? list[0].caseId : null);
        this.status.set('idle');
      },
      error: (err) => {
        this.errorMessage.set(this.messageOf(err, 'No se pudo realizar la búsqueda.'));
        this.cases.set([]);
        this.status.set('error');
      }
    });
  }

  selectCase(caseFile: ConsultationCase): void {
    this.selectedCaseId.set(
      this.selectedCaseId() === caseFile.caseId ? null : caseFile.caseId
    );
  }

  isSelected(caseFile: ConsultationCase): boolean {
    return this.selectedCaseId() === caseFile.caseId;
  }

  /** Pretty-prints an ISO timestamp with the user's local locale. */
  formatDate(value: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }

  laneNodeClass(status: string): string {
    switch (status) {
      case 'COMPLETED': return 'lane-node--completed';
      case 'CURRENT':   return 'lane-node--current';
      default:          return 'lane-node--pending';
    }
  }

  stateLabel(state: string): string {
    switch (state) {
      case 'WAITING':     return 'En espera';
      case 'IN_PROGRESS': return 'En proceso';
      case 'BLOCKED':     return 'Bloqueada';
      default:            return state;
    }
  }

  private messageOf(err: unknown, fallback: string): string {
    return (
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback
    );
  }
}
