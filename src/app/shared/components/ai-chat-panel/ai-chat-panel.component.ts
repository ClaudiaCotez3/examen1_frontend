import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { AiChatService } from '../../../core/services/ai-chat.service';
import { LayoutStateService } from '../../../core/services/layout-state.service';

interface ImageDraft {
  dataUrl: string;
  mimeType: string;
  name: string;
  sizeKb: number;
}

/**
 * Browser SpeechRecognition shim. The API ships under two names
 * depending on the vendor (`SpeechRecognition` on the spec track,
 * `webkitSpeechRecognition` on Chromium). We keep the typing loose so
 * we can compile without DOM lib bumps.
 */
type AnySpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

@Component({
  selector: 'app-ai-chat-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './ai-chat-panel.component.html',
  styleUrl: './ai-chat-panel.component.scss'
})
export class AiChatPanelComponent implements AfterViewChecked, OnDestroy {
  private readonly chat = inject(AiChatService);
  private readonly layout = inject(LayoutStateService);

  @ViewChild('messagesEnd') private messagesEnd?: ElementRef<HTMLDivElement>;
  @ViewChild('imageInput') private imageInput?: ElementRef<HTMLInputElement>;

  readonly open = this.layout.aiChatOpen;
  readonly messages = this.chat.messages;
  readonly sending = this.chat.sending;
  readonly errorMessage = this.chat.errorMessage;
  readonly contextLabel = this.chat.contextLabel;

  readonly draft = signal<string>('');
  readonly imageDraft = signal<ImageDraft | null>(null);

  /** True while the browser microphone is actively transcribing. */
  readonly recording = signal<boolean>(false);
  /** Live transcript shown to the user during dictation. Never copied
   *  into the textarea — the audio flow goes straight to send(). */
  readonly voicePreview = signal<string>('');
  /** Surfaced under the textarea when the SpeechRecognition API errors. */
  readonly voiceError = signal<string>('');
  /** Static — true when the browser exposes the SpeechRecognition API. */
  readonly hasSpeechSupport = signal<boolean>(false);

  /** Internal buffer of finalised transcript chunks captured this turn. */
  private finalisedTranscript = '';

  /** Hint shown above the input when the designer isn't mounted, so
   *  the admin understands why operations might not apply. */
  readonly designerActive = computed(() => this.chat.isDesignerActive());

  /** Tracks last message count so we only autoscroll when something
   *  new came in (avoids stealing scroll while the user reads). */
  private lastMessageCount = 0;
  private recognition: AnySpeechRecognition | null = null;

  constructor() {
    this.hasSpeechSupport.set(this.detectSpeechSupport());
  }

  send(): void {
    const text = this.draft().trim();
    const img = this.imageDraft();
    if (!text && !img) return;
    this.chat.send(
      text,
      img ? { dataUrl: img.dataUrl, mimeType: img.mimeType } : null
    );
    this.draft.set('');
    this.imageDraft.set(null);
  }

  /**
   * Click-to-send shortcuts shown when the chat is empty. Each chip
   * fires a complete prompt the assistant can act on without further
   * questions — useful for users who don't know what to type.
   */
  readonly quickPrompts: ReadonlyArray<{ label: string; prompt: string }> = [
    {
      label: 'Proceso de ventas (4 áreas)',
      prompt:
        'Crea un proceso completo de ventas con cuatro áreas: Ventas, Almacén, Finanzas y Logística. Reparte tareas en todas, agrega un rombo para verificar stock con dos ramas (aprobado / rechazado), y cierra el flujo con un único Fin.'
    },
    {
      label: 'Aprobación de gastos',
      prompt:
        'Diseña un flujo de aprobación de gastos con tres áreas: Solicitante, Jefe Inmediato y Finanzas. Incluye un rombo de aprobación con rama APROBADO (que pase a Finanzas) y rama RECHAZADO (que notifique al solicitante).'
    },
    {
      label: 'Onboarding de empleado',
      prompt:
        'Arma un proceso de onboarding de un nuevo empleado con áreas RR.HH., TI y Jefe Directo. RR.HH. crea el contrato, TI prepara accesos y equipo, Jefe Directo presenta al equipo. Termina con una capacitación inicial.'
    },
    {
      label: 'Atención al cliente',
      prompt:
        'Crea un proceso de atención al cliente con tres áreas: Mesa de Ayuda, Soporte Técnico y Servicio al Cliente. Incluye un rombo para clasificar la severidad del ticket (alta / baja) y rutas distintas según la rama.'
    }
  ];

  sendQuickPrompt(prompt: string): void {
    if (this.sending()) return;
    this.chat.send(prompt, null);
  }

  resetConversation(): void {
    this.chat.reset();
  }

  closePanel(): void {
    this.cancelVoice();
    this.layout.closeAiChat();
  }

  formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Voice input ─────────────────────────────────────────────────────
  //
  // The dictation flow is intentionally separate from the textarea: the
  // user clicks 🎤, talks, then explicitly chooses ✓ "Enviar" (sends
  // straight to the chat) or ✕ "Cancelar" (discards). The transcript
  // never lands in the input box — that matches the "voice message"
  // metaphor of WhatsApp / Telegram, which non-technical users already
  // understand.

  startVoice(): void {
    if (this.recording()) return;
    const Ctor = this.getSpeechCtor();
    if (!Ctor) {
      this.voiceError.set(
        'Tu navegador no soporta dictado por voz. Usa Chrome o Edge.'
      );
      return;
    }
    let recognition: AnySpeechRecognition;
    try {
      recognition = new Ctor();
    } catch {
      this.voiceError.set('No se pudo inicializar el reconocimiento de voz.');
      return;
    }
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;

    this.finalisedTranscript = '';
    this.voicePreview.set('');
    this.voiceError.set('');

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = (event.results[i][0]?.transcript ?? '').trim();
        if (event.results[i].isFinal) {
          this.finalisedTranscript +=
            (this.finalisedTranscript ? ' ' : '') + transcript;
        } else {
          interim += (interim ? ' ' : '') + transcript;
        }
      }
      const live = [this.finalisedTranscript, interim]
        .filter((s) => !!s.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      this.voicePreview.set(live);
    };

    recognition.onerror = (event: any) => {
      const code = event?.error ?? 'desconocido';
      const msg =
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Permite el acceso al micrófono para dictar.'
          : code === 'no-speech'
          ? 'No detecté audio. Intenta de nuevo.'
          : `Error de dictado: ${code}`;
      this.voiceError.set(msg);
      this.recording.set(false);
    };

    recognition.onend = () => {
      this.recording.set(false);
      this.recognition = null;
    };

    try {
      recognition.start();
    } catch (err) {
      this.voiceError.set('No se pudo iniciar el dictado.');
      console.warn('[AI chat] SpeechRecognition.start failed', err);
      return;
    }

    this.recognition = recognition;
    this.recording.set(true);
  }

  /**
   * Stop the recognizer, send whatever we captured straight to the
   * chat as a brand-new user turn, and reset the voice UI. Skips the
   * send when nothing intelligible was captured.
   */
  sendVoice(): void {
    const finalText = (
      this.finalisedTranscript ||
      this.voicePreview() ||
      ''
    ).trim();
    this.haltRecognition();
    this.recording.set(false);
    this.voicePreview.set('');
    this.finalisedTranscript = '';

    if (!finalText) {
      this.voiceError.set('No detecté audio. Intenta de nuevo.');
      return;
    }
    this.voiceError.set('');
    const img = this.imageDraft();
    this.chat.send(
      finalText,
      img ? { dataUrl: img.dataUrl, mimeType: img.mimeType } : null
    );
    if (img) this.imageDraft.set(null);
  }

  /** Stop the recognizer and discard whatever we captured this turn. */
  cancelVoice(): void {
    this.haltRecognition();
    this.recording.set(false);
    this.voicePreview.set('');
    this.finalisedTranscript = '';
  }

  private haltRecognition(): void {
    if (!this.recognition) return;
    try {
      this.recognition.stop();
    } catch {
      /* ignore — onend will still fire and clear state */
    }
  }

  private detectSpeechSupport(): boolean {
    return !!this.getSpeechCtor();
  }

  private getSpeechCtor(): { new (): AnySpeechRecognition } | null {
    if (typeof window === 'undefined') return null;
    const w = window as any;
    return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
      | { new (): AnySpeechRecognition }
      | null;
  }

  // ── Image attachment ────────────────────────────────────────────────

  /** 6 MB cap — Anthropic's per-image limit is 5 MB after base64 inflation. */
  private static readonly MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  triggerImagePicker(): void {
    this.imageInput?.nativeElement?.click();
  }

  onImageSelected(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file later
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.voiceError.set('Solo se aceptan imágenes (PNG, JPG, WebP, GIF).');
      return;
    }
    if (file.size > AiChatPanelComponent.MAX_IMAGE_BYTES) {
      this.voiceError.set('La imagen supera los 5 MB. Reduce su tamaño.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.imageDraft.set({
        dataUrl: reader.result as string,
        mimeType: file.type,
        name: file.name,
        sizeKb: Math.round(file.size / 1024)
      });
      this.voiceError.set('');
    };
    reader.onerror = () => {
      this.voiceError.set('No se pudo leer la imagen.');
    };
    reader.readAsDataURL(file);
  }

  clearImageDraft(): void {
    this.imageDraft.set(null);
  }

  ngAfterViewChecked(): void {
    const count = this.messages().length;
    if (count !== this.lastMessageCount) {
      this.lastMessageCount = count;
      // Defer to give Angular a chance to render the new message before
      // we measure the scroll height.
      queueMicrotask(() => {
        this.messagesEnd?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    }
  }

  ngOnDestroy(): void {
    this.cancelVoice();
    try {
      this.recognition?.abort();
    } catch {
      /* no-op */
    }
    this.recognition = null;
  }
}
