import { SquareTerminal } from "lucide-react";
import { useCallback, useState } from "react";
import { useLoaderData, useNavigate, useRevalidator } from "react-router";

import { ResourceNotice } from "#/components/DashboardPage";
import { TerminalView } from "#/components/terminal/TerminalView";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { closeTerminalSession, getActiveRuntimeConfig, getTerminalOverview, installTerminalPackages, openTerminalSession } from "#/lib/runtime-api";
import type { Route } from "./+types/server.terminal";

export const handle = {
  pageLabel: "Terminal",
  sidebarTrail: ["Server"],
} as const;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const overview = await getTerminalOverview(runtime);
  const requested = new URL(request.url).searchParams.get("session") ?? "";
  // The session in the URL wins when it still exists; otherwise the newest one is picked up again.
  const selected = overview.sessions.find((session) => session.id === requested) ?? overview.sessions.at(-1);
  return { runtime, overview, selected: selected?.id };
}

export default function ServerTerminalRoute() {
  const { runtime, overview, selected } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const session = await openTerminalSession(runtime, { cols: 100, rows: 30 });
      navigate(`/server/terminal?session=${session.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await installTerminalPackages(runtime);
      revalidator.revalidate();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const close = async (id: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await closeTerminalSession(runtime, id);
      navigate("/server/terminal");
      revalidator.revalidate();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const ended = useCallback((reason: string) => {
    setError(reason);
    revalidator.revalidate();
  }, [revalidator]);

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-4">
      <ResourceNotice
        title="Terminal"
        description="A shell on this server, as the account the Platform runs as (not root), inside tmux: closing this page leaves it running and the next visit picks it up again. Opening and closing sessions is written to the Platform log; what you type is not recorded."
      />
      {!overview.available ? (
        <Card>
          <CardContent className="p-4 text-sm">
            <p className="font-medium">The terminal is not available on this server.</p>
            <p className="text-muted-foreground">{overview.reason}</p>
            {error ? <p className="mt-2 text-destructive" role="alert">{error}</p> : null}
            <Button className="mt-3" onClick={() => void install()} disabled={busy}>Install tmux</Button>
            <p className="mt-2 text-xs text-muted-foreground">Installs the tmux package through the audited host package operation; it needs the server.packages.install permission.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <SquareTerminal className="size-4" />
              {overview.sessions.length === 0 ? "No open sessions" : `${overview.sessions.length} of ${overview.maxSessions} sessions`}
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              {overview.sessions.map((session, index) => (
                <Button key={session.id} variant={session.id === selected ? "default" : "outline"} onClick={() => navigate(`/server/terminal?session=${session.id}`)}>
                  Session {index + 1}
                </Button>
              ))}
              <Button variant="outline" onClick={() => void open()} disabled={busy}>New terminal</Button>
              {selected ? <Button variant="outline" onClick={() => void close(selected)} disabled={busy}>Close this session</Button> : null}
            </div>
          </CardHeader>
          <CardContent>
            {error ? <p className="mb-2 text-sm text-destructive" role="alert">{error}</p> : null}
            {selected ? <TerminalView key={selected} runtime={runtime} sessionId={selected} onEnded={ended} /> : (
              <p className="text-sm text-muted-foreground">Open a terminal to get a shell. It keeps running if you leave.</p>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
