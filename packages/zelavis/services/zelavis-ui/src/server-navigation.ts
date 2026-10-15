// The Server menu the dashboard registers through the SDK. Menu semantics belong to @zelavis/ui; edit it here.
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
      "title": "Fabric",
      "path": "/server/fabric",
      "pageLabel": "Fabric",
      "panelLabel": "Fabric",
      "items": [
        {
          "title": "Overview",
          "path": "/server/fabric",
          "pageLabel": "Fabric"
        },
        {
          "title": "Nodes",
          "path": "/server/fabric/nodes",
          "pageLabel": "Fabric"
        },
        {
          "title": "Placements",
          "path": "/server/fabric/placements",
          "pageLabel": "Fabric"
        },
        {
          "title": "Migrations",
          "path": "/server/fabric/migrations",
          "pageLabel": "Fabric"
        },
        {
          "title": "Data",
          "path": "/server/fabric/data",
          "pageLabel": "Fabric",
          "panelLabel": "Data",
          "items": [
            {
              "title": "Overview",
              "path": "/server/fabric/data",
              "pageLabel": "Fabric"
            },
            {
              "title": "Shards",
              "path": "/server/fabric/data/shards",
              "pageLabel": "Fabric"
            },
            {
              "title": "Replicas",
              "path": "/server/fabric/data/replicas",
              "pageLabel": "Fabric"
            },
            {
              "title": "Schema rollouts",
              "path": "/server/fabric/data/schema-rollouts",
              "pageLabel": "Fabric"
            }
          ]
        },
        {
          "title": "Infrastructure",
          "path": "/server/fabric/infrastructure",
          "pageLabel": "Fabric",
          "panelLabel": "Infrastructure",
          "items": [
            {
              "title": "Overview",
              "path": "/server/fabric/infrastructure",
              "pageLabel": "Fabric"
            },
            {
              "title": "Providers",
              "path": "/server/fabric/infrastructure/providers",
              "pageLabel": "Fabric"
            },
            {
              "title": "Autoscaling",
              "path": "/server/fabric/infrastructure/autoscaling",
              "pageLabel": "Fabric"
            }
          ]
        },
        {
          "title": "Balancing",
          "path": "/server/fabric/balancing",
          "pageLabel": "Fabric"
        },
        {
          "title": "Replication",
          "path": "/server/fabric/replication",
          "pageLabel": "Fabric"
        },
        {
          "title": "Backups",
          "path": "/server/fabric/backups",
          "pageLabel": "Fabric"
        },
        {
          "title": "Observability",
          "path": "/server/fabric/observability",
          "pageLabel": "Fabric"
        },
        {
          "title": "Settings",
          "path": "/server/fabric/settings",
          "pageLabel": "Fabric",
          "panelLabel": "Settings",
          "items": [
            {
              "title": "Overview",
              "path": "/server/fabric/settings",
              "pageLabel": "Fabric"
            },
            {
              "title": "Placement policies",
              "path": "/server/fabric/settings/placement-policies",
              "pageLabel": "Fabric"
            },
            {
              "title": "Networking",
              "path": "/server/fabric/settings/networking",
              "pageLabel": "Fabric"
            },
            {
              "title": "Limits and safety",
              "path": "/server/fabric/settings/limits",
              "pageLabel": "Fabric"
            }
          ]
        }
      ]
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
