import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import {
  LucideAngularModule,
  AlertCircle,
  Bell,
  Check,
  CheckCircle,
  ClipboardList,
  Clock,
  Download,
  Filter,
  History,
  LayoutDashboard,
  Loader,
  LogOut,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  User,
  Workflow,
  X
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
        Check,
        CheckCircle,
        ClipboardList,
        Clock,
        Download,
        Filter,
        History,
        LayoutDashboard,
        Loader,
        LogOut,
        Play,
        RefreshCw,
        Rocket,
        RotateCcw,
        Save,
        Search,
        Settings,
        ShieldCheck,
        User,
        Workflow,
        X
      })
    )
  ]
};
