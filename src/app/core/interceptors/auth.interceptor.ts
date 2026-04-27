import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthService } from '../services/auth.service';

/**
 * Attaches the Bearer token to every API request going to the backend and
 * handles 401s centrally: the stored session is dropped and the user is sent
 * to /login. The login endpoint is excluded so failed logins surface their
 * own error message through the normal error stream.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // The same JWT travels to the AI sidecar (:8001) so the FastAPI
  // service can verify it with the shared HS256 secret.
  const isMainApiCall = req.url.startsWith(environment.apiBaseUrl);
  const isAiCall = req.url.startsWith(environment.aiBaseUrl);
  const isApiCall = isMainApiCall || isAiCall;
  const isLoginCall = req.url.endsWith('/auth/login');
  const token = auth.getToken();

  const authReq = token && isApiCall && !isLoginCall
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      // 401s from the main backend mean the session is dead — boot the
      // user back to /login. 401s from the AI sidecar are harmless
      // (likely misconfigured secret or it isn't running); never log
      // the user out for those, the dashboard already handles the
      // failure gracefully with a "servicio de IA fuera de línea" hint.
      if (error.status === 401 && isMainApiCall && !isLoginCall) {
        auth.clearSession();
        router.navigate(['/login'], { queryParams: { sessionExpired: '1' } });
      }
      return throwError(() => error);
    })
  );
};
