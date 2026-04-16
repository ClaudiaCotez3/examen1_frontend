import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

import { CaseFileResponse, PolicyVersionResponse } from '../../../core/models/case-file.model';
import { PolicyResponse } from '../../../core/models/policy.model';
import { CaseFileService } from '../../../core/services/case-file.service';
import { PolicyService } from '../../../core/services/policy.service';

type Status = 'idle' | 'loading-versions' | 'starting' | 'success' | 'error';

@Component({
  selector: 'app-start-process',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './start-process.component.html',
  styleUrl: './start-process.component.scss'
})
export class StartProcessComponent implements OnInit {
  private readonly policyService = inject(PolicyService);
  private readonly caseFileService = inject(CaseFileService);

  readonly policies = signal<PolicyResponse[]>([]);
  readonly versions = signal<PolicyVersionResponse[]>([]);
  readonly selectedPolicyId = signal<string>('');
  readonly selectedVersionId = signal<string>('');
  readonly status = signal<Status>('idle');
  readonly errorMessage = signal<string>('');
  readonly result = signal<CaseFileResponse | null>(null);

  ngOnInit(): void {
    this.policyService.getPolicies().subscribe({
      next: (policies) => this.policies.set(policies),
      error: (err) => this.setError(err, 'Failed to load policies')
    });
  }

  onPolicyChange(policyId: string): void {
    this.selectedPolicyId.set(policyId);
    this.selectedVersionId.set('');
    this.versions.set([]);
    this.result.set(null);
    this.status.set('idle');
    this.errorMessage.set('');

    if (!policyId) {
      return;
    }

    this.status.set('loading-versions');
    this.caseFileService.getPolicyVersions(policyId).subscribe({
      next: (versions) => {
        this.versions.set(versions);
        // Auto-select the active version, if any
        const active = versions.find((v) => v.active);
        if (active) {
          this.selectedVersionId.set(active.id);
        }
        this.status.set('idle');
      },
      error: (err) => this.setError(err, 'Failed to load policy versions')
    });
  }

  onVersionChange(versionId: string): void {
    this.selectedVersionId.set(versionId);
    this.result.set(null);
    this.status.set('idle');
    this.errorMessage.set('');
  }

  startProcess(): void {
    const versionId = this.selectedVersionId();
    if (!versionId) {
      this.errorMessage.set('Please select a policy version first');
      this.status.set('error');
      return;
    }

    this.status.set('starting');
    this.errorMessage.set('');
    this.caseFileService.startProcess(versionId).subscribe({
      next: (caseFile) => {
        this.result.set(caseFile);
        this.status.set('success');
      },
      error: (err) => this.setError(err, 'Failed to start process')
    });
  }

  /** Convenience action: create + activate a new version, then start. */
  quickPublishAndStart(): void {
    const policyId = this.selectedPolicyId();
    if (!policyId) {
      this.errorMessage.set('Please select a policy first');
      this.status.set('error');
      return;
    }

    this.status.set('starting');
    this.errorMessage.set('');
    this.caseFileService.createPolicyVersion(policyId).subscribe({
      next: (newVersion) => {
        this.caseFileService.activatePolicyVersion(newVersion.id).subscribe({
          next: () => {
            this.caseFileService.startProcess(newVersion.id).subscribe({
              next: (caseFile) => {
                this.result.set(caseFile);
                this.status.set('success');
                // Refresh versions list
                this.onPolicyChange(policyId);
              },
              error: (err) => this.setError(err, 'Failed to start process')
            });
          },
          error: (err) => this.setError(err, 'Failed to activate version')
        });
      },
      error: (err) => this.setError(err, 'Failed to create version')
    });
  }

  reset(): void {
    this.selectedPolicyId.set('');
    this.selectedVersionId.set('');
    this.versions.set([]);
    this.result.set(null);
    this.status.set('idle');
    this.errorMessage.set('');
  }

  private setError(err: unknown, fallback: string): void {
    const message =
      (err as { error?: { message?: string } })?.error?.message ??
      (err as { message?: string })?.message ??
      fallback;
    this.errorMessage.set(message);
    this.status.set('error');
  }
}
