/* ═══════════════════════════════════════════════════════
   YABBY — Connector Catalog
   ═══════════════════════════════════════════════════════
   Static registry of available connectors with metadata,
   auth requirements, setup guidance, and backend configs.
   All MCP package names verified on npm.
*/

export const CONNECTOR_CATALOG = [
  // ═══════════════════════════════════════
  // ── Development ──
  // ═══════════════════════════════════════
  {
    id: "github",
    name: "GitHub",
    icon: "\u{1F419}",
    category: "dev",
    comingSoon: false,
    description: "Repos, issues, pull requests, code search",
    backends: ["builtin", "mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "GITHUB_TOKEN", label: "Personal Access Token", type: "password", placeholder: "ghp_..." },
      ],
    },
    helpUrl: "https://github.com/settings/tokens?type=beta",
    helpSteps: [
      "Open github.com/settings/tokens",
      "Click 'Generate new token' (Fine-grained)",
      "Select the target repositories",
      "Permissions: Issues, Pull requests, Contents (Read/Write)",
      "Generate and copy the token (ghp_...)",
    ],
    testDescription: "Verifies the token via the GitHub API (/user)",
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{GITHUB_TOKEN}}" },
    },
    builtin: {
      module: "./builtin/github.js",
      baseUrl: "https://api.github.com",
    },
  },
  {
    id: "linear",
    name: "Linear",
    icon: "\u{1F4D0}",
    category: "dev",
    comingSoon: false,
    description: "Issues, projects, cycles, teams",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "LINEAR_API_KEY", label: "API Key", type: "password", placeholder: "lin_api_..." },
      ],
    },
    helpUrl: "https://linear.app/settings/api",
    helpSteps: [
      "Open linear.app/settings/api",
      "Under 'Personal API keys', click 'Create key'",
      "Copy the key (lin_api_...)",
    ],
    testDescription: "Verifies the key via the Linear GraphQL API",
    mcp: {
      command: "npx",
      args: ["-y", "@tacticlaunch/mcp-linear"],
      env: { LINEAR_API_TOKEN: "{{LINEAR_API_KEY}}" },
    },
    builtin: null,
  },
  {
    id: "sentry",
    name: "Sentry",
    icon: "\u{1F41B}",
    category: "dev",
    comingSoon: false,
    description: "Errors, alerts, application monitoring",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "SENTRY_AUTH_TOKEN", label: "Auth Token", type: "password", placeholder: "sntrys_..." },
        { key: "SENTRY_ORG", label: "Organization", type: "text", placeholder: "my-org" },
      ],
    },
    helpUrl: "https://sentry.io/settings/account/api/auth-tokens/",
    helpSteps: [
      "Open sentry.io/settings/account/api/auth-tokens",
      "Create a new token with scopes: project:read, event:read",
      "Copy the token and your organization slug",
    ],
    testDescription: "Verifies the token via the Sentry API",
    mcp: {
      command: "npx",
      args: ["-y", "sentry-mcp"],
      env: { SENTRY_AUTH_TOKEN: "{{SENTRY_AUTH_TOKEN}}", SENTRY_ORG: "{{SENTRY_ORG}}" },
    },
    builtin: null,
  },
  {
    id: "git",
    name: "Git",
    icon: "\u{1F4E6}",
    category: "dev",
    comingSoon: false,
    quickInstall: true,
    description: "Local Git operations: log, diff, blame",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Accesses local Git repos on the machine",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@cyanheads/git-mcp-server"],
      env: {},
    },
    builtin: null,
  },

  // ═══════════════════════════════════════
  // ── Project Management ──
  // ═══════════════════════════════════════
  {
    id: "jira",
    name: "Jira",
    icon: "\u{1F3AF}",
    category: "project",
    comingSoon: false,
    description: "Issues, sprints, Scrum and Kanban projects",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "JIRA_HOST", label: "Jira Host URL", type: "text", placeholder: "https://mycompany.atlassian.net" },
        { key: "JIRA_EMAIL", label: "Atlassian Email", type: "text", placeholder: "user@company.com" },
        { key: "JIRA_API_TOKEN", label: "API Token", type: "password", placeholder: "..." },
      ],
    },
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    helpSteps: [
      "Open id.atlassian.com/manage-profile/security/api-tokens",
      "Click 'Create API token'",
      "Copy the token and your Atlassian email",
      "The Host is your instance URL (e.g. https://myco.atlassian.net)",
    ],
    testDescription: "Verifies the token via the Jira API (/rest/api/3/myself)",
    mcp: {
      command: "npx",
      args: ["-y", "mcp-jira-cloud@latest"],
      env: { JIRA_BASE_URL: "{{JIRA_HOST}}", JIRA_EMAIL: "{{JIRA_EMAIL}}", JIRA_API_TOKEN: "{{JIRA_API_TOKEN}}" },
    },
    builtin: null,
  },
  {
    id: "confluence",
    name: "Confluence",
    icon: "\u{1F4D6}",
    category: "project",
    comingSoon: false,
    description: "Documentation, wikis, team spaces",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "CONFLUENCE_DOMAIN", label: "Atlassian Domain", type: "text", placeholder: "mycompany.atlassian.net" },
        { key: "CONFLUENCE_EMAIL", label: "Atlassian Email", type: "text", placeholder: "user@company.com" },
        { key: "CONFLUENCE_API_TOKEN", label: "API Token", type: "password", placeholder: "..." },
      ],
    },
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    helpSteps: [
      "Use the same Atlassian token as for Jira",
      "Open id.atlassian.com/manage-profile/security/api-tokens",
      "The Base URL is your Atlassian instance URL",
    ],
    testDescription: "Verifies the token via the Confluence API",
    mcp: {
      command: "npx",
      args: ["-y", "@devpuccino/mcp-confluence"],
      env: { CONFLUENCE_DOMAIN: "{{CONFLUENCE_DOMAIN}}", CONFLUENCE_EMAIL: "{{CONFLUENCE_EMAIL}}", CONFLUENCE_API_TOKEN: "{{CONFLUENCE_API_TOKEN}}" },
    },
    builtin: null,
  },
  {
    id: "trello",
    name: "Trello",
    icon: "\u{1F4CB}",
    category: "project",
    comingSoon: false,
    description: "Boards, lists, Kanban cards",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "TRELLO_API_KEY", label: "API Key", type: "password", placeholder: "..." },
        { key: "TRELLO_TOKEN", label: "Token", type: "password", placeholder: "..." },
      ],
    },
    helpUrl: "https://trello.com/power-ups/admin",
    helpSteps: [
      "Open trello.com/power-ups/admin",
      "Create a new Power-Up or use an existing one",
      "Generate an API Key and Token",
    ],
    testDescription: "Verifies the credentials via the Trello API",
    mcp: {
      command: "npx",
      args: ["-y", "mcp-server-trello"],
      env: { TRELLO_API_KEY: "{{TRELLO_API_KEY}}", TRELLO_TOKEN: "{{TRELLO_TOKEN}}" },
    },
    builtin: null,
  },
  {
    id: "todoist",
    name: "Todoist",
    icon: "\u2705",
    category: "project",
    comingSoon: false,
    description: "Tasks, projects, personal productivity",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "TODOIST_API_TOKEN", label: "API Token", type: "password", placeholder: "..." },
      ],
    },
    helpUrl: "https://todoist.com/prefs/integrations",
    helpSteps: [
      "Open todoist.com/prefs/integrations",
      "Under 'Developer', copy your API token",
    ],
    testDescription: "Verifies the token via the Todoist API",
    mcp: {
      command: "npx",
      args: ["-y", "todoist-mcp"],
      env: { TODOIST_API_TOKEN: "{{TODOIST_API_TOKEN}}" },
    },
    builtin: null,
  },

  // ═══════════════════════════════════════
  // ── Productivity ──
  // ═══════════════════════════════════════
  {
    id: "slack",
    name: "Slack",
    icon: "\u{1F4AC}",
    category: "productivity",
    comingSoon: false,
    description: "Messages, channels, search",
    backends: ["builtin", "mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "SLACK_BOT_TOKEN", label: "Bot Token", type: "password", placeholder: "xoxb-..." },
        { key: "SLACK_TEAM_ID", label: "Team ID", type: "text", placeholder: "T0123456789" },
      ],
    },
    helpUrl: "https://api.slack.com/apps",
    helpSteps: [
      "Open api.slack.com/apps and create an app",
      "OAuth & Permissions → add scopes: channels:read, chat:write, search:read, users:read",
      "Install the app in your workspace",
      "Copy the 'Bot User OAuth Token' (xoxb-...)",
      "Team ID: visible in your workspace URL (T...)",
    ],
    testDescription: "Verifies the token via Slack auth.test",
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: "{{SLACK_BOT_TOKEN}}", SLACK_TEAM_ID: "{{SLACK_TEAM_ID}}" },
    },
    builtin: {
      module: "./builtin/slack.js",
      baseUrl: "https://slack.com/api",
    },
  },
  {
    id: "notion",
    name: "Notion",
    icon: "\u{1F4DD}",
    category: "productivity",
    comingSoon: false,
    description: "Pages, databases, wikis",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "NOTION_TOKEN", label: "Integration Token", type: "password", placeholder: "ntn_..." },
      ],
    },
    helpUrl: "https://www.notion.so/profile/integrations",
    helpSteps: [
      "Open notion.so/profile/integrations",
      "Create an internal integration (name: Yabby)",
      "Copy the token (ntn_...)",
      "In Notion, share your pages with the integration",
    ],
    testDescription: "Verifies the token via the Notion API (/users/me)",
    mcp: {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { NOTION_TOKEN: "{{NOTION_TOKEN}}" },
    },
    builtin: null,
  },

  // ═══════════════════════════════════════
  // ── Design ──
  // ═══════════════════════════════════════
  {
    id: "figma",
    name: "Figma",
    icon: "\u{1F3A8}",
    category: "design",
    comingSoon: false,
    description: "Files, components, design tokens",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "FIGMA_API_KEY", label: "Personal Access Token", type: "password", placeholder: "figd_..." },
      ],
    },
    helpUrl: "https://www.figma.com/developers/api#access-tokens",
    helpSteps: [
      "Open figma.com → Settings → Personal Access Tokens",
      "Create a new token",
      "Copy the token (figd_...)",
    ],
    testDescription: "Verifies the token via the Figma API (/me)",
    mcp: {
      command: "npx",
      args: ["-y", "figma-developer-mcp", "--stdio"],
      env: { FIGMA_API_KEY: "{{FIGMA_API_KEY}}" },
    },
    builtin: null,
  },

  // ═══════════════════════════════════════
  // ── Data ──
  // ═══════════════════════════════════════
  {
    id: "postgres",
    name: "PostgreSQL",
    icon: "\u{1F418}",
    category: "data",
    comingSoon: false,
    description: "SQL queries, schema, data",
    backends: ["builtin", "mcp"],
    authType: "connection_string",
    authConfig: {
      fields: [
        { key: "PG_CONNECTION_STRING", label: "Connection URI", type: "password", placeholder: "postgresql://user:pass@host:5432/db" },
      ],
    },
    helpUrl: null,
    helpSteps: [
      "Copy the connection URI of your PostgreSQL database",
      "Format: postgresql://user:pass@host:5432/db",
      "Make sure the database is accessible from this server",
    ],
    testDescription: "Verifies the connection via SELECT 1",
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "{{PG_CONNECTION_STRING}}"],
      env: {},
    },
    builtin: {
      module: "./builtin/postgres.js",
    },
  },
  {
    id: "mongodb",
    name: "MongoDB",
    icon: "\u{1F343}",
    category: "data",
    comingSoon: false,
    description: "Collections, documents, aggregations",
    backends: ["mcp"],
    authType: "connection_string",
    authConfig: {
      fields: [
        { key: "MONGODB_URI", label: "Connection URI", type: "password", placeholder: "mongodb+srv://user:pass@cluster.mongodb.net/db" },
      ],
    },
    helpUrl: null,
    helpSteps: [
      "Copy the connection URI of your MongoDB database",
      "Available in MongoDB Atlas → Connect → Drivers",
      "Format: mongodb+srv://user:pass@cluster.mongodb.net/db",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "mongodb-mcp-server@latest"],
      env: { MDB_MCP_CONNECTION_STRING: "{{MONGODB_URI}}" },
    },
    builtin: null,
  },
  {
    id: "mysql",
    name: "MySQL",
    icon: "\u{1F42C}",
    category: "data",
    comingSoon: false,
    description: "SQL queries, tables, MySQL schema",
    backends: ["mcp"],
    authType: "connection_string",
    authConfig: {
      fields: [
        { key: "MYSQL_HOST", label: "Host", type: "text", placeholder: "localhost" },
        { key: "MYSQL_USER", label: "User", type: "text", placeholder: "root" },
        { key: "MYSQL_PASSWORD", label: "Password", type: "password", placeholder: "..." },
        { key: "MYSQL_DATABASE", label: "Database", type: "text", placeholder: "mydb" },
      ],
    },
    helpUrl: null,
    helpSteps: [
      "Enter your MySQL database connection details",
      "Make sure the database is accessible from this server",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "mcp-server-mysql"],
      env: { MYSQL_HOST: "{{MYSQL_HOST}}", MYSQL_USER: "{{MYSQL_USER}}", MYSQL_PASSWORD: "{{MYSQL_PASSWORD}}", MYSQL_DATABASE: "{{MYSQL_DATABASE}}" },
    },
    builtin: null,
  },
  {
    id: "supabase",
    name: "Supabase",
    icon: "\u26A1",
    category: "data",
    comingSoon: false,
    description: "Database, auth, Supabase storage",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "SUPABASE_URL", label: "Project URL", type: "text", placeholder: "https://xxx.supabase.co" },
        { key: "SUPABASE_API_KEY", label: "Service Role Key", type: "password", placeholder: "eyJ..." },
      ],
    },
    helpUrl: "https://supabase.com/dashboard/project/_/settings/api",
    helpSteps: [
      "Open your Supabase project → Settings → API",
      "Copy the Project URL and Service Role Key",
    ],
    testDescription: "Verifies the key via the Supabase API",
    mcp: {
      command: "npx",
      args: ["-y", "supabase-mcp"],
      env: { SUPABASE_URL: "{{SUPABASE_URL}}", SUPABASE_SERVICE_ROLE_KEY: "{{SUPABASE_API_KEY}}" },
    },
    builtin: null,
  },
  {
    id: "filesystem",
    name: "Filesystem",
    icon: "\u{1F5C2}\uFE0F",
    category: "data",
    comingSoon: false,
    quickInstall: true,
    description: "Read and write local files",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Files are isolated in /tmp/yabby-files",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/yabby-files"],
      env: {},
    },
    builtin: null,
  },

  // ═══════════════════════════════════════
  // ── Search & Web ──
  // ═══════════════════════════════════════
  {
    id: "brave-search",
    name: "Brave Search",
    icon: "\u{1F981}",
    category: "search",
    comingSoon: false,
    description: "Private and fast web search",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "BRAVE_API_KEY", label: "API Key", type: "password", placeholder: "BSA..." },
      ],
    },
    helpUrl: "https://brave.com/search/api/",
    helpSteps: [
      "Open brave.com/search/api",
      "Create a developer account (free)",
      "Generate an API key",
      "Copy the key (BSA...)",
    ],
    testDescription: "Verifies the key via a test search",
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
      env: { BRAVE_API_KEY: "{{BRAVE_API_KEY}}" },
    },
    builtin: null,
  },
  {
    id: "web-fetch",
    name: "Web Fetch",
    icon: "\u{1F310}",
    category: "search",
    comingSoon: false,
    description: "Fetch and analyze web pages",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Fetches the content of any URL",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@kazuph/mcp-fetch"],
      env: {},
    },
    builtin: null,
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    icon: "\u{1F30D}",
    category: "search",
    comingSoon: false,
    description: "Browser automation, screenshots, scraping",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Launches a headless Chromium browser",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-puppeteer"],
      env: {},
    },
    builtin: null,
  },
  {
    id: "memory",
    name: "Memory",
    icon: "\u{1F9E0}",
    category: "search",
    comingSoon: false,
    description: "Persistent knowledge storage (knowledge graph)",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Stores and retrieves facts in a knowledge graph",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      env: {},
    },
    builtin: null,
  },

  // ═══════════════════════════════════════
  // ── Tools & Automation ──
  // ═══════════════════════════════════════
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    icon: "🌐",
    category: "tools",
    comingSoon: false,
    quickInstall: true,
    description: "Control Chrome: navigate, screenshot, evaluate JS, network, console",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Chrome must be running with --remote-debugging-port=9222",
      "Provides tools: navigate, screenshot, evaluate JS, network monitoring",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest", "--autoConnect"],
      env: {},
    },
    builtin: null,
  },
  {
    id: "playwright",
    name: "Playwright",
    icon: "🎭",
    category: "tools",
    comingSoon: false,
    quickInstall: true,
    description: "Browser automation: click, fill, screenshot, navigate, test",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Launches a headless Chromium browser",
      "Provides tools: navigate, click, fill forms, screenshot, extract text",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: {},
    },
    builtin: null,
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    icon: "🧠",
    category: "tools",
    comingSoon: false,
    quickInstall: true,
    description: "Step-by-step reasoning and problem decomposition",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Adds a structured thinking tool for complex reasoning",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      env: {},
    },
    builtin: null,
  },
  {
    id: "google-maps",
    name: "Google Maps",
    icon: "🗺️",
    category: "tools",
    comingSoon: false,
    quickInstall: true,
    description: "Places, directions, geocoding, distance matrix",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "GOOGLE_MAPS_API_KEY", label: "Google Maps API Key", type: "password", placeholder: "AIza..." },
      ],
    },
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    helpSteps: [
      "Go to Google Cloud Console → APIs & Services → Credentials",
      "Create an API key",
      "Enable Maps Platform APIs (Places, Directions, Geocoding)",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-google-maps"],
      env: { GOOGLE_MAPS_API_KEY: "{{GOOGLE_MAPS_API_KEY}}" },
    },
    builtin: null,
  },
  {
    id: "everart",
    name: "EverArt",
    icon: "🎨",
    category: "tools",
    comingSoon: false,
    quickInstall: true,
    description: "AI image generation and editing",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "EVERART_API_KEY", label: "API Key", type: "password", placeholder: "..." },
      ],
    },
    helpUrl: "https://everart.ai",
    helpSteps: [
      "Sign up at everart.ai",
      "Get your API key from the dashboard",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@anthropic-ai/mcp-everart"],
      env: { EVERART_API_KEY: "{{EVERART_API_KEY}}" },
    },
    builtin: null,
  },
  {
    id: "youtube-transcript",
    name: "YouTube Transcript",
    icon: "▶️",
    category: "tools",
    comingSoon: false,
    quickInstall: true,
    description: "Extract transcripts and captions from YouTube videos",
    backends: ["mcp"],
    authType: "none",
    authConfig: { fields: [] },
    helpUrl: null,
    helpSteps: [
      "No configuration needed",
      "Provide a YouTube URL to get the transcript",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "mcp-youtube-transcript"],
      env: {},
    },
    builtin: null,
  },
  {
    id: "slack-mcp",
    name: "Slack (MCP)",
    icon: "💬",
    category: "tools",
    comingSoon: false,
    quickInstall: true,
    description: "Full Slack integration via MCP: channels, messages, reactions",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "SLACK_BOT_TOKEN", label: "Bot Token", type: "password", placeholder: "xoxb-..." },
        { key: "SLACK_TEAM_ID", label: "Team ID", type: "text", placeholder: "T0123456789" },
      ],
    },
    helpUrl: "https://api.slack.com/apps",
    helpSteps: [
      "Create a Slack app at api.slack.com/apps",
      "Add scopes: channels:read, chat:write, search:read, users:read",
      "Install to workspace and copy the Bot Token (xoxb-…)",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: "{{SLACK_BOT_TOKEN}}", SLACK_TEAM_ID: "{{SLACK_TEAM_ID}}" },
    },
    builtin: null,
  },

  // ═══════════════════════════════════════
  // ── Coming soon ──
  // ═══════════════════════════════════════

  // Google Workspace
  {
    id: "gmail",
    name: "Gmail",
    icon: "\u{1F4E7}",
    category: "google",
    comingSoon: false,
    quickInstall: true,
    description: "Send, read, search emails, manage labels, attachments",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "GMAIL_OAUTH_PATH", label: "OAuth credentials file path", type: "text", placeholder: "~/.gmail-mcp/gcp-oauth.keys.json" },
      ],
    },
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    helpSteps: [
      "Create a Google Cloud project and enable the Gmail API",
      "Go to APIs & Services > Credentials > Create OAuth client ID",
      "Choose 'Desktop app' and download the JSON file",
      "Place it as ~/.gmail-mcp/gcp-oauth.keys.json",
      "Run: npx @gongrzhe/server-gmail-autoauth-mcp auth",
      "Complete the OAuth flow in your browser (one-time)",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      env: {},
    },
    builtin: null,
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    icon: "\u{1F4C5}",
    category: "google",
    comingSoon: false,
    quickInstall: true,
    description: "Events, scheduling, multi-account, free/busy queries",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "GOOGLE_OAUTH_CREDENTIALS", label: "OAuth credentials file path", type: "text", placeholder: "/path/to/gcp-oauth.keys.json" },
      ],
    },
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    helpSteps: [
      "Create a Google Cloud project and enable the Calendar API",
      "Go to APIs & Services > Credentials > Create OAuth client ID",
      "Choose 'Desktop app' and download the JSON file",
      "Set the path in the field below",
      "On first use, complete the OAuth flow in your browser (one-time)",
      "Add your email as a test user in the OAuth consent screen",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "@cocal/google-calendar-mcp"],
      env: { GOOGLE_OAUTH_CREDENTIALS: "{{GOOGLE_OAUTH_CREDENTIALS}}" },
    },
    builtin: null,
  },
  {
    id: "outlook-mail",
    name: "Outlook Mail",
    icon: "\u{1F4EC}",
    category: "google",
    comingSoon: false,
    quickInstall: true,
    description: "Read, send, search Outlook/Microsoft 365 emails",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: {
      fields: [
        { key: "OUTLOOK_CLIENT_ID", label: "Azure App Client ID", type: "text", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
        { key: "OUTLOOK_CLIENT_SECRET", label: "Client Secret (optional)", type: "password", placeholder: "..." },
      ],
    },
    helpUrl: "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps",
    helpSteps: [
      "Register an app in Azure Portal > App registrations",
      "Add Microsoft Graph permissions: Mail.Read, Mail.Send",
      "Copy the Application (client) ID",
      "On first use, it uses Device Flow auth (follow the terminal prompt)",
    ],
    testDescription: null,
    mcp: {
      command: "npx",
      args: ["-y", "mcp-outlook-mail"],
      env: { OUTLOOK_CLIENT_ID: "{{OUTLOOK_CLIENT_ID}}", OUTLOOK_CLIENT_SECRET: "{{OUTLOOK_CLIENT_SECRET}}" },
    },
    builtin: null,
  },
  {
    id: "google-drive",
    name: "Google Drive",
    icon: "\u{1F4C2}",
    category: "google",
    comingSoon: true,
    description: "Files, folders, shared documents",
    backends: ["mcp"],
    authType: "oauth",
    authConfig: { fields: [] },
    helpUrl: null, helpSteps: [], testDescription: null,
    mcp: null, builtin: null,
  },

  // Communication
  {
    id: "discord",
    name: "Discord",
    icon: "\u{1F3AE}",
    category: "communication",
    comingSoon: true,
    description: "Servers, channels, Discord messages",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: { fields: [] },
    helpUrl: null, helpSteps: [], testDescription: null,
    mcp: null, builtin: null,
  },
  {
    id: "telegram",
    name: "Telegram",
    icon: "\u2708\uFE0F",
    category: "communication",
    comingSoon: true,
    description: "Messages, bots, Telegram groups",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: { fields: [] },
    helpUrl: null, helpSteps: [], testDescription: null,
    mcp: null, builtin: null,
  },

  // Business
  {
    id: "stripe",
    name: "Stripe",
    icon: "\u{1F4B3}",
    category: "business",
    comingSoon: true,
    description: "Payments, customers, subscriptions",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: { fields: [] },
    helpUrl: null, helpSteps: [], testDescription: null,
    mcp: null, builtin: null,
  },
  {
    id: "hubspot",
    name: "HubSpot",
    icon: "\u{1F9F2}",
    category: "business",
    comingSoon: true,
    description: "CRM, contacts, deals, marketing",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: { fields: [] },
    helpUrl: null, helpSteps: [], testDescription: null,
    mcp: null, builtin: null,
  },
  {
    id: "salesforce",
    name: "Salesforce",
    icon: "\u2601\uFE0F",
    category: "business",
    comingSoon: true,
    description: "CRM, opportunities, accounts, reports",
    backends: ["mcp"],
    authType: "oauth",
    authConfig: { fields: [] },
    helpUrl: null, helpSteps: [], testDescription: null,
    mcp: null, builtin: null,
  },

  // DevOps
  {
    id: "datadog",
    name: "Datadog",
    icon: "\u{1F415}",
    category: "devops",
    comingSoon: true,
    description: "Metrics, logs, APM, monitoring",
    backends: ["mcp"],
    authType: "api_key",
    authConfig: { fields: [] },
    helpUrl: null, helpSteps: [], testDescription: null,
    mcp: null, builtin: null,
  },
];

