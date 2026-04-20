import { Component } from '@angular/core';

/**
 * Placeholder component used by routes whose only purpose is to fire a
 * `canActivate` redirect (the guard always returns a UrlTree, so this view
 * is never actually rendered). Required by Angular 17 because every route
 * must declare a component or a redirectTo.
 */
@Component({
  selector: 'app-empty',
  standalone: true,
  template: ''
})
export class EmptyComponent {}
