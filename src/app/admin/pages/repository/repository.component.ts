import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';

import {
  ClientCase,
  ClientCases,
  ClientSummary,
  RepositoryOverview
} from '../../../core/models/repository.model';
import { AdminRepositoryService } from '../../../core/services/admin-repository.service';

type ViewMode = 'clients' | 'client-detail';

/**
 * Repositorio Documental (admin) — Opción B.
 *
 * Master–detail sobre la dimensión CLIENTE:
 *   Nivel 1 → lista de clientes con KPIs (trámites, documentos, último
 *             trámite) y buscador por nombre / email / CI.
 *   Nivel 2 → el "file" del cliente: todos sus trámites.
 *   Nivel 3 → "Ver expediente" reutiliza la vista /expediente/:id.
 *
 * Los trámites antiguos sin cliente identificable aparecen agrupados en
 * "Sin identificar" — el admin nunca pierde visibilidad de datos.
 */
@Component({
  selector: 'app-repository',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './repository.component.html',
  styleUrl: './repository.component.scss'
})
export class RepositoryComponent implements OnInit, OnDestroy {
  private readonly repository = inject(AdminRepositoryService);
  private readonly router = inject(Router);

  readonly view = signal<ViewMode>('clients');
  readonly loading = signal<boolean>(true);
  readonly errorMessage = signal<string>('');

  readonly overview = signal<RepositoryOverview | null>(null);
  readonly clientDetail = signal<ClientCases | null>(null);
  readonly detailLoading = signal<boolean>(false);

  readonly searchTerm = signal<string>('');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly clients = computed<ClientSummary[]>(() => this.overview()?.clients ?? []);

  ngOnInit(): void {
    this.loadClients('');
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  // ── Nivel 1: clientes ────────────────────────────────────────────────

  private loadClients(search: string): void {
    this.loading.set(true);
    this.errorMessage.set('');
    this.repository.getClients(search).subscribe({
      next: (data) => {
        this.overview.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.errorMessage.set(this.messageOf(err, 'No se pudo cargar el repositorio.'));
      }
    });
  }

  /** Buscador con debounce — evita un request por tecla. */
  onSearchChange(term: string): void {
    this.searchTerm.set(term);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.loadClients(this.searchTerm());
    }, 300);
  }

  refresh(): void {
    if (this.view() === 'clients') {
      this.loadClients(this.searchTerm());
    } else {
      const id = this.clientDetail()?.client?.id;
      if (id) this.openClient({ id } as ClientSummary);
    }
  }

  // ── Nivel 2: file del cliente ────────────────────────────────────────

  openClient(client: ClientSummary): void {
    this.view.set('client-detail');
    this.detailLoading.set(true);
    this.errorMessage.set('');
    this.repository.getClientCases(client.id).subscribe({
      next: (data) => {
        this.clientDetail.set(data);
        this.detailLoading.set(false);
      },
      error: (err) => {
        this.detailLoading.set(false);
        this.errorMessage.set(this.messageOf(err, 'No se pudo cargar el file del cliente.'));
      }
    });
  }

  backToClients(): void {
    this.view.set('clients');
    this.clientDetail.set(null);
    this.errorMessage.set('');
  }

  // ── Nivel 3: expediente ──────────────────────────────────────────────

  openExpediente(c: ClientCase): void {
    void this.router.navigate(['/expediente', c.id]);
  }

  // ── Render helpers ───────────────────────────────────────────────────

  isUnidentified(client: ClientSummary | null | undefined): boolean {
    return client?.id === 'unidentified';
  }

  statusLabel(status: string): string {
    return status === 'finalizado' || status === 'COMPLETED' ? 'Finalizado' : 'Activo';
  }

  isFinished(status: string): boolean {
    return status === 'finalizado' || status === 'COMPLETED';
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }

  initialsOf(name: string | null | undefined): string {
    const clean = (name ?? '').trim();
    if (!clean) return '?';
    return clean
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join('');
  }

  private messageOf(err: unknown, fallback: string): string {
    return (
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback
    );
  }
}
