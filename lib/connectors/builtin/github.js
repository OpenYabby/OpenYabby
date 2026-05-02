import { BuiltinConnector } from "./base.js";

export class GitHubConnector extends BuiltinConnector {
  _authHeaders() {
    return {
      Authorization: `token ${this.credentials.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    };
  }

  getTools() {
    return [
      {
        name: "list_repos",
        description: "Lister vos d\u00e9p\u00f4ts GitHub",
        parameters: {
          type: "object",
          properties: {
            sort: { type: "string", enum: ["updated", "pushed", "full_name", "created"], description: "Tri" },
            per_page: { type: "number", description: "Nombre de r\u00e9sultats (max 30)" },
          },
        },
      },
      {
        name: "get_repo",
        description: "D\u00e9tails d'un d\u00e9p\u00f4t",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "list_issues",
        description: "Lister les issues d'un d\u00e9p\u00f4t",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            state: { type: "string", enum: ["open", "closed", "all"] },
            per_page: { type: "number" },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "create_issue",
        description: "Cr\u00e9er une issue",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
          },
          required: ["owner", "repo", "title"],
        },
      },
      {
        name: "list_pull_requests",
        description: "Lister les pull requests",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            state: { type: "string", enum: ["open", "closed", "all"] },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "search_code",
        description: "Rechercher du code sur GitHub",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Terme de recherche" },
            per_page: { type: "number" },
          },
          required: ["query"],
        },
      },
    ];
  }

  async executeTool(toolName, args) {
    switch (toolName) {
      case "list_repos": {
        const sort = args.sort || "updated";
        const perPage = Math.min(args.per_page || 10, 30);
        const data = await this._fetch(`https://api.github.com/user/repos?sort=${sort}&per_page=${perPage}`);
        return JSON.stringify(data.map(r => ({ name: r.full_name, description: r.description, stars: r.stargazers_count, language: r.language, updated: r.updated_at })));
      }
      case "get_repo": {
        const data = await this._fetch(`https://api.github.com/repos/${args.owner}/${args.repo}`);
        return JSON.stringify({ name: data.full_name, description: data.description, stars: data.stargazers_count, forks: data.forks_count, language: data.language, open_issues: data.open_issues_count, default_branch: data.default_branch });
      }
      case "list_issues": {
        const state = args.state || "open";
        const perPage = Math.min(args.per_page || 10, 30);
        const data = await this._fetch(`https://api.github.com/repos/${args.owner}/${args.repo}/issues?state=${state}&per_page=${perPage}`);
        return JSON.stringify(data.map(i => ({ number: i.number, title: i.title, state: i.state, labels: i.labels.map(l => l.name), author: i.user?.login, created: i.created_at })));
      }
      case "create_issue": {
        const body = { title: args.title, body: args.body || "", labels: args.labels || [] };
        const data = await this._fetch(`https://api.github.com/repos/${args.owner}/${args.repo}/issues`, { method: "POST", body: JSON.stringify(body) });
        return JSON.stringify({ number: data.number, title: data.title, url: data.html_url });
      }
      case "list_pull_requests": {
        const state = args.state || "open";
        const data = await this._fetch(`https://api.github.com/repos/${args.owner}/${args.repo}/pulls?state=${state}&per_page=10`);
        return JSON.stringify(data.map(pr => ({ number: pr.number, title: pr.title, state: pr.state, author: pr.user?.login, created: pr.created_at })));
      }
      case "search_code": {
        const perPage = Math.min(args.per_page || 5, 10);
        const data = await this._fetch(`https://api.github.com/search/code?q=${encodeURIComponent(args.query)}&per_page=${perPage}`);
        return JSON.stringify({ total: data.total_count, items: data.items?.map(i => ({ file: i.name, path: i.path, repo: i.repository?.full_name })) });
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async testCredentials() {
    await this._fetch("https://api.github.com/user");
    return true;
  }
}
