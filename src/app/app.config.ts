import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import {
  LucideAngularModule,
  AlertCircle,
  Bell,
  CheckCircle,
  ClipboardList,
  Clock,
  Download,
  LayoutDashboard,
  Loader,
  LogOut,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  User,
  Workflow
} from 'lucide-angular';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(),
    importProvidersFrom(
      LucideAngularModule.pick({
        AlertCircle,
        Bell,
        CheckCircle,
        ClipboardList,
        Clock,
        Download,
        LayoutDashboard,
        Loader,
        LogOut,
        RefreshCw,
        RotateCcw,
        Save,
        Search,
        Settings,
        ShieldCheck,
        User,
        Workflow
      })
    )
  ]
};
