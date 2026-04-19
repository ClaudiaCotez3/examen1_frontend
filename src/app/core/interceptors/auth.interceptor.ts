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

  const isApiCall = req.url.startsWith(environment.apiBaseUrl);
  const isLoginCall = req.url.endsWith('/auth/login');
  const token = auth.getToken();

  const authReq = token && isApiCall && !isLoginCall
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401 && !isLoginCall) {
        auth.clearSession();
        router.navigate(['/login'], { queryParams: { sessionExpired: '1' } });
      }
      return throwError(() => error);
    })
  );
};
