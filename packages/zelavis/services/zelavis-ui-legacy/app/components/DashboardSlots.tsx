import type * as React from "react";

import { cn } from "#/lib/utils";

export type DashboardSlotId =
  | "overview"
  | "main"
  | "detail"
  | "create"
  | "edit"
  | "inspect"
  | "settings";

export type DashboardSlotDefinition = {
  id: DashboardSlotId;
  label: string;
  description?: string;
};

export function DashboardSlotLayout({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      data-dashboard-slot-layout=""
      className={cn("mx-auto grid w-full max-w-7xl gap-6", className)}
    >
      {children}
    </section>
  );
}

export function DashboardSlot({
  id,
  label,
  children,
  className,
}: {
  id: DashboardSlotId;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const headingId = `dashboard-slot-${id}`;

  return (
    <section
      aria-labelledby={headingId}
      data-dashboard-slot={id}
      className={cn("grid min-w-0 gap-6", className)}
    >
      <h2 id={headingId} className="sr-only">
        {label}
      </h2>
      {children}
    </section>
  );
}
