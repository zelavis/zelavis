import type * as React from 'react'
import type { LucideIcon } from 'lucide-react'

import { Badge } from '#/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { cn } from '#/lib/utils'

interface PageHeaderProps {
  eyebrow: string
  title: string
  description: string
  actions?: React.ReactNode
}

interface StatCardProps {
  label: string
  value: string
  detail: string
  icon: LucideIcon
}

interface EmptyPanelProps {
  title: string
  description: string
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="max-w-3xl">
        <p className="kicker mb-2">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          {description}
        </p>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function StatCard({ label, value, detail, icon: Icon }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardDescription>{label}</CardDescription>
        <span className="rounded-md border bg-muted p-2 text-muted-foreground">
          <Icon className="size-4" />
        </span>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

export function StatusBadge({ state }: { state: string }) {
  const variant =
    state === 'ready' || state === 'embedded' || state === 'endpoint'
      ? 'success'
      : state === 'planned' || state === 'fallback' || state === 'checking'
        ? 'warning'
        : 'outline'

  return <Badge variant={variant}>{state}</Badge>
}

export function DataRow({
  label,
  detail,
  meta,
  className,
}: {
  label: string
  detail: string
  meta?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid gap-3 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]',
        className,
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        <p className="mt-1 truncate text-sm text-muted-foreground">{detail}</p>
      </div>
      {meta ? <div className="flex items-center sm:justify-end">{meta}</div> : null}
    </div>
  )
}

export function EmptyPanel({ title, description }: EmptyPanelProps) {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  )
}

export function ResourceNotice({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/35 px-4 py-3 text-sm">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 text-muted-foreground">{description}</p>
    </div>
  )
}
