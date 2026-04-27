import { Injectable, signal } from '@angular/core';

/**
 * Shared layout state. The navbar owns the hamburger toggle and the
 * sidebar / layout shell read this signal to collapse or expand. Kept
 * in a tiny service so any standalone component can read or mutate it
 * without prop-drilling.
 *
 * The service auto-closes the sidebar on narrow viewports: at and below
 * the SCSS breakpoint the sidebar becomes a fixed overlay drawer, so we
 * don't want it perpetually covering the content if the user just
 * happens to load the app on a narrow window. The toggle still lets
 * them open it on demand.
 */
@Injectable({ providedIn: 'root' })
export class LayoutStateService {
  /** Must match the @media breakpoint used by the global sidebar SCSS. */
  private static readonly MOBILE_BREAKPOINT_PX = 768;

  readonly sidebarOpen = signal<boolean>(this.shouldStartOpen());

  constructor() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia(
        `(max-width: ${LayoutStateService.MOBILE_BREAKPOINT_PX}px)`
      );
      // Cross-version: addEventListener is the modern API; older Safari
      // exposes addListener instead. Both are no-ops if the runtime
      // doesn't support them.
      const handler = (event: MediaQueryListEvent | MediaQueryList) => {
        if (event.matches) this.closeSidebar();
        else this.openSidebar();
      };
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', handler);
      } else if (typeof (mq as MediaQueryList).addListener === 'function') {
        // Safari < 14 fallback.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mq as any).addListener(handler);
      }
    }
  }

  toggleSidebar(): void {
    this.sidebarOpen.update((v) => !v);
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  openSidebar(): void {
    this.sidebarOpen.set(true);
  }

  private shouldStartOpen(): boolean {
    if (typeof window === 'undefined') return true;
    return window.innerWidth > LayoutStateService.MOBILE_BREAKPOINT_PX;
  }
}
