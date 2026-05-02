# Channel Setup Guide

Yabby supports 5 messaging channels: Telegram, Discord, Slack, WhatsApp, and Signal. Each channel lets users chat with Yabby, run tasks, and receive notifications.

All channels share the same conversation context and tools. Messages stay in their own channel (no cross-posting).

---

## Telegram

### 1. Create a Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a name (e.g. "Yabby") and username (e.g. "YabbyAssistantBot")
4. Copy the **bot token** (looks like `8717138165:AAGjIlZO...`)

### 2. Configure in Yabby

**Via UI:**
1. Go to Yabby web UI -> Channels -> Configuration tab
2. Enable Telegram
3. Paste the bot token
4. Set DM Policy to "Open" (anyone can message) or "Closed" (whitelist only)
5. Click Save

**Via API:**
```bash
curl -X PUT http://localhost:3000/api/config/channels \
  -H "Content-Type: application/json" \
  -d '{
    "telegram": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "dmPolicy": "open",
      "groupMentionGating": false
    }
  }'

curl -X POST http://localhost:3000/api/channels/telegram/restart
```

### 3. Test

- Open Telegram and search for your bot by username
- Send a message like "hello yabby"
- The bot should reply within a few seconds
- Try `/status`, `/help`, `/new` commands

### Notes

- Telegram uses **long polling** (no webhook/public URL needed)
- Message limit: 4096 chars per message (auto-chunked)
- Group support: add bot to a group, set `groupMentionGating: true` to only respond when mentioned

---

## Discord

### 1. Create a Bot Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name (e.g. "Yabby")
3. Go to the **Bot** section
4. Click **Reset Token** and copy the **bot token**

### 2. Enable Privileged Intents

This is **critical** — without this the bot will fail to start with "Used disallowed intents":

1. In the Bot section, scroll to **Privileged Gateway Intents**
2. Enable **MESSAGE CONTENT INTENT** (required to read message text)
3. Optionally enable **SERVER MEMBERS INTENT**
4. Save changes

### 3. Invite Bot to Your Server

Open this URL in your browser (replace `YOUR_CLIENT_ID` with the Application ID from the General Information page):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274877975552&scope=bot
```

This grants: Read Messages, Send Messages, Read Message History, Attach Files (for voice replies).

Select your server and click Authorize.

### 4. Configure in Yabby

**Via UI:**
1. Channels -> Configuration -> Enable Discord
2. Paste bot token
3. Save

**Via API:**
```bash
curl -X PUT http://localhost:3000/api/config/channels \
  -H "Content-Type: application/json" \
  -d '{
    "discord": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "dmPolicy": "open",
      "groupMentionGating": false
    }
  }'

curl -X POST http://localhost:3000/api/channels/discord/restart
```

### 5. Test

- Send a message in any text channel where the bot is present
- Or DM the bot directly (click bot name in server members -> Message)
- Voice messages: send a voice clip, bot will transcribe and reply with audio

### Notes

- Discord uses **WebSocket gateway** (no public URL needed)
- Message limit: 2000 chars per message (auto-chunked)
- Voice messages supported: send audio -> transcribed via Whisper -> audio reply via TTS
- If you see "Used disallowed intents" error, you forgot to enable Message Content Intent in step 2

### Troubleshooting

| Error | Fix |
|-------|-----|
| `Used disallowed intents` | Enable **Message Content Intent** in Developer Portal -> Bot -> Privileged Intents |
| `An invalid token was provided` | Regenerate token in Developer Portal -> Bot -> Reset Token, update in Yabby |
| Bot online but not responding | Check bot has **Read Messages** permission in the channel |

---

## Slack

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** -> **From Scratch**
3. Name it "Yabby", select your workspace

### 2. Enable Socket Mode

1. Left sidebar -> **Socket Mode**
2. Enable Socket Mode
3. Click **Generate** to create an App-Level Token
   - Name: "yabby-socket"
   - Scope: `connections:write`
   - Click Generate
4. Copy the **App Token** (starts with `xapp-`)

### 3. Add Bot Token Scopes

1. Left sidebar -> **OAuth & Permissions**
2. Under **Bot Token Scopes**, add:
   - `chat:write` (send messages)
   - `channels:history` (read channel messages)
   - `groups:history` (read private channel messages)
   - `im:history` (read DMs)
   - `users:read` (get user display names)
   - `files:read` (receive voice/audio messages)
   - `files:write` (send audio replies)

### 4. Subscribe to Events

1. Left sidebar -> **Event Subscriptions**
2. Enable Events
3. Under **Subscribe to bot events**, add:
   - `message.channels`
   - `message.groups`
   - `message.im`

### 5. Enable DMs

1. Left sidebar -> **App Home**
2. Under **Show Tabs**, enable **Messages Tab**
3. Check **"Allow users to send Slash commands and messages from the messages tab"**

### 6. Install to Workspace

1. Left sidebar -> **OAuth & Permissions**
2. Click **Install to Workspace** (or Reinstall if updating scopes)
3. Authorize
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 7. Configure in Yabby

**Via UI:**
1. Channels -> Configuration -> Enable Slack
2. Paste Bot Token (`xoxb-...`) and App Token (`xapp-...`)
3. Save

**Via API:**
```bash
curl -X PUT http://localhost:3000/api/config/channels \
  -H "Content-Type: application/json" \
  -d '{
    "slack": {
      "enabled": true,
      "botToken": "xoxb-YOUR-BOT-TOKEN",
      "appToken": "xapp-YOUR-APP-TOKEN",
      "dmPolicy": "open",
      "groupMentionGating": false
    }
  }'

