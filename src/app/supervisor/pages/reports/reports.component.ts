import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { ReportsService, SmartReport } from '../../../core/services/reports.service';

interface ChartBar {
  label: string;
  value: number;
  /** 0–100, relative to the max value of the series. */
  percent: number;
}

/**
 * Módulo 4 — Reportes Inteligentes (supervisor).
 *
 * El supervisor escribe una consulta en lenguaje natural ("¿qué área
 * acumula más demoras?", "ranking de operadores por tareas completadas")
 * y recibe un reporte estructurado: resumen ejecutivo, tabla, gráfico e
 * insights accionables.
 *
 * La IA NO consulta la base directamente: el sidecar FastAPI computa un
 * dataset agregado determinista desde Mongo y el modelo solo selecciona,
 * combina y narra esas cifras (salida 100% estructurada vía tool-use).
 */
@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './reports.component.html',
  styleUrl: './reports.component.scss'
})
export class ReportsComponent implements OnInit, OnDestroy {
  private readonly reportsService = inject(ReportsService);

  readonly question = signal<string>('');
  readonly loading = signal<boolean>(false);
  readonly errorMessage = signal<string>('');

  // ── Dictado por voz ────────────────────────────────────────────────
  // El supervisor puede preguntar hablando: toca el micrófono, dicta la
  // consulta (transcripción en vivo dentro del input) y al tocar de
  // nuevo se envía automáticamente. Web Speech API (Chrome/Edge), es-ES.
  readonly voiceState = signal<'idle' | 'listening'>('idle');
  readonly hasSpeechSupport = signal<boolean>(false);
  private speechRecognition: any | null = null;
  private speechTranscript = '';

  /** Último reporte + historial de la sesión (más reciente primero). */
  readonly report = signal<SmartReport | null>(null);
  readonly history = signal<Array<{ question: string; report: SmartReport }>>([]);

  /** Sugerencias de arranque — cubren trámites, áreas, tiempos y rendimiento. */
  readonly suggestions = [
    '¿Qué área acumula más demoras?',
    'Ranking de operadores por tareas completadas',
    '¿Cuántos trámites se iniciaron y finalizaron por mes?',
    '¿Qué proceso tiene más trámites activos?',
    '¿Qué actividades tienen mayor backlog ahora mismo?',
    '¿Qué clientes tienen más trámites?'
  ];

  /** Barras normalizadas del gráfico sugerido (render CSS, sin librerías). */
  readonly chartBars = computed<ChartBar[]>(() => {
    const chart = this.report()?.chart;
    if (!chart || !chart.labels?.length || !chart.values?.length) return [];
    const max = Math.max(...chart.values.map((v) => Math.abs(v)), 1);
    return chart.labels.map((label, i) => {
      const value = chart.values[i] ?? 0;
      return { label, value, percent: Math.round((Math.abs(value) / max) * 100) };
    });
  });

  ngOnInit(): void {
    this.hasSpeechSupport.set(!!this.getSpeechCtor());
  }

  ngOnDestroy(): void {
    this.abortRecognition();
  }

  // ── Dictado por voz ────────────────────────────────────────────────

  /**
   * Un solo botón: toca para empezar a dictar (la transcripción aparece
   * en vivo en el input), toca de nuevo para detener y ENVIAR la consulta.
   */
  toggleVoice(): void {
    if (this.loading()) return;
    if (this.voiceState() === 'listening') {
      this.stopRecognitionAndAsk();
      return;
    }
    this.startRecognition();
  }

  private startRecognition(): void {
    const Ctor = this.getSpeechCtor();
    if (!Ctor) {
      this.errorMessage.set('Tu navegador no soporta dictado por voz (usa Chrome o Edge).');
      return;
    }
    let recognition: any;
    try {
      recognition = new Ctor();
    } catch {
      this.errorMessage.set('No se pudo inicializar el micrófono.');
      return;
    }
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;

    this.speechTranscript = '';
    this.errorMessage.set('');

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = (event.results[i][0]?.transcript ?? '').trim();
        if (event.results[i].isFinal && transcript) {
          this.speechTranscript += (this.speechTranscript ? ' ' : '') + transcript;
        } else if (transcript) {
          interim += (interim ? ' ' : '') + transcript;
        }
      }
      // Transcripción en vivo dentro del input para feedback inmediato.
      const live = [this.speechTranscript, interim].filter(Boolean).join(' ');
      if (live) this.question.set(live);
    };

    recognition.onerror = (event: any) => {
      const code = event?.error ?? 'desconocido';
      this.voiceState.set('idle');
      this.speechRecognition = null;
      this.errorMessage.set(
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Permite el acceso al micrófono para dictar la consulta.'
          : code === 'no-speech'
          ? 'No detecté audio. Intenta de nuevo.'
          : `Error de dictado: ${code}`
      );
    };

    recognition.onend = () => {
      if (this.voiceState() === 'listening') this.voiceState.set('idle');
      this.speechRecognition = null;
    };

    try {
      recognition.start();
    } catch {
      this.errorMessage.set('No se pudo iniciar el dictado.');
      return;
    }
    this.speechRecognition = recognition;
    this.voiceState.set('listening');
  }

  private stopRecognitionAndAsk(): void {
    const rec = this.speechRecognition;
    this.voiceState.set('idle');
    try {
      rec?.stop();
    } catch {
      /* ignore */
    }
    // Pequeña espera para que el reconocedor descargue el resultado final.
    setTimeout(() => {
      const transcript = (this.speechTranscript || this.question()).trim();
      this.speechTranscript = '';
      if (!transcript) {
        this.errorMessage.set('No detecté audio. Intenta de nuevo.');
        return;
      }
      this.question.set(transcript);
      this.ask(transcript);
    }, 300);
  }

  private abortRecognition(): void {
    const rec = this.speechRecognition;
    this.speechRecognition = null;
    this.speechTranscript = '';
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    if (this.voiceState() !== 'idle') this.voiceState.set('idle');
  }

  private getSpeechCtor(): { new (): any } | null {
    if (typeof window === 'undefined') return null;
    const w = window as any;
    return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
      | { new (): any }
      | null;
  }

  ask(text?: string): void {
    const q = (text ?? this.question()).trim();
    if (!q || this.loading()) return;
    this.question.set(q);
    this.loading.set(true);
    this.errorMessage.set('');

    this.reportsService.ask(q).subscribe({
      next: (report) => {
        this.loading.set(false);
        this.report.set(report);
        this.history.update((h) => [{ question: q, report }, ...h].slice(0, 10));
      },
      error: (err) => {
        this.loading.set(false);
        this.errorMessage.set(
          (err as { error?: { detail?: string } })?.error?.detail ??
          'No se pudo generar el reporte. Verifica que el servicio de IA esté en línea.'
        );
      }
    });
  }

  showFromHistory(entry: { question: string; report: SmartReport }): void {
    this.question.set(entry.question);
    this.report.set(entry.report);
  }

  chartTypeLabel(): string {
    switch (this.report()?.chart?.type) {
      case 'line': return 'Evolución';
      case 'pie': return 'Distribución';
      default: return 'Comparación';
    }
  }

  /** Exporta el reporte actual a CSV (tabla) para llevarlo a Excel. */
  exportCsv(): void {
    const r = this.report();
    if (!r || r.columns.length === 0) return;
    const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [
      r.columns.map(escape).join(';'),
      ...r.rows.map((row) => row.map(escape).join(';'))
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${r.title.replace(/\s+/g, '_').toLowerCase() || 'reporte'}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
