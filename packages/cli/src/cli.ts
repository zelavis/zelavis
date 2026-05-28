import { cancel, intro, isCancel, log, outro, select, spinner } from "@clack/prompts";
import { bootstrapNextjs, type NextjsRouter } from "./nextjs.js";
import { bootstrapReactRouter, type BootstrapAdapter } from "./react-router.js";

interface ParsedArgs {
  command?: string;
  target?: string;
  adapter?: BootstrapAdapter;
  router?: NextjsRouter;
  cwd?: string;
  yes: boolean;
  help: boolean;
}

const ADAPTERS: readonly BootstrapAdapter[] = [
  "node",
  "bun",
  "cloudflare",
  "vercel",
  "netlify",
];
const NEXTJS_ADAPTERS: readonly BootstrapAdapter[] = [
  "vercel",
  "node",
  "netlify",
  "bun",
];

function isAdapter(value: string | undefined): value is BootstrapAdapter {
  return ADAPTERS.includes(value as BootstrapAdapter);
}

function printHelp() {
  console.log(`Zelavis CLI

Usage:
  zelavis bootstrap react-router [--adapter <adapter>] [--yes] [--cwd <path>]
  zelavis bootstrap nextjs [--router app|pages] [--adapter <adapter>] [--yes] [--cwd <path>]

Commands:
  bootstrap react-router   Add a Zelavis catch-all endpoint to a React Router 7 app.
  bootstrap nextjs         Add a Zelavis catch-all endpoint to a Next.js app.

Options:
  --adapter <adapter>      node, bun, cloudflare, vercel, or netlify.
  --router <router>        Next.js router target: app or pages.
  --yes, -y               Use defaults and skip prompts.
  --cwd <path>            Project directory. Defaults to the current directory.
  --help, -h              Show this help message.
`);
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { yes: false, help: false };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
      continue;
    }

    if (arg === "--adapter") {
      const value = args[index + 1];
      if (!isAdapter(value)) {
        throw new Error(
          `Unsupported adapter "${value ?? ""}". Expected one of: ${ADAPTERS.join(", ")}.`,
        );
      }
      parsed.adapter = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--adapter=")) {
      const value = arg.slice("--adapter=".length);
      if (!isAdapter(value)) {
        throw new Error(
          `Unsupported adapter "${value}". Expected one of: ${ADAPTERS.join(", ")}.`,
        );
      }
      parsed.adapter = value;
      continue;
    }

    if (arg === "--cwd") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--cwd requires a path.");
      }
      parsed.cwd = value;
      index += 1;
      continue;
    }

    if (arg === "--router") {
      const value = args[index + 1];
      if (value !== "app" && value !== "pages") {
        throw new Error(
          `Unsupported router "${value ?? ""}". Expected "app" or "pages".`,
        );
      }
      parsed.router = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--router=")) {
      const value = arg.slice("--router=".length);
      if (value !== "app" && value !== "pages") {
        throw new Error(
          `Unsupported router "${value}". Expected "app" or "pages".`,
        );
      }
      parsed.router = value;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      parsed.cwd = arg.slice("--cwd=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    }

    positional.push(arg);
  }

  parsed.command = positional[0];
  parsed.target = positional[1];
  return parsed;
}

async function promptAdapter(
  framework: "React Router" | "Next.js",
  defaultAdapter: BootstrapAdapter,
  adapters: readonly BootstrapAdapter[] = ADAPTERS,
): Promise<BootstrapAdapter> {
  const allOptions = [
    {
      value: "node",
      label: "Node.js",
      hint: "Local Node server or Node-based host",
    },
    {
      value: "bun",
      label: "Bun",
      hint: "Bun runtime with local SQLite defaults",
    },
    {
      value: "cloudflare",
      label: "Cloudflare",
      hint: "Workers with D1/KV/R2 bindings",
    },
    {
      value: "vercel",
      label: "Vercel",
      hint: "Vercel functions and optional Blob storage",
    },
    {
      value: "netlify",
      label: "Netlify",
      hint: "Netlify functions and optional Blobs",
    },
  ] satisfies Array<{
    value: BootstrapAdapter;
    label: string;
    hint: string;
  }>;

  const value = await select({
    message: `Where will this ${framework} app run?`,
    initialValue: defaultAdapter,
    options: allOptions.filter((option) => adapters.includes(option.value)),
  });

  if (isCancel(value)) {
    cancel("Bootstrap cancelled.");
    process.exitCode = 1;
    return defaultAdapter;
  }

  return value;
}

async function promptNextjsRouter(defaultRouter: NextjsRouter): Promise<NextjsRouter> {
  const value = await select({
    message: "Which Next.js router should Zelavis use?",
    initialValue: defaultRouter,
    options: [
      {
        value: "app",
        label: "App Router",
        hint: "app/zelavis/[[...path]]/route.ts",
      },
      {
        value: "pages",
        label: "Pages Router",
        hint: "pages/api/zelavis/[[...path]].ts plus rewrite",
      },
    ] satisfies Array<{
      value: NextjsRouter;
      label: string;
      hint: string;
    }>,
  });

  if (isCancel(value)) {
    cancel("Bootstrap cancelled.");
    process.exitCode = 1;
    return defaultRouter;
  }

  return value;
}

export async function runCli(args: readonly string[] = process.argv.slice(2)) {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (parsed.help || !parsed.command) {
    printHelp();
    return;
  }

  if (
    parsed.command !== "bootstrap" ||
    (parsed.target !== "react-router" && parsed.target !== "nextjs")
  ) {
    console.error(`Unknown command "${[parsed.command, parsed.target].filter(Boolean).join(" ")}".`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  intro("Zelavis bootstrap");

  const router = parsed.target === "nextjs"
    ? parsed.router ?? (parsed.yes ? "app" : await promptNextjsRouter("app"))
    : undefined;
  const defaultAdapter = parsed.target === "nextjs" && router === "app" ? "vercel" : "node";
  const supportedAdapters = parsed.target === "nextjs" ? NEXTJS_ADAPTERS : ADAPTERS;
  if (parsed.adapter && !supportedAdapters.includes(parsed.adapter)) {
    console.error(
      `${parsed.adapter} bootstrap is not available for ${parsed.target}. Supported adapters: ${supportedAdapters.join(", ")}.`,
    );
    process.exitCode = 1;
    return;
  }
  const adapter = parsed.adapter ??
    (parsed.yes
      ? defaultAdapter
      : await promptAdapter(
          parsed.target === "nextjs" ? "Next.js" : "React Router",
          defaultAdapter,
          supportedAdapters,
        ));
  const task = spinner();
  task.start(`Creating ${parsed.target === "nextjs" ? "Next.js" : "React Router"} endpoint`);

  try {
    const result = parsed.target === "nextjs"
      ? await bootstrapNextjs({
          cwd: parsed.cwd ?? process.cwd(),
          adapter,
          router: router ?? "app",
        })
      : await bootstrapReactRouter({
          cwd: parsed.cwd ?? process.cwd(),
          adapter,
        });

    task.stop(`${parsed.target === "nextjs" ? "Next.js" : "React Router"} endpoint ready`);

    for (const action of result.actions) {
      const label = action.status === "created"
        ? "created"
        : action.status === "updated"
          ? "updated"
          : "skipped";
      log.info(`${label}: ${action.path}`);
    }

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        log.warn(warning);
      }
    }

    outro(`Zelavis is mounted at ${result.mountPath}.`);
  } catch (error) {
    task.stop("Bootstrap failed");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