curl -X POST http://localhost:3000/api/channels/slack/restart
```

### 8. Test

- Open Slack and DM the Yabby bot (find it under Apps in your workspace)
- Send "hello yabby"
- For voice: send an audio file (.m4a, .ogg, .mp3) as an attachment

### Notes

- Slack uses **Socket Mode** (no public URL needed)
- No message length limit (Slack supports very long messages)
- Thread support: bot replies in threads when messages are in threads
- Voice messages: send audio file attachment -> transcribed via Whisper -> audio reply uploaded

### Troubleshooting

| Error | Fix |
|-------|-----|
| `Slack botToken and appToken required` | You need both tokens. Bot Token from OAuth & Permissions, App Token from Socket Mode/Basic Info |
| "Sending messages to this app has been turned off" | Enable Messages Tab in App Home settings (step 5) |
| Bot doesn't receive messages | Check Event Subscriptions are enabled with `message.im` event |
| Voice messages not working | Add `files:read` scope, reinstall app to workspace |

---

## WhatsApp

### 1. Prerequisites

WhatsApp uses the Baileys library (WhatsApp Web protocol). No Meta Business API needed.

### 2. Configure in Yabby

**Via UI:**
1. Channels -> Configuration -> Enable WhatsApp
2. Optionally set a phone number (for pairing code instead of QR)
3. Save

**Via API:**
```bash
curl -X PUT http://localhost:3000/api/config/channels \
  -H "Content-Type: application/json" \
  -d '{
    "whatsapp": {
      "enabled": true,
      "dmPolicy": "open",
      "groupMentionGating": true,
      "botName": "yabby"
    }
  }'

curl -X POST http://localhost:3000/api/channels/whatsapp/restart
```

### 3. Scan QR Code

1. After enabling, go to Channels -> Overview
2. Click "Show QR" on the WhatsApp card
3. Open WhatsApp on your phone -> Settings -> Linked Devices -> Link a Device
4. Scan the QR code

Or use the API to get the QR:
```bash
curl http://localhost:3000/api/channels/whatsapp/qr
```

### 4. How It Works

- Yabby auto-creates a group called "Yabby Assistant"
- By default, bot only responds in this group (not in other chats)
- Set `groupMentionGating: true` to require @mention in groups
- Session persists in `data/whatsapp-auth/` (survives restarts)

### Notes

- Uses Baileys library (WhatsApp Web protocol, not Meta Business API)
- Auto-creates dedicated Yabby group
- QR authentication (or pairing code with phone number)
- Voice message support (audio transcription + TTS reply)
- Session auto-reconnects with exponential backoff
- Message limit: 4KB per message (auto-chunked)

---

## Signal

### 1. Prerequisites

Signal requires a `signal-cli-rest-api` Docker container:

```bash
docker run -d --name signal-api \
  -p 8080:8080 \
  -v signal-data:/home/.local/share/signal-cli \
  bbernhard/signal-cli-rest-api
```

### 2. Register or Link a Phone Number

**Register a new number:**
```bash
# Request verification code (via SMS)
curl -X POST http://localhost:8080/v1/register/+1234567890

# Verify with the code you received
curl -X POST http://localhost:8080/v1/register/+1234567890/verify/123456
```

**Or link to existing Signal account:**
```bash
# Get a QR code link
curl http://localhost:8080/v1/qrcodelink?device_name=Yabby
```
Scan this QR code with your Signal app (Settings -> Linked Devices).

### 3. Configure in Yabby

**Via API:**
```bash
curl -X PUT http://localhost:3000/api/config/channels \
  -H "Content-Type: application/json" \
  -d '{
    "signal": {
      "enabled": true,
      "apiUrl": "http://localhost:8080",
      "phoneNumber": "+1234567890",
      "mode": "websocket",
      "dmPolicy": "open"
    }
  }'

curl -X POST http://localhost:3000/api/channels/signal/restart
```

### 4. Test

- Send a message to the registered phone number on Signal
- Bot should reply within a few seconds

### Notes

- Requires Docker running `signal-cli-rest-api`
- Two modes: `websocket` (recommended, real-time) or `polling` (fallback)
- Group support: messages in groups use `group.{groupId}` as channel ID
- Auto-reconnects WebSocket on disconnect (5s delay)

---

## Common Configuration Options

All channels share these config options:

| Option | Values | Description |
|--------|--------|-------------|
| `enabled` | `true`/`false` | Enable or disable the channel |
| `dmPolicy` | `"open"` / `"closed"` | `open`: anyone can message. `closed`: only `allowedUsers` list |
| `allowedUsers` | `["user1", "user2"]` | User IDs allowed when policy is `closed` |
| `groupMentionGating` | `true`/`false` | In groups, only respond when bot name is mentioned |
| `botName` | `"yabby"` | Name used for mention detection in groups |

## Channel Commands

These work in all channels:

| Command | Description |
|---------|-------------|
| `/status` | Show running/completed/failed task counts |
| `/help` | Show available commands |
| `/new` | Start a new conversation (clears history) |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/channels` | List all channels with status |
| `POST` | `/api/channels/{name}/restart` | Restart a channel |
| `POST` | `/api/channels/{name}/stop` | Stop a channel |
| `GET` | `/api/channels/{name}/conversations` | List conversations for a channel |
| `GET` | `/api/channels/conversations/{id}/messages` | Get messages in a conversation |
| `GET` | `/api/config/channels` | Get channel configuration |
| `PUT` | `/api/config/channels` | Update channel configuration |

## Requirements

- **OpenAI API key** is required for the LLM that handles channel messages (uses `gpt-5-mini`)
- **Whisper** (via OpenAI) is used for voice message transcription
- **TTS** (configurable provider) is used for audio replies
- No public URL or webhook endpoint needed — all channels use polling or WebSocket connections
