import type { DashboardDefinition } from "./contracts.js";

export function createDefaultDashboardDefinition(): DashboardDefinition {
  return {
    title: "zelavis control",
    subtitle: "Composable admin surfaces for auth, commerce, and future infrastructure packages.",
    views: [
      {
        slug: "",
        title: "Overview",
        description:
          "A shared control plane for a modular zelavis stack, with room for domain packages to contribute their own sections later.",
        badge: "dashboard",
        stats: [
          { label: "Active modules", value: "03", detail: "auth, commerce, dashboard" },
          { label: "HTTP surfaces", value: "12", detail: "Mounted through @zelavis/server" },
          { label: "Pending hooks", value: "07", detail: "Ready for db, queues, storage" },
        ],
        panels: [
          {
            eyebrow: "Auth",
            title: "Identity flows stay modular",
            description:
              "Account, credential, and session capabilities can surface into the dashboard without coupling the core package to any one server runtime.",
            items: [
              "Accounts summary card",
              "Provider health widget",
              "Recent sign-in activity feed",
            ],
          },
          {
            eyebrow: "Commerce",
            title: "Orders and catalog fit the same shell",
            description:
              "Commerce data can be rendered as plain server HTML while still leaving room for richer interactions later.",
            items: [
              "Orders snapshot",
              "Product inventory view",
              "Coupon and pricing actions",
            ],
          },
        ],
      },
      {
        slug: "customers",
        title: "Customers",
        description:
          "A customer-facing operations view for accounts, identities, and account-linked commerce context.",
        badge: "auth + commerce",
        stats: [
          { label: "Total accounts", value: "1,284", detail: "Across all credential providers" },
          { label: "Verified emails", value: "92%", detail: "Healthy baseline for support flows" },
          { label: "Recovery actions", value: "18", detail: "Open support-sensitive items" },
        ],
        panels: [
          {
            eyebrow: "Segments",
            title: "High-value and at-risk cohorts",
            description:
              "The dashboard can group account state and commerce activity without forcing a shared persistence model.",
            items: [
              "Returning customers with active orders",
              "Accounts missing a primary credential",
              "Recently locked or challenged sessions",
            ],
          },
          {
            eyebrow: "Operations",
            title: "Manual interventions",
            description:
              "Support teams typically need low-level actions exposed behind clear extension points rather than app-specific flows.",
            items: [
              "Reset sessions",
              "Inspect credential providers",
              "Link account to customer profile",
            ],
          },
        ],
      },
      {
        slug: "orders",
        title: "Orders",
        description:
          "A commerce operations screen for products, orders, payments, and promotion workflows.",
        badge: "commerce",
        stats: [
          { label: "Open orders", value: "54", detail: "Awaiting payment or fulfillment" },
          { label: "GMV today", value: "$12.4k", detail: "Across all checkout providers" },
          { label: "Failed payments", value: "03", detail: "Requires provider follow-up" },
        ],
        panels: [
          {
            eyebrow: "Pipeline",
            title: "Order lifecycle checkpoints",
            description:
              "This screen is intentionally generic so different apps can map their own fulfillment or payment states onto a consistent shell.",
            items: [
              "Draft to placed",
              "Paid to fulfilled",
              "Refund and dispute handling",
            ],
          },
          {
            eyebrow: "Catalog",
            title: "Product and pricing operations",
            description:
              "Product, price, and coupon management can be rendered from the same route model as the rest of the control plane.",
            items: [
              "Product status summary",
              "Coupon usage leaderboard",
              "Inventory alert queue",
            ],
          },
        ],
      },
      {
        slug: "system",
        title: "System",
        description:
          "A runtime and platform view for server integrations, adapters, and future infrastructure packages such as db or queues.",
        badge: "server",
        stats: [
          { label: "Mounted routes", value: "24", detail: "Resolved by the server integration" },
          { label: "Runtime adapters", value: "02", detail: "Express and Hono available" },
          { label: "Extensible slots", value: "09", detail: "Ready for custom dashboards" },
        ],
        panels: [
          {
            eyebrow: "Runtime",
            title: "Transport stays replaceable",
            description:
              "The dashboard should not own the server. It should be mountable anywhere the zelavis server contract is implemented.",
            items: [
              "Route registry insight",
              "Adapter compatibility notes",
              "Operational health checks",
            ],
          },
          {
            eyebrow: "Future packages",
            title: "Room for db and infrastructure surfaces",
            description:
              "The shell leaves clear space for future modules to register their own screens without changing the base package model.",
            items: [
              "Database explorer placeholder",
              "Queue and job metrics",
              "Storage and cache panels",
            ],
          },
        ],
      },
    ],
  };
}
