import { CommonModule } from '@angular/common';
import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-consultation',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './consultation.component.html',
  styleUrl: './consultation.component.scss'
})
export class ConsultationComponent {
  readonly code = signal('');
  readonly result = signal<string | null>(null);

  search(): void {
    const value = this.code().trim();
    this.result.set(value ? `No results for "${value}" yet — backend not connected.` : null);
  }
}
