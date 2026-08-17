import type { Route } from "./+types/api.assistant";

type AssistantAction = {
  label: string;
  to: string;
};

type AssistantResponse = {
  actions?: AssistantAction[];
  message: string;
};

const projectKinds = ["zelavis", "wordpress", "static", "generic"] as const;

type ProjectKind = (typeof projectKinds)[number];

export async function clientAction({
  request,
}: Route.ClientActionArgs): Promise<AssistantResponse> {
  const formData = await request.formData();
  const prompt = String(formData.get("prompt") ?? "").trim();

  return answerAssistantPrompt(prompt);
}

function answerAssistantPrompt(prompt: string): AssistantResponse {
  const lower = prompt.toLowerCase();

  if (!prompt) {
    return {
      message: "Ask me what you want to build, inspect, or open in Zelavis.",
    };
  }

  if (mentionsProjectCreation(lower)) {
    const kind = inferProjectKind(lower);
    const name = inferProjectName(prompt);
    const domain = inferDomain(prompt);
    const search = new URLSearchParams({
      new: "1",
      type: kind,
    });

    if (name) {
      search.set("name", name);
    }

    if (domain) {
      search.set("domain", domain);
    }

    const to = `/projects?${search.toString()}`;

    return {
      message: [
        `I can open the project creation flow${name ? ` for ${name}` : ""}.`,
        "Project persistence is still owned by the Projects screen right now, so review the form and press Create there.",
      ].join(" "),
      actions: [
        {
          label: "Create project",
          to,
        },
      ],
    };
  }

  if (lower.includes("security") || lower.includes("checklist")) {
    return {
      message: "The security checklist is available from the global Security area.",
      actions: [{ label: "Open Security", to: "/security" }],
    };
  }

  if (
    lower.includes("resource") ||
    lower.includes("usage") ||
    lower.includes("metrics")
  ) {
    return {
      message: "Resource charts and host usage live in Resources.",
      actions: [{ label: "Open Resources", to: "/resources" }],
    };
  }

  if (lower.includes("log")) {
    return {
      message: "Server logs are available from the global Server logs view.",
      actions: [{ label: "Open Logs", to: "/server/logs" }],
    };
  }

  if (lower.includes("domain")) {
    return {
      message: "Domain management is a global server-level area in Zelavis.",
      actions: [{ label: "Open Domains", to: "/server/domains" }],
    };
  }

  if (lower.includes("marketplace") || lower.includes("plugin")) {
    return {
      message:
        "The global Marketplace is for apps, starters, templates, and server provider plugins.",
      actions: [{ label: "Open Marketplace", to: "/marketplace" }],
    };
  }

  if (lower.includes("database") || lower.includes("table")) {
    return {
      message: "Open the default project database to inspect tables and rows.",
      actions: [{ label: "Open Database", to: "/projects/default/database" }],
    };
  }

  if (lower.includes("content") || lower.includes("schema")) {
    return {
      message: "Content types, schemas, and entries live in Content.",
      actions: [{ label: "Open Content", to: "/projects/default/content" }],
    };
  }

  return {
    message:
      "I can help with project creation, security, resources, logs, domains, marketplace, database, and content areas that already exist in the dashboard.",
  };
}

function mentionsProjectCreation(lower: string) {
  return (
    lower.includes("create project") ||
    lower.includes("new project") ||
    lower.includes("create app") ||
    lower.includes("new app") ||
    lower.includes("create website") ||
    lower.includes("new website")
  );
}

function inferProjectKind(lower: string): ProjectKind {
  if (lower.includes("wordpress")) {
    return "wordpress";
  }

  if (lower.includes("static")) {
    return "static";
  }

  if (lower.includes("generic")) {
    return "generic";
  }

  return "zelavis";
}

function inferProjectName(prompt: string) {
  const match = prompt.match(/\b(?:called|named|name)\s+["']?([^"',.]+)["']?/i);
  return match?.[1]?.trim();
}

function inferDomain(prompt: string) {
  const match = prompt.match(/\b(?:domain|at|on)\s+([a-z0-9.-]+\.[a-z]{2,})\b/i);
  return match?.[1]?.trim();
}
