import { Bot, Boxes } from "lucide-react";
import { Link, useParams } from "react-router";

import {
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { buttonVariants } from "#/components/ui/button";
import { cn } from "#/lib/utils";

export const handle = {
  pageLabel: "Extensions",
  sidebarTrail: ["Extensions"],
} as const;

export default function ExtensionsRoute() {
  const { projectId = "default" } = useParams();

  const extensionSections = [
    {
      title: "Agents",
      path: `/projects/${projectId}/agents`,
      icon: Bot,
      detail: "AI agents, assistants, and automated workflows.",
      active: true,
    },
    {
      title: "Marketplace",
      path: `/projects/${projectId}/marketplace`,
      icon: Boxes,
      detail: "Browse and install plugins and extensions for this project.",
      active: true,
    },
  ] as const;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {extensionSections.map((section) => {
          const Icon = section.icon;
          return (
            <StatCard
              key={section.title}
              label={section.title}
              value={section.active ? "ready" : "planned"}
              detail={section.detail}
              icon={Icon}
            />
          );
        })}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4" />
            Project Extensions & Marketplace
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {extensionSections.map((section) => {
            const Icon = section.icon;
            return (
              <div
                key={section.title}
                className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-md border p-2">
                    <Icon className="size-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      <span>{section.title}</span>
                      <StatusBadge
                        state={section.active ? "ready" : "planned"}
                      />
                    </div>
                    <p className="text-muted-foreground text-sm">
                      {section.detail}
                    </p>
                  </div>
                </div>

                <Link
                  to={section.path}
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "self-start sm:self-auto",
                  )}
                >
                  Open {section.title}
                </Link>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <ResourceNotice
        title="Project Extensions"
        description="Extend this project with official plugins, AI assistants, and domain capabilities installed from the Zelavis marketplace."
      />
    </section>
  );
}
