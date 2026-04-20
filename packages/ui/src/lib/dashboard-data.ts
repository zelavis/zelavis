import {
  Bot,
  CreditCard,
  Database,
  Fingerprint,
  LayoutDashboard,
  MonitorCog,
  PanelsTopLeft,
  Settings,
  ShieldCheck,
  Store,
} from 'lucide-react'

export const dashboardNavItems = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/auth', label: 'Auth', icon: Fingerprint },
  { to: '/database', label: 'Database', icon: Database },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/builder', label: 'Builder', icon: PanelsTopLeft },
  { to: '/content', label: 'Content', icon: MonitorCog },
  { to: '/commerce', label: 'Commerce', icon: Store },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const

export const serviceRows = [
  {
    name: 'dashboard',
    path: '/zelavis',
    state: 'ready',
    scope: 'core',
  },
  {
    name: 'auth',
    path: '/zelavis/api/v1/auth',
    state: 'ready',
    scope: 'core',
  },
  {
    name: 'database',
    path: '/zelavis/api/v1/database',
    state: 'ready',
    scope: 'core',
  },
  {
    name: 'ecommerce',
    path: 'marketplace package',
    state: 'planned',
    scope: 'official',
  },
] as const

export const activityRows = [
  {
    label: 'Core services mounted',
    detail: 'dashboard, auth, database',
    time: 'now',
  },
  {
    label: 'Document database online',
    detail: 'in-memory development driver',
    time: 'now',
  },
  {
    label: 'Dashboard assets served',
    detail: '/assets/* below the configured root',
    time: 'build',
  },
] as const

export const capabilityCards = [
  {
    title: 'Auth',
    value: '2 providers',
    icon: ShieldCheck,
    detail: 'email and username plugins ready for registration',
  },
  {
    title: 'Database',
    value: 'document + sql',
    icon: Database,
    detail: 'document operations with optional SQL capability',
  },
  {
    title: 'Payments',
    value: 'provider plugins',
    icon: CreditCard,
    detail: 'Stripe and PayPal boundaries are package-level plugins',
  },
] as const
