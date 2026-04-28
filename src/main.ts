import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// crypto.randomUUID is gated to secure contexts (HTTPS / localhost). On plain
// HTTP it is undefined and any caller throws synchronously, killing the
// component that touched it. Polyfill once before bootstrap.
if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID !== 'function') {
  (crypto as any).randomUUID = function randomUUIDPolyfill(): string {
    const bytes = new Uint8Array(16);
    (crypto as Crypto).getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
  };
}

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
