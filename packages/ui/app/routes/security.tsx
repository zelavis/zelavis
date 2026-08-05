import { CheckCircle2, KeyRound, LockKeyhole, ShieldCheck, Terminal } from "lucide-react";

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

export const handle = {
  pageLabel: "Security",
  sidebarTrail: ["Security"],
} as const;

const checklistItems = [
  {
    label: "SSH password login",
    detail: "Detect whether password authentication is disabled for the server SSH daemon.",
    status: "planned",
  },
  {
    label: "Firewall baseline",
    detail: "Check that only expected public ports are open, starting with HTTP, HTTPS, and SSH.",
    status: "planned",
  },
  {
    label: "Automatic updates",
    detail: "Verify unattended security updates or an equivalent patch workflow.",
    status: "planned",
  },
  {
    label: "Root login",
    detail: "Warn when direct root SSH login is enabled on Linux hosts.",
    status: "planned",
  },
] as const;

export default function SecurityRoute() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Security"
        title="Checklist"
        description="Guided host and project hardening checks for builders who want a secure VPS without needing to already be Linux experts."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Checklist"
          value="planned"
          detail="Runnable checks will report clear pass, warning, and fix states."
          icon={CheckCircle2}
        />
        <StatCard
          label="Linux hardening"
          value="first"
          detail="SSH, firewall, updates, users, and permissions are the first target."
          icon={Terminal}
        />
        <StatCard
          label="Guidance"
          value="plain"
          detail="Every warning should explain why it matters and how to fix it."
          icon={ShieldCheck}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="size-4" />
            Linux security checklist
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {checklistItems.map((item) => (
            <DataRow
              key={item.label}
              label={item.label}
              detail={item.detail}
              meta={<StatusBadge state={item.status} />}
            />
          ))}
        </CardContent>
      </Card>

      <ResourceNotice
        title="Designed for guided hardening"
        description="The future runner should gather facts locally, avoid making changes without confirmation, and turn each check into a simple recommendation."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Future check groups
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="TLS and domains"
            detail="Certificate health, expiry, redirects, and domain ownership checks."
            meta={<StatusBadge state="planned" />}
          />
          <DataRow
            label="Application secrets"
            detail="Secret presence, file permissions, and accidental public exposure checks."
            meta={<StatusBadge state="planned" />}
          />
        </CardContent>
      </Card>
    </section>
  );
}
