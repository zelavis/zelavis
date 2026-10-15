// Generated from the current React route manifest by scripts/audit-routes.mjs.
export const workspaceRouteManifest = [
  {
    "file": "routes/projects.index.tsx",
    "index": true
  },
  {
    "file": "routes/login.tsx",
    "path": "login"
  },
  {
    "file": "routes/setup.tsx",
    "path": "setup"
  },
  {
    "file": "routes/logout.tsx",
    "path": "logout"
  },
  {
    "file": "routes/assistant.tsx",
    "path": "assistant"
  },
  {
    "file": "routes/projects.tsx",
    "path": "projects"
  },
  {
    "file": "routes/services.tsx",
    "path": "services"
  },
  {
    "file": "routes/marketplace.tsx",
    "path": "marketplace"
  },
  {
    "file": "routes/server.tsx",
    "children": [
      {
        "file": "routes/resources.tsx",
        "path": "resources"
      },
      {
        "file": "routes/security.tsx",
        "path": "security"
      },
      {
        "file": "routes/server.runtimes.tsx",
        "path": "runtimes"
      },
      {
        "file": "routes/server.domains.tsx",
        "path": "domains"
      },
      {
        "file": "routes/server.access.tsx",
        "path": "access"
      },
      {
        "file": "routes/server.access.users.tsx",
        "path": "access/users"
      },
      {
        "file": "routes/server.access.permissions.tsx",
        "path": "access/permissions"
      },
      {
        "file": "routes/server.backups.tsx",
        "path": "backups"
      },
      {
        "file": "routes/server.logs.tsx",
        "path": "logs"
      },
      {
        "file": "routes/server.terminal.tsx",
        "path": "terminal"
      },
      {
        "file": "routes/server.database.tsx",
        "path": "database"
      },
      {
        "file": "routes/server.fabric.tsx",
        "children": [
          {
            "file": "routes/server.fabric.$fabricSection.tsx",
            "children": [
              {
                "file": "routes/server.fabric.$fabricSection.$fabricDetail.tsx",
                "path": ":fabricDetail"
              }
            ],
            "path": ":fabricSection"
          }
        ],
        "path": "fabric"
      }
    ],
    "path": "server"
  },
  {
    "file": "routes/settings.tsx",
    "children": [
      {
        "file": "routes/settings.appearance.tsx",
        "path": "appearance"
      }
    ],
    "path": "settings"
  },
  {
    "file": "routes/index.tsx",
    "path": "projects/:projectId"
  },
  {
    "file": "routes/backend.tsx",
    "path": "projects/:projectId/backend"
  },
  {
    "file": "routes/extensions.tsx",
    "path": "projects/:projectId/extensions"
  },
  {
    "file": "routes/project.marketplace.tsx",
    "path": "projects/:projectId/marketplace"
  },
  {
    "file": "routes/agents.tsx",
    "path": "projects/:projectId/agents"
  },
  {
    "file": "routes/auth.tsx",
    "path": "projects/:projectId/auth"
  },
  {
    "file": "routes/content.tsx",
    "children": [
      {
        "file": "routes/content.new.tsx",
        "path": "new"
      },
      {
        "file": "routes/content.$contentType.tsx",
        "children": [
          {
            "file": "routes/content.$contentType.index.tsx",
            "index": true
          },
          {
            "file": "routes/content.$contentType.fields.tsx",
            "path": "fields"
          },
          {
            "file": "routes/content.$contentType.$entryId.tsx",
            "path": ":entryId"
          }
        ],
        "path": ":contentType"
      }
    ],
    "path": "projects/:projectId/content"
  },
  {
    "file": "routes/database.tsx",
    "path": "projects/:projectId/database"
  },
  {
    "file": "routes/database.new.tsx",
    "path": "projects/:projectId/database/new"
  },
  {
    "file": "routes/media.tsx",
    "path": "projects/:projectId/media"
  },
  {
    "file": "routes/project.settings.tsx",
    "path": "projects/:projectId/settings"
  },
  {
    "file": "routes/storage.tsx",
    "path": "projects/:projectId/storage"
  },
  {
    "file": "routes/users.tsx",
    "path": "projects/:projectId/users"
  },
  {
    "file": "routes/frontend.tsx",
    "path": "projects/:projectId/frontend"
  },
  {
    "file": "routes/workloads.tsx",
    "path": "projects/:projectId/workloads"
  },
  {
    "file": "routes/workloads.functions.tsx",
    "path": "projects/:projectId/workloads/functions"
  },
  {
    "file": "routes/workloads.jobs.tsx",
    "path": "projects/:projectId/workloads/jobs"
  },
  {
    "file": "routes/workloads.schedules.tsx",
    "path": "projects/:projectId/workloads/schedules"
  },
  {
    "file": "routes/workloads.webhooks.tsx",
    "path": "projects/:projectId/workloads/webhooks"
  },
  {
    "file": "routes/workloads.new.tsx",
    "path": "projects/:projectId/workloads/new"
  },
  {
    "file": "routes/workloads.logs.tsx",
    "path": "projects/:projectId/workloads/logs"
  },
  {
    "file": "routes/workloads.settings.tsx",
    "path": "projects/:projectId/workloads/settings"
  },
  {
    "file": "routes/workloads.$workloadId.tsx",
    "path": "projects/:projectId/workloads/:workloadKind/:workloadId"
  },
  {
    "file": "routes/project.managed.$managedSection.tsx",
    "path": "projects/:projectId/:managedSection"
  },
  {
    "file": "routes/api.relations.$collection.tsx",
    "path": "_api/relations/:collection"
  },
  {
    "file": "routes/$.tsx",
    "path": "*"
  }
] as const;
export const workspaceRouteCatalog = [
  {
    "path": "/",
    "file": "routes/projects.index.tsx",
    "index": true
  },
  {
    "path": "/login",
    "file": "routes/login.tsx",
    "index": false
  },
  {
    "path": "/setup",
    "file": "routes/setup.tsx",
    "index": false
  },
  {
    "path": "/logout",
    "file": "routes/logout.tsx",
    "index": false
  },
  {
    "path": "/assistant",
    "file": "routes/assistant.tsx",
    "index": false
  },
  {
    "path": "/projects",
    "file": "routes/projects.tsx",
    "index": false
  },
  {
    "path": "/services",
    "file": "routes/services.tsx",
    "index": false
  },
  {
    "path": "/marketplace",
    "file": "routes/marketplace.tsx",
    "index": false
  },
  {
    "path": "/server",
    "file": "routes/server.tsx",
    "index": false
  },
  {
    "path": "/server/resources",
    "file": "routes/resources.tsx",
    "index": false
  },
  {
    "path": "/server/security",
    "file": "routes/security.tsx",
    "index": false
  },
  {
    "path": "/server/runtimes",
    "file": "routes/server.runtimes.tsx",
    "index": false
  },
  {
    "path": "/server/domains",
    "file": "routes/server.domains.tsx",
    "index": false
  },
  {
    "path": "/server/access",
    "file": "routes/server.access.tsx",
    "index": false
  },
  {
    "path": "/server/access/users",
    "file": "routes/server.access.users.tsx",
    "index": false
  },
  {
    "path": "/server/access/permissions",
    "file": "routes/server.access.permissions.tsx",
    "index": false
  },
  {
    "path": "/server/backups",
    "file": "routes/server.backups.tsx",
    "index": false
  },
  {
    "path": "/server/logs",
    "file": "routes/server.logs.tsx",
    "index": false
  },
  {
    "path": "/server/terminal",
    "file": "routes/server.terminal.tsx",
    "index": false
  },
  {
    "path": "/server/database",
    "file": "routes/server.database.tsx",
    "index": false
  },
  {
    "path": "/server/fabric",
    "file": "routes/server.fabric.tsx",
    "index": false
  },
  {
    "path": "/server/fabric/:fabricSection",
    "file": "routes/server.fabric.$fabricSection.tsx",
    "index": false
  },
  {
    "path": "/server/fabric/:fabricSection/:fabricDetail",
    "file": "routes/server.fabric.$fabricSection.$fabricDetail.tsx",
    "index": false
  },
  {
    "path": "/settings",
    "file": "routes/settings.tsx",
    "index": false
  },
  {
    "path": "/settings/appearance",
    "file": "routes/settings.appearance.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId",
    "file": "routes/index.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/backend",
    "file": "routes/backend.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/extensions",
    "file": "routes/extensions.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/marketplace",
    "file": "routes/project.marketplace.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/agents",
    "file": "routes/agents.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/auth",
    "file": "routes/auth.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/content",
    "file": "routes/content.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/content/new",
    "file": "routes/content.new.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/content/:contentType",
    "file": "routes/content.$contentType.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/content/:contentType",
    "file": "routes/content.$contentType.index.tsx",
    "index": true
  },
  {
    "path": "/projects/:projectId/content/:contentType/fields",
    "file": "routes/content.$contentType.fields.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/content/:contentType/:entryId",
    "file": "routes/content.$contentType.$entryId.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/database",
    "file": "routes/database.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/database/new",
    "file": "routes/database.new.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/media",
    "file": "routes/media.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/settings",
    "file": "routes/project.settings.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/storage",
    "file": "routes/storage.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/users",
    "file": "routes/users.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/frontend",
    "file": "routes/frontend.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads",
    "file": "routes/workloads.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads/functions",
    "file": "routes/workloads.functions.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads/jobs",
    "file": "routes/workloads.jobs.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads/schedules",
    "file": "routes/workloads.schedules.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads/webhooks",
    "file": "routes/workloads.webhooks.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads/new",
    "file": "routes/workloads.new.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads/logs",
    "file": "routes/workloads.logs.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads/settings",
    "file": "routes/workloads.settings.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/workloads/:workloadKind/:workloadId",
    "file": "routes/workloads.$workloadId.tsx",
    "index": false
  },
  {
    "path": "/projects/:projectId/:managedSection",
    "file": "routes/project.managed.$managedSection.tsx",
    "index": false
  },
  {
    "path": "/_api/relations/:collection",
    "file": "routes/api.relations.$collection.tsx",
    "index": false
  },
  {
    "path": "/*",
    "file": "routes/$.tsx",
    "index": false
  }
] as const;
export const serverNavigationMenu = {
  "title": "Server",
  "path": "/server",
  "pageLabel": "Server",
  "sectionLabel": "Manage",
  "order": 60,
  "surface": "platform",
  "access": {
    "permissions": [
      "server.manage"
    ],
    "scope": {
      "type": "system"
    }
  },
  "items": [
    {
      "title": "Overview",
      "path": "/server",
      "pageLabel": "Server"
    },
    {
      "title": "Deployment backends",
      "path": "/server/runtimes",
      "pageLabel": "Deployment backends",
      "access": {
        "permissions": [
          "server.backends.view"
        ],
        "scope": {
          "type": "system"
        }
      }
    },
    {
      "title": "Resources",
      "path": "/server/resources",
      "pageLabel": "Resources",
      "panelLabel": "Resources",
      "access": {
        "permissions": [
          "server.resources.view"
        ],
        "scope": {
          "type": "system"
        }
      },
      "items": [
        {
          "title": "Overview",
          "path": "/server/resources",
          "pageLabel": "Resources"
        },
        {
          "title": "Processes",
          "path": "/server/resources",
          "search": {
            "resourceView": "processes"
          },
          "pageLabel": "Processes"
        },
        {
          "title": "Storage",
          "path": "/server/resources",
          "search": {
            "resourceView": "storage"
          },
          "pageLabel": "Storage"
        },
        {
          "title": "Limits",
          "path": "/server/resources",
          "search": {
            "resourceView": "limits"
          },
          "pageLabel": "Limits"
        }
      ]
    },
    {
      "title": "Security",
      "path": "/server/security",
      "pageLabel": "Security",
      "panelLabel": "Security",
      "access": {
        "permissions": [
          "server.security.view"
        ],
        "scope": {
          "type": "system"
        }
      },
      "items": [
        {
          "title": "Checklist",
          "path": "/server/security",
          "pageLabel": "Security"
        }
      ]
    },
    {
      "title": "Domains",
      "path": "/server/domains",
      "pageLabel": "Domains",
      "panelLabel": "Domains",
      "access": {
        "permissions": [
          "server.domains.view"
        ],
        "scope": {
          "type": "system"
        }
      },
      "items": [
        {
          "title": "Overview",
          "path": "/server/domains",
          "pageLabel": "Domains"
        },
        {
          "title": "Add Domain",
          "path": "/server/domains",
          "search": {
            "domainAction": "add"
          },
          "pageLabel": "Add Domain"
        },
        {
          "title": "Buy",
          "path": "/server/domains",
          "search": {
            "domainAction": "buy"
          },
          "pageLabel": "Buy Domain"
        },
        {
          "title": "Transfer",
          "path": "/server/domains",
          "search": {
            "domainAction": "transfer"
          },
          "pageLabel": "Transfer Domain"
        }
      ]
    },
    {
      "title": "Access",
      "path": "/server/access",
      "pageLabel": "Access",
      "panelLabel": "Access",
      "access": {
        "permissions": [
          "access.manage"
        ],
        "scope": {
          "type": "system"
        }
      },
      "items": [
        {
          "title": "Overview",
          "path": "/server/access",
          "pageLabel": "Access"
        },
        {
          "title": "Users",
          "path": "/server/access/users",
          "pageLabel": "Users"
        },
        {
          "title": "Permissions",
          "path": "/server/access/permissions",
          "pageLabel": "Permissions"
        }
      ]
    },
    {
      "title": "Database",
      "path": "/server/database",
      "pageLabel": "Platform Database",
      "panelLabel": "Platform Database",
      "access": {
        "permissions": [
          "server.database.inspect"
        ],
        "scope": {
          "type": "system"
        }
      }
    },
    {
      "title": "Backups",
      "path": "/server/backups",
      "pageLabel": "Backups"
    },
    {
      "title": "Logs",
      "path": "/server/logs",
      "pageLabel": "Logs",
      "access": {
        "permissions": [
          "server.logs.read"
        ],
        "scope": {
          "type": "system"
        }
      }
    },
    {
      "title": "Terminal",
      "path": "/server/terminal",
      "pageLabel": "Terminal",
      "access": {
        "permissions": [
          "server.terminal.use"
        ],
        "scope": {
          "type": "system"
        }
      }
    }
  ]
} as const;
