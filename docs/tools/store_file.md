# store_file

Stores a local file from the agent's filesystem into the media store, then automatically dispatches it as a document (or image) to the user's active channel (WhatsApp, webchat, etc.). Use this whenever an agent generates a file (report, CSV, PDF, archive) that needs to be delivered to the user. The file must reside under the workspace root or `/tmp`, be ≤ 50 MB, and have an allowed MIME type (images, PDF, text, CSV, JSON, ZIP, Office documents).

## Prompt template

```
When you need to send a file to the user:
1. Create the file locally (in /tmp or the project sandbox)
2. Call store_file with the absolute path
3. The file is automatically sent as a WhatsApp document or webchat download

Example:
  store_file({ path: "/tmp/monthly-report.csv", caption: "Rapport mensuel" })
  store_file({ path: "/tmp/backup.zip", filename: "project-backup.zip" })
```

## Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `path` | yes | Absolute path (must be under workspace or `/tmp`) |
| `filename` | no | Display name for recipient (defaults to file basename) |
| `caption` | no | Short caption attached to the document |

## Security

- Relative paths and `..` are rejected
- Only workspace root and `/tmp` are allowed
- Max 50 MB per file
- MIME whitelist enforced (see `lib/media/mime.js`)
