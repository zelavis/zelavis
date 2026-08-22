import { Form, Link, redirect, useNavigation } from "react-router";
import { Database, Plus } from "lucide-react";
import { useState } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { createDatabaseCollection, getActiveRuntimeConfig } from "#/lib/runtime-api";
import { toProjectPath, toProjectPathFromUrl } from "#/lib/routing";
import { cn } from "#/lib/utils";
import type { Route } from "./+types/database.new";

export const handle = {
  pageLabel: "Database",
  sidebarTrail: ["Backend", "Database"],
} as const;

function slugifyTableName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[^a-z_]+/i, "")
    .replace(/^_+/, "_")
    .replace(/_+$/g, "");
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const formData = await request.formData();
  const name = String(formData.get("name") ?? "");
  const normalizedName = slugifyTableName(name) || name.trim();

  if (!normalizedName) {
    return {
      error: "A table name is required.",
    };
  }

  try {
    const config = await getActiveRuntimeConfig(request);
    const table = await createDatabaseCollection(config, {
      name: normalizedName,
      surface: "database",
      metadata: {
        kind: "table",
      },
    });

    return redirect(
      `${toProjectPathFromUrl("/database", request.url)}?databaseTable=${encodeURIComponent(table.name)}`,
    );
  } catch (caught) {
    return {
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

function NewDatabaseTableRoute({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const [name, setName] = useState("");
  const saving = navigation.state !== "idle";
  const error =
    actionData && "error" in actionData && typeof actionData.error === "string"
      ? actionData.error
      : undefined;

  return (
    <section className="mx-auto grid w-full max-w-4xl gap-6">
      <div className="flex justify-end">
        <Link
          to={toProjectPath("/database")}
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back to Database
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create table</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          {error ? <ResourceNotice title="Action failed" description={error} /> : null}

          <Form className="grid gap-3" method="post">
            <Input
              name="name"
              value={name}
              onChange={(event) => setName(slugifyTableName(event.target.value))}
              placeholder="articles"
              aria-label="Table name"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!name.trim() || saving}>
                <Plus className="size-4" />
                Create and Open Table
              </Button>
              <Link
                to={toProjectPath("/database")}
                aria-disabled={saving}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                <Database className="size-4" />
                Cancel
              </Link>
            </div>
          </Form>
        </CardContent>
      </Card>
    </section>
  );
}

export default NewDatabaseTableRoute;
