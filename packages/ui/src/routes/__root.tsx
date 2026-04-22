import type * as React from "react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { DashboardNotFound } from "#/components/DashboardNotFound";
import { DashboardShell } from "#/components/DashboardShell";
import { DirectionProvider, type Direction } from "#/components/ui/direction";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;
const DEFAULT_DIRECTION: Direction = "ltr";

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): { sidebar?: string } => {
    if (typeof search.sidebar === "string") {
      return { sidebar: search.sidebar };
    }

    return {};
  },
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Zelavis Dashboard",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  component: RootOutlet,
  notFoundComponent: DashboardNotFound,
  shellComponent: RootDocument,
});

function RootOutlet() {
  return <Outlet />;
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir={DEFAULT_DIRECTION} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="h-svh overflow-hidden font-sans antialiased [overflow-wrap:anywhere] selection:bg-accent">
        <DirectionProvider direction={DEFAULT_DIRECTION}>
          <DashboardShell>{children}</DashboardShell>
        </DirectionProvider>
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
