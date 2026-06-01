import type * as React from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import { DashboardNotFound } from "#/components/DashboardNotFound";
import { DashboardShell } from "#/components/DashboardShell";
import { DirectionProvider } from "#/components/ui/direction";
import type { Route } from "./+types/root";
import "@glideapps/glide-data-grid/dist/index.css";
import "./styles.css";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;
const DEFAULT_DIRECTION = "ltr";

export function meta() {
  return [{ title: "Zelavis Dashboard" }];
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir={DEFAULT_DIRECTION} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body className="h-svh overflow-hidden font-sans antialiased [overflow-wrap:anywhere] selection:bg-accent">
        <DirectionProvider direction={DEFAULT_DIRECTION}>
          {children}
        </DirectionProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <DashboardShell>
      <Outlet />
    </DashboardShell>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <DashboardShell>
        <DashboardNotFound />
      </DashboardShell>
    );
  }

  const details =
    import.meta.env.DEV && error instanceof Error
      ? error.message
      : "An unexpected dashboard error occurred.";

  return (
    <DashboardShell>
      <section className="mx-auto grid w-full max-w-7xl gap-4">
        <h1 className="text-2xl font-semibold">Dashboard error</h1>
        <p className="text-sm text-muted-foreground">{details}</p>
      </section>
    </DashboardShell>
  );
}
