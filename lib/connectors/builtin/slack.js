import { BuiltinConnector } from "./base.js";

export class SlackConnector extends BuiltinConnector {
  _authHeaders() {
    return {
      Authorization: `Bearer ${this.credentials.SLACK_BOT_TOKEN}`,
    };
  }

  getTools() {
    return [
      {
        name: "list_channels",
        description: "Lister les channels Slack",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Nombre max (d\u00e9faut 20)" },
          },
        },
      },
      {
        name: "send_message",
        description: "Envoyer un message dans un channel Slack",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "ID ou nom du channel" },
            text: { type: "string", description: "Contenu du message" },
          },
          required: ["channel", "text"],
        },
      },
      {
        name: "read_messages",
        description: "Lire les derniers messages d'un channel",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "ID du channel" },
            limit: { type: "number", description: "Nombre de messages (d\u00e9faut 10)" },
          },
          required: ["channel"],
        },
      },
      {
        name: "search_messages",
        description: "Rechercher dans les messages Slack",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Terme de recherche" },
            count: { type: "number", description: "Nombre de r\u00e9sultats" },
          },
          required: ["query"],
        },
      },
    ];
  }

  async executeTool(toolName, args) {
    const BASE = "https://slack.com/api";

    switch (toolName) {
      case "list_channels": {
        const limit = Math.min(args.limit || 20, 50);
        const data = await this._fetch(`${BASE}/conversations.list?limit=${limit}&types=public_channel,private_channel`);
        if (!data.ok) throw new Error(data.error || "Slack API error");
        return JSON.stringify(data.channels?.map(c => ({ id: c.id, name: c.name, topic: c.topic?.value, members: c.num_members })));
      }
      case "send_message": {
        const data = await this._fetch(`${BASE}/chat.postMessage`, {
          method: "POST",
          body: JSON.stringify({ channel: args.channel, text: args.text }),
        });
        if (!data.ok) throw new Error(data.error || "Failed to send message");
        return JSON.stringify({ sent: true, ts: data.ts, channel: data.channel });
      }
      case "read_messages": {
        const limit = Math.min(args.limit || 10, 30);
        const data = await this._fetch(`${BASE}/conversations.history?channel=${args.channel}&limit=${limit}`);
        if (!data.ok) throw new Error(data.error || "Slack API error");
        return JSON.stringify(data.messages?.map(m => ({ user: m.user, text: m.text?.slice(0, 500), ts: m.ts })));
      }
      case "search_messages": {
        const count = Math.min(args.count || 5, 20);
        const data = await this._fetch(`${BASE}/search.messages?query=${encodeURIComponent(args.query)}&count=${count}`);
        if (!data.ok) throw new Error(data.error || "Slack API error");
        return JSON.stringify({ total: data.messages?.total, matches: data.messages?.matches?.map(m => ({ text: m.text?.slice(0, 300), channel: m.channel?.name, user: m.username, ts: m.ts })) });
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async testCredentials() {
    const data = await this._fetch("https://slack.com/api/auth.test");
    if (!data.ok) throw new Error(data.error || "Invalid token");
    return true;
  }
}
