import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { forkJoin } from 'rxjs';

import {
  BottleneckActivity,
  OperatorPerformance,
  SupervisorOverview,
  SupervisorService
} from '../../../core/services/supervisor.service';
import {
  AnomalyResponse,
  BottleneckInsightResponse,
  InsightsService,
  InsightsSummary,
  OperatorClusterResponse
} from '../../../core/services/insights.service';

type LoadStatus = 'idle' | 'loading' | 'error';

@Component({
  selector: 'app-supervisor-dashboard',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './supervisor-dashboard.component.html',
  styleUrl: './supervisor-dashboard.component.scss'
})
export class SupervisorDashboardComponent implements OnInit {
  private readonly supervisor = inject(SupervisorService);
  private readonly insights = inject(InsightsService);

  // Spring-side deterministic KPIs.
  readonly overview = signal<SupervisorOverview | null>(null);
  readonly bottlenecks = signal<BottleneckActivity[]>([]);
  readonly operators = signal<OperatorPerformance[]>([]);

  // FastAPI-side AI insights.
  readonly aiBottlenecks = signal<BottleneckInsightResponse | null>(null);
  readonly aiOperators = signal<OperatorClusterResponse | null>(null);
  readonly aiAnomalies = signal<AnomalyResponse | null>(null);
  readonly aiSummary = signal<InsightsSummary | null>(null);

  readonly status = signal<LoadStatus>('idle');
  readonly aiStatus = signal<LoadStatus>('idle');
  readonly errorMessage = signal<string>('');

  /** Largest avgServiceMinutes across the bottleneck list, used for the
   *  bar-chart scaling. */
  readonly maxServiceMinutes = computed<number>(() => {
    const max = this.bottlenecks().reduce(
      (acc, b) => Math.max(acc, b.avgServiceMinutes, b.avgWaitMinutes),
      0
    );
    return max > 0 ? max : 1;
  });

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.refreshKpis();
    this.refreshAi();
  }

  private refreshKpis(): void {
    this.status.set('loading');
    this.errorMessage.set('');
    forkJoin({
      overview: this.supervisor.getOverview(),
      bottlenecks: this.supervisor.getBottlenecks(),
      operators: this.supervisor.getOperators()
    }).subscribe({
      next: ({ overview, bottlenecks, operators }) => {
        this.overview.set(overview);
        this.bottlenecks.set(bottlenecks);
        this.operators.set(operators);
        this.status.set('idle');
      },
      error: (err) => {
        this.errorMessage.set(this.messageOf(err, 'No se pudieron cargar las métricas.'));
        this.status.set('error');
      }
    });
  }

  private refreshAi(): void {
    this.aiStatus.set('loading');
    forkJoin({
      bn: this.insights.getBottlenecks(),
      op: this.insights.getOperators(),
      an: this.insights.getAnomalies(),
      su: this.insights.getSummary()
    }).subscribe({
      next: ({ bn, op, an, su }) => {
        this.aiBottlenecks.set(bn);
        this.aiOperators.set(op);
        this.aiAnomalies.set(an);
        this.aiSummary.set(su);
        this.aiStatus.set('idle');
      },
      error: () => {
        // Don't fail the whole dashboard if FastAPI is offline; the
        // deterministic Spring KPIs are still useful on their own.
        this.aiStatus.set('error');
      }
    });
  }

  // ── UI helpers ──────────────────────────────────────────────────────

  formatMinutes(value: number): string {
    if (value < 1) return '< 1 min';
    if (value < 60) return `${Math.round(value)} min`;
    const hours = value / 60;
    if (hours < 24) return `${hours.toFixed(1)} h`;
    return `${(hours / 24).toFixed(1)} d`;
  }

  serviceWidth(value: number): string {
    const max = this.maxServiceMinutes();
    return `${Math.min(100, (value / max) * 100)}%`;
  }

  /** Highlights operators >25% slower than the team median. */
  isOperatorSlow(op: OperatorPerformance): boolean {
    if (!op.teamMedianServiceMinutes) return false;
    return op.avgServiceMinutes > op.teamMedianServiceMinutes * 1.25;
  }

  isOperatorFast(op: OperatorPerformance): boolean {
    if (!op.teamMedianServiceMinutes) return false;
    return op.avgServiceMinutes > 0
        && op.avgServiceMinutes < op.teamMedianServiceMinutes * 0.85;
  }

  clusterClass(cluster: string): string {
    switch (cluster) {
      case 'EFICIENTE': return 'cluster--good';
      case 'LENTO':     return 'cluster--bad';
      default:          return 'cluster--mid';
    }
  }

  severityClass(severity: string): string {
    switch (severity) {
      case 'CRITICAL': return 'severity--critical';
      case 'WARNING':  return 'severity--warning';
      default:         return 'severity--ok';
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