// ── Helpers ──

export function getCatalogEntry(catalogId) {
  return CONNECTOR_CATALOG.find((c) => c.id === catalogId) || null;
}

export function getCatalogByCategory() {
  const grouped = {};
  for (const entry of CONNECTOR_CATALOG) {
    if (!grouped[entry.category]) grouped[entry.category] = [];
    grouped[entry.category].push(entry);
  }
  return grouped;
}

export const CATEGORY_ORDER = ["tools", "dev", "project", "productivity", "design", "data", "search", "communication", "business", "devops", "google"];

export function suggestForProjectType(projectType) {
  if (!projectType) return ["github", "slack"];
  const type = projectType.toLowerCase();
  if (type.includes("dev") || type.includes("code") || type.includes("app")) {
    return ["github", "linear", "sentry", "slack"];
  }
  if (type.includes("market") || type.includes("content") || type.includes("blog")) {
    return ["notion", "slack", "figma"];
  }
  if (type.includes("data") || type.includes("analy")) {
    return ["postgres", "supabase", "brave-search", "github"];
  }
  if (type.includes("design") || type.includes("ui") || type.includes("ux")) {
    return ["figma", "github", "trello"];
  }
  return ["github", "slack", "notion"];
}

const CATEGORY_LABELS = {
  tools: "Tools & Automation",
  dev: "Development",
  project: "Project Management",
  productivity: "Productivity",
  design: "Design",
  data: "Data",
  search: "Search & Web",
  communication: "Communication",
  business: "Business",
  devops: "DevOps",
  google: "Google Workspace",
};

export function getCategoryLabel(cat) {
  return CATEGORY_LABELS[cat] || cat;
}
