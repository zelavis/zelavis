import { Archive, Database, Files, Globe2, KeyRound, MonitorCog, Package, ReceiptText } from "lucide-react";
import { useState } from "react";
import { useLoaderData, useParams, useRouteLoaderData } from "react-router";
import type { ClientLoaderFunctionArgs } from "react-router";

import { DashboardNotFound } from "#/components/DashboardNotFound";
import { ServicePageMount } from "#/components/ServicePageMount";
import { DataRow, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { getActiveRuntimeConfig, getProjectSetup, getProjectSetupReveals, revealProjectSetup, type RuntimeConfig, type RuntimeProjectSetupReveal, type RuntimeProjectSetupValue } from "#/lib/runtime-api";
import { getManagedProject } from "#/lib/routing";
import { projectSiteUrl } from "#/lib/project-site-url";
import type { clientLoader as rootClientLoader } from "../root";

export const handle = {
  pageLabel: "Project",
} as const;

/** The Setup page reads the Project's setup values; every other section needs no data. */
export async function clientLoader({ params, request }: ClientLoaderFunctionArgs) {
  if (params.managedSection !== "setup" || !params.projectId) return { setup: undefined };
  const runtime = await getActiveRuntimeConfig(request);
  // Who revealed the secrets is for those who may reveal them; anyone else simply sees no trail.
  const reveals = await getProjectSetupReveals(runtime, params.projectId).catch(() => [] as readonly RuntimeProjectSetupReveal[]);
  try { return { setup: { runtime, reveals, values: await getProjectSetup(runtime, params.projectId) } }; }
  catch (error) { return { setup: { runtime, reveals, values: [] as readonly RuntimeProjectSetupValue[], error: error instanceof Error ? error.message : "The setup values could not be loaded." } }; }
}

function SetupValues({ projectId, runtime, initial, reveals, error }: { projectId: string; runtime: RuntimeConfig; initial: readonly RuntimeProjectSetupValue[]; reveals: readonly RuntimeProjectSetupReveal[]; error?: string }) {
  const [values, setValues] = useState(initial);
  const [revealed, setRevealed] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(error);
  const hasSecrets = values.some((value) => value.secret);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />Setup</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {values.length === 0 && !refusal ? (
          <DataRow label="No setup values" detail="This application's own installer asks for nothing the Platform generated." />
        ) : values.map((value) => (
          <DataRow
            key={value.id}
            label={value.label}
            detail={value.value ?? "Hidden until revealed"}
            meta={value.secret ? <StatusBadge state={revealed ? "active" : "draft"} /> : undefined}
          />
        ))}
        {refusal ? <ResourceNotice title="Setup values" description={refusal} /> : null}
        {reveals.slice(0, 5).map((entry) => (
          <DataRow key={entry.at + entry.principalId} label={`Revealed by ${entry.principalType}:${entry.principalId}`} detail={`${new Date(entry.at).toLocaleString()} (${entry.revealed.join(", ")})`} />
        ))}
        {hasSecrets && !revealed ? (
          <div className="p-4">
            <Button
              onClick={async () => {
                try { setValues(await revealProjectSetup(runtime, projectId)); setRevealed(true); setRefusal(undefined); }
                catch (failure) { setRefusal(failure instanceof Error ? failure.message : "The secrets could not be revealed."); }
              }}
            >
              Reveal secrets
            </Button>
            <p className="mt-2 text-sm text-muted-foreground">Revealing is recorded in the audit trail and needs the project.setup.reveal permission.</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const managedSections = {
  domains: {
    title: "Domains",
    icon: Globe2,
    detail: "Project hostnames and TLS bindings will be managed here.",
  },
  files: {
    title: "Files",
    icon: Files,
    detail: "A project file manager and deployment file view will live here.",
  },
  "app-database": {
    title: "App database",
    icon: Database,
    detail: "Managed app database access belongs here, separate from Zelavis-native collections.",
  },
  setup: {
    title: "Setup",
    icon: KeyRound,
    detail: "Values the application's own installer asks for.",
  },
  backups: {
    title: "Backups",
    icon: Archive,
    detail: "Project restore points and backup policy overrides will live here.",
  },
  logs: {
    title: "Logs",
    icon: ReceiptText,
    detail: "Application and web server logs for this managed project will live here.",
  },
  updates: {
    title: "Updates",
    icon: Package,
    detail: "Managed app core, theme, plugin, or runtime update controls will live here.",
  },
  admin: {
    title: "App Admin",
    icon: MonitorCog,
    detail: "This opens or proxies the app's own admin area, such as the admin area a recipe declares.",
  },
} as const;

export default function ManagedProjectSectionRoute() {
  const params = useParams();
  const { projects } = useRouteLoaderData<typeof rootClientLoader>("root")!;
  const project = projects.find((candidate) => candidate.id === params.projectId);
  const managed = getManagedProject(project);
  const siteUrl = project ? projectSiteUrl(project) : undefined;

  // Recipe pages share this route pattern with fixed hosting controls.
  // Give every other path to the ordinary SDK service-page renderer.
  const section = managedSections[params.managedSection as keyof typeof managedSections];
  if (!managed || !section) {
    return <ServicePageMount allowPlaceholder fallback={<DashboardNotFound />} />;
  }

  const Icon = section.icon;
  const { setup } = useLoaderData<typeof clientLoader>();
  if (params.managedSection === "setup" && params.projectId && setup) {
    return (
      <section className="mx-auto grid w-full max-w-7xl gap-6">
        <SetupValues projectId={params.projectId} runtime={setup.runtime} initial={setup.values} reveals={setup.reveals} {...("error" in setup && setup.error ? { error: setup.error } : {})} />
      </section>
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon className="size-4" />
            {section.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label={params.projectId ?? "project"}
            detail="Project-specific host controls are scaffolded; provider-backed behavior comes next."
            meta={<StatusBadge state="draft" />}
          />
        </CardContent>
      </Card>

      <ResourceNotice
        title="Managed app boundary"
        description="Hosting controls manage the application itself. When its services use Zelavis APIs, the existing Zelavis sections appear in this project."
      />
      {managed.adminPath && params.managedSection === "admin" && siteUrl ? (
        <Button
          className="w-fit"
          render={<a
            href={`${siteUrl.replace(/\/$/, "")}${managed.adminPath}`}
            target="_blank"
            rel="noreferrer"
          />}
        >
          Open {managed.adminTitle ?? "App Admin"}
        </Button>
      ) : null}
    </section>
  );
}
