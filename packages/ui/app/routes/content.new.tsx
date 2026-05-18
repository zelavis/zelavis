import { Link, useNavigate } from "react-router";
import { Plus, Save } from "lucide-react";
import { useState } from "react";

import { PageHeader, ResourceNotice } from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { createStarterContentTypeSchema } from "#/lib/content-schema";
import { slugifyContentTypeLabel } from "#/lib/content-studio";
import {
  createDatabaseCollection,
  createDatabaseSchema,
  getDashboardSettings,
  getResolvedDashboardPreferences,
  getRuntimeConfig,
  updateDashboardSettings,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const handle = {
  pageLabel: "Content",
  sidebarTrail: ["Content"],
} as const;

function NewContentTypeRoute() {
  const navigate = useNavigate();
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const settings = useRuntimeResource(
    async () => (config ? getDashboardSettings(config) : undefined),
    [config],
  );
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !name.trim() || saving) {
      return;
    }

    const normalizedLabel = label.trim() || name.trim();
    const normalizedName = slugifyContentTypeLabel(name) || name.trim();

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const collection = await createDatabaseCollection(config, {
        name: normalizedName,
        metadata: {
          surface: "content-studio",
          kind: "content-type",
        },
      });
      await createDatabaseSchema(config, {
        collection: collection.name,
        version: 1,
        activate: true,
        document: createStarterContentTypeSchema(),
        metadata: {
          createdBy: "content-studio",
        },
      });

      if (normalizedLabel !== collection.name) {
        const current = getResolvedDashboardPreferences(settings.data).content;
        await updateDashboardSettings(config, {
          preferences: {
            content: {
              labels: {
                ...(current?.labels ?? {}),
                [collection.name]: normalizedLabel,
              },
            },
          },
        });
        await settings.reload();
      }

      setMessage(`Created ${normalizedLabel} (${collection.name}).`);
      void navigate(`/content/${encodeURIComponent(collection.name)}/edit`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-4xl gap-6">
      <PageHeader
        eyebrow="Content"
        title="New Content Type"
        actions={
          <Link
            to="/content"
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
          >
            Back to Content
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Create content type</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          {message ? <ResourceNotice title="Done" description={message} /> : null}
          {error ? <ResourceNotice title="Action failed" description={error} /> : null}

          <form className="grid gap-3" onSubmit={handleCreate}>
            <Input
              value={label}
              onChange={(event) => {
                const nextLabel = event.target.value;
                setLabel(nextLabel);
                if (!name.trim()) {
                  setName(slugifyContentTypeLabel(nextLabel));
                }
              }}
              placeholder="Articles"
              aria-label="Content type label"
            />
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="articles"
              aria-label="Content type slug"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!name.trim() || saving}>
                <Plus className="size-4" />
                Create and Open Editor
              </Button>
              <Button type="button" variant="outline" disabled={saving} onClick={() => void navigate("/content")}>
                <Save className="size-4" />
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

export default NewContentTypeRoute;
