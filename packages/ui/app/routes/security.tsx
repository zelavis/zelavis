import {
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import {
  DataRow,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import {
  DashboardSlot,
  DashboardSlotLayout,
} from "#/components/DashboardSlots";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

export const handle = {
  pageLabel: "Security",
  sidebarTrail: ["Security"],
  slots: [
    {
      id: "overview",
      label: "Security overview",
      description: "Security posture, checklist scope, and guidance model.",
    },
    {
      id: "main",
      label: "Linux security checklist",
      description: "Runnable host-hardening checks.",
    },
    {
      id: "detail",
      label: "Future check groups",
      description: "Additional security surfaces planned for the runner.",
    },
  ],
} as const;

const checklistItems = [
  {
    label: "SSH password login",
    detail:
      "Detect whether password authentication is disabled for the server SSH daemon.",
    status: "planned",
  },
  {
    label: "Firewall baseline",
    detail:
      "Check that only expected public ports are open, starting with HTTP, HTTPS, and SSH.",
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
    <DashboardSlotLayout>
      <SecurityOverviewSlot />
      <LinuxSecurityChecklistSlot />
      <SecurityRoadmapSlot />
    </DashboardSlotLayout>
  );
}

export function SecurityOverviewSlot() {
  return (
    <DashboardSlot id="overview" label="Security overview">
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
    </DashboardSlot>
  );
}

export function LinuxSecurityChecklistSlot() {
  return (
    <DashboardSlot id="main" label="Linux security checklist">
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
    </DashboardSlot>
  );
}

export function SecurityRoadmapSlot() {
  return (
    <DashboardSlot id="detail" label="Future check groups">
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
    </DashboardSlot>
  );
}
