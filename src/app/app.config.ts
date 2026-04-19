import { APP_INITIALIZER, ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  LucideAngularModule,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Bell,
  Calendar,
  Check,
  CheckCircle,
  ClipboardList,
  Clock,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  Filter,
  Hash,
  History,
  Inbox,
  Info,
  LayoutDashboard,
  LayoutList,
  List,
  Loader,
  LogOut,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Type,
  User,
  Workflow,
  X
} from 'lucide-angular';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { AuthService } from './core/services/auth.service';

/**
 * Rehydrates the AuthService from localStorage before the router runs so
 * guards see a valid session on page reload.
 */
function sessionInitializer(auth: AuthService): () => void {
  return () => auth.restoreSession();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    {
      provide: APP_INITIALIZER,
      useFactory: sessionInitializer,
      deps: [AuthService],
      multi: true
    },
    importProvidersFrom(
      LucideAngularModule.pick({
        AlertCircle,
        AlertTriangle,
        ArrowLeft,
        Bell,
        Calendar,
        Check,
        CheckCircle,
        ClipboardList,
        Clock,
        Download,
        Eye,
        EyeOff,
        FilePlus2,
        FileText,
        Filter,
        Hash,
        History,
        Inbox,
        Info,
        LayoutDashboard,
        LayoutList,
        List,
        Loader,
        LogOut,
        Pencil,
        Play,
        Plus,
        RefreshCw,
        Rocket,
        RotateCcw,
        Save,
        Search,
        Settings,
        ShieldCheck,
        Trash2,
        Type,
        User,
        Workflow,
        X
      })
    )
  ]
};
