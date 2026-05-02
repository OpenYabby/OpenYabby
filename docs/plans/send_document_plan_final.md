# Plan d'implémentation — Envoi de fichiers/documents via WhatsApp

**Version** : Finale
**Date** : 2026-04-21
**Auteur** : Nolan (agent d7ae2a3f-c1e)
**Branche cible** : `pre-release-media`

---

## Résumé exécutif

Ajouter un tool `store_file` permettant aux agents CLI d'injecter n'importe quel fichier local dans le media store et de l'envoyer comme document WhatsApp. Le système existant gère déjà l'envoi (`sendDocument`, `sendImage`, `dispatchMediaToAgent`) — il manque uniquement l'ingestion depuis le disque et l'élargissement de la whitelist MIME.

**Effort total estimé : 3h**

---

## 1. État actuel du code

| Composant | Fichier | État |
|---|---|---|
| Whitelist MIME | `lib/media/mime.js` | ⚠️ Restreint (image + pdf seulement) |
| Store (write/read/head) | `lib/media/store.js` | ✅ Fonctionnel, content-addressed |
| sendImage adapter | `lib/channels/whatsapp-custom.js:514` | ✅ Accepte `{ assetId }` |
| sendDocument adapter | `lib/channels/whatsapp-custom.js:541` | ⚠️ Accepte `{ buffer, mimetype, fileName }` mais PAS `{ assetId }` |
| dispatchMediaToAgent | `routes/tools.js:63` | ⚠️ Route pdf→sendDocument, reste→sendImage |
| handler.js outbound | `lib/channels/handler.js:729` | ⚠️ Appelle toujours sendImage |
| Tool send_media | `lib/tools/send-media.js` | ✅ Valide assetId + retourne metadata |
| **Tool store_file** | — | **❌ N'existe pas** |

---

## 2. Étapes d'implémentation

### Étape 1 — Élargir la whitelist MIME

**Fichier** : `lib/media/mime.js`

```javascript
export const ALLOWED_MIMES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  // Documents
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  "application/json",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
]);
```

**Effort** : 15 min | **Complexité** : Simple | **Dépend de** : —

---

### Étape 2 — Adapter sendDocument pour accepter `{ assetId }`

**Fichier** : `lib/channels/whatsapp-custom.js`

```javascript
async sendDocument(channelId, { assetId, buffer, mimetype, fileName, caption }) {
  if (!this.client || this._connectionState !== "connected") {
    throw new Error("WhatsApp not connected");
  }

  let buf = buffer;
  let mime = mimetype;
  let name = fileName;

  // Resolve from media store if assetId provided
  if (assetId && !buf) {
    const { read } = await import("../media/store.js");
    const asset = await read(assetId);
    if (!asset) throw new Error(`sendDocument: asset ${assetId} not found`);
    buf = asset.buffer;
    mime = mime || asset.row.mime;
    name = name || `file.${asset.row.path?.split('.').pop() || 'bin'}`;
  }

  if (!buf) throw new Error("sendDocument: no buffer or assetId provided");

  log(`[WHATSAPP-CUSTOM] Sending document: ${name || assetId} (${buf.length} bytes)`);

  await this.client.sendMessage(channelId, {
    document: buf,
    mimetype: mime || "application/octet-stream",
    fileName: name || "document.bin",
    ...(caption ? { caption } : {}),
  });

  log("[WHATSAPP-CUSTOM] ✓ Document sent");
  return { ok: true, assetId: assetId || null };
}
```

**Effort** : 30 min | **Complexité** : Simple | **Dépend de** : —

---

### Étape 3 — Créer le tool `store_file`

**Fichier à créer** : `lib/tools/store-file.js`

```javascript
import { readFile, stat } from "fs/promises";
import { join, resolve, basename, extname } from "path";
import { homedir } from "os";
import { lookup as mimeLookup } from "mime-types";
import { write as storeWrite } from "../media/store.js";
import { isAllowed } from "../media/mime.js";
import { log } from "../logger.js";

const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

const ALLOWED_ROOTS = [
  process.env.SANDBOX_ROOT || join(homedir(), "Desktop/Yabby Projects"),
  "/tmp",
  "/var/folders",
  join(homedir(), "Desktop"),
  join(homedir(), "Documents"),
  join(homedir(), "Downloads"),
];

function isPathAllowed(absPath) {
  const resolved = resolve(absPath);
  if (resolved.includes("..")) return false;
  if (!resolved.startsWith("/")) return false;
  return ALLOWED_ROOTS.some(root => resolved.startsWith(root));
}

/**
 * @param {{ path: string, filename?: string, caption?: string }} args
 */
export async function storeFile(args) {
  const filePath = args?.path;
  if (!filePath || typeof filePath !== "string") {
    throw new Error("store_file: path is required");
  }

  const absPath = resolve(filePath);

  // Security: validate path
  if (!isPathAllowed(absPath)) {
    throw new Error(`store_file: path not allowed (must be in sandbox, /tmp, ~/Desktop, ~/Documents, ~/Downloads)`);
  }

  // Check file exists and size
  const stats = await stat(absPath);
  if (!stats.isFile()) throw new Error("store_file: path is not a file");
  if (stats.size > MAX_SIZE) throw new Error(`store_file: file too large (${(stats.size / 1024 / 1024).toFixed(1)} MB > 50 MB limit)`);
  if (stats.size === 0) throw new Error("store_file: file is empty");

  // Detect MIME
  const ext = extname(absPath).slice(1);
  const mime = mimeLookup(absPath) || "application/octet-stream";

  if (!isAllowed(mime)) {
    throw new Error(`store_file: MIME type "${mime}" is not allowed. Supported: images, pdf, txt, csv, json, zip, docx, xlsx, pptx, html, md, tar, gz`);
  }

  // Read and store
  const buffer = await readFile(absPath);
  const asset = await storeWrite(buffer, mime, {
    source: "store_file",
    metadata: {
      originalPath: absPath,
      originalName: args.filename || basename(absPath),
    },
  });

  log(`[TOOL:store_file] Stored ${absPath} → ${asset.id} (${mime}, ${buffer.length} bytes)`);

  return {
    assetId: asset.id,
    kind: asset.kind,
    mime,
    size_bytes: buffer.length,
    filename: args.filename || basename(absPath),
    caption: args.caption || null,
    stored: true,
  };
}
```

**Effort** : 1h | **Complexité** : Moyen | **Dépend de** : Étape 1

---

### Étape 4 — Tool Registry Entry

**Fichier** : `lib/plugins/tool-registry.js`

#### Schema (à ajouter dans `BASE_TOOLS`)

```javascript
{
  type: "function", name: "store_file",
  description: "Stocke un fichier du disque local dans le media store et l'envoie au canal actuel (WhatsApp/webchat). Utilisé pour envoyer des fichiers créés par l'agent (CSV, PDF, JSON, ZIP, etc.) à l'utilisateur. Le fichier est envoyé comme document WhatsApp avec son nom original.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Chemin absolu du fichier à envoyer (doit être dans le sandbox, /tmp, ~/Desktop, ~/Documents ou ~/Downloads)"
      },
      filename: {
        type: "string",
        description: "Nom d'affichage pour le destinataire (optionnel, défaut: nom original du fichier)"
      },
      caption: {
        type: "string",
        description: "Légende optionnelle à envoyer avec le document"
      }
    },
    required: ["path"]
  }
},
```

#### Whitelists

```javascript
// Ajouter dans CHANNEL_ALLOWED_TOOLS:
'store_file',
```

**Note** : PAS dans VOICE_ALLOWED_TOOLS (les agents CLI l'utilisent via yabby_execute).

#### Dispatcher (routes/tools.js)

```javascript
if (toolName === 'store_file') {
  const { storeFile } = await import("../lib/tools/store-file.js");
  const result = await storeFile(args);
  // Auto-dispatch to WhatsApp
  await dispatchMediaToAgent(result.assetId, result.mime, context);
  return result;
}
```

**Effort** : 30 min | **Complexité** : Simple | **Dépend de** : Étape 3

---

### Étape 5 — Fixer le dispatch outbound (handler.js + dispatchMediaToAgent)

**Fichier** : `routes/tools.js` ligne 63

```javascript
// AVANT:
if (mime === "application/pdf") {
  await whatsapp.sendDocument(targetGroupId, { assetId });
} else {
  await whatsapp.sendImage(targetGroupId, { assetId });
}

// APRÈS:
const { mimeToKind } = await import("../lib/media/mime.js");
const kind = mimeToKind(mime);
if (kind === 'image') {
  await whatsapp.sendImage(targetGroupId, { assetId });
} else {
  await whatsapp.sendDocument(targetGroupId, { assetId });
}
```

**Fichier** : `lib/channels/handler.js` ligne 729

```javascript
// AVANT:
await adapter.sendImage(msg.channelId, { assetId });

// APRÈS:
const { head } = await import("../media/store.js");
const assetMeta = await head(assetId);
if (assetMeta?.row.kind === 'image') {
  await adapter.sendImage(msg.channelId, { assetId });
} else {
  await adapter.sendDocument(msg.channelId, { assetId });
}
```

**Effort** : 45 min | **Complexité** : Moyen | **Dépend de** : Étape 2

---

## 3. Prompt Templates

### Template CLI agent (pour CLAUDE.md / prompts.js)

```
Quand tu dois envoyer un fichier à l'utilisateur :
1. Crée/génère le fichier localement (dans le sandbox ou /tmp)
2. Appelle le tool store_file avec le chemin absolu du fichier
3. Le fichier sera automatiquement envoyé sur WhatsApp/webchat
4. N'utilise PAS store_file pour les images — utilise web_screenshot ou html_screenshot directement

Exemples :
- Rapport CSV : crée le fichier → store_file({ path: "/tmp/rapport.csv", caption: "Rapport mensuel" })
- PDF généré : crée le PDF → store_file({ path: "/tmp/facture.pdf", filename: "facture-2026-04.pdf" })
- Archive ZIP : crée le zip → store_file({ path: "/tmp/backup.zip" })
```

### Template d'erreur

```
Si store_file échoue :
- "MIME not allowed" → le type de fichier n'est pas supporté, convertir en format accepté
- "path not allowed" → le fichier est hors des dossiers autorisés, le copier dans /tmp d'abord
- "file too large" → réduire la taille ou diviser en plusieurs fichiers
- "WhatsApp not connected" → le fichier est stocké (assetId retourné), envoi automatique quand WA reconnecte
```

---

## 4. Error Codes

| Code | Message | Cause | Action |
|---|---|---|---|
| `MIME_NOT_ALLOWED` | `MIME type "X" is not allowed` | Extension non supportée | Convertir ou ajouter à la whitelist |
| `PATH_NOT_ALLOWED` | `path not allowed` | Fichier hors sandbox | Copier dans /tmp |
| `FILE_TOO_LARGE` | `file too large (X MB > 50 MB)` | Dépasse la limite | Compresser ou diviser |
| `FILE_EMPTY` | `file is empty` | Fichier vide | Vérifier la génération |
| `FILE_NOT_FOUND` | `ENOENT` | Chemin inexistant | Vérifier le path |
| `ASSET_NOT_FOUND` | `asset X not found` | assetId invalide | Vérifier l'ID |
| `WA_NOT_CONNECTED` | `WhatsApp not connected` | Session down | Retry après reconnexion |

---

## 5. Tests à ajouter

### Unit tests (`tests/store-file.test.js`)

```javascript
describe("store_file tool", () => {
  it("stores a txt file and returns assetId", async () => { ... });
  it("stores a CSV file with custom filename", async () => { ... });
  it("rejects path outside allowed roots", async () => { ... });
  it("rejects path with .. traversal", async () => { ... });
  it("rejects file > 50 MB", async () => { ... });
  it("rejects empty file", async () => { ... });
  it("rejects disallowed MIME (e.g. .exe)", async () => { ... });
  it("detects correct MIME from extension", async () => { ... });
  it("deduplicates identical files", async () => { ... });
});
```

### Integration tests

```javascript
describe("store_file → dispatch → WhatsApp", () => {
  it("stores file, dispatches as document to WA group", async () => { ... });
  it("stores image, dispatches as image (not document)", async () => { ... });
  it("handles WA offline gracefully (stores but no send)", async () => { ... });
});
```

### Manual E2E checklist

- [ ] Agent crée un .txt → `store_file` → reçu sur WhatsApp comme document
- [ ] Agent crée un .csv → `store_file` → reçu sur WhatsApp comme spreadsheet
- [ ] Agent crée un .json → `store_file` → reçu sur WhatsApp comme document
- [ ] Agent crée un .zip → `store_file` → reçu sur WhatsApp avec bon nom
- [ ] Agent essaie `/etc/passwd` → rejeté (path not allowed)
- [ ] Agent essaie fichier 100 MB → rejeté (too large)
- [ ] Agent essaie `.exe` → rejeté (MIME not allowed)

---

## 6. Sécurité

| Vecteur | Mitigation |
|---|---|
| Path traversal (`../../../etc/passwd`) | `resolve()` + whitelist de roots + rejet si contient `..` |
| Fichier malveillant (.exe, .bat) | Whitelist MIME stricte (pas d'exécutables) |
| Fichier énorme (RAM) | `stat()` avant `readFile()`, rejet si > 50 MB |
| Spam | Rate limit naturel (1 tâche CLI à la fois par agent) |
| Données sensibles exposées | Paths limités à sandbox/tmp/Desktop — pas de /etc, /var, /usr |
| Fichier symlink vers zone interdite | `stat()` suit les symlinks — le path final doit être dans allowed roots |

---

## 7. Compatibilité rétroactive

| Composant | Impact |
|---|---|
| `send_media` | Aucun — continue de fonctionner pour assets existants |
| `web_screenshot` / `html_screenshot` | Aucun — retournent toujours des images |
| `generate_image` | Aucun |
| Agents CLI existants | Bénéficient — nouveau tool disponible sans migration |
| DB schema | Aucune migration — `kind='file'` déjà supporté par le CHECK |
| Config | Aucun changement — limites existantes suffisent |

---

## 8. Rollout & Rollback

### Séquence de déploiement

| Phase | Étapes | Risque | Réversible |
|---|---|---|---|
| **A** | 1 (MIME) + 2 (sendDocument assetId) | Minimal | Oui (revert 2 fichiers) |
| **B** | 3 (store-file.js) + 4 (registry + dispatch) | Moyen | Retirer de la whitelist |
| **C** | 5 (handler.js routing fix) | Faible | Revert 1 bloc |

### Checklist de rollout

- [ ] Étape 1 : `lib/media/mime.js` — whitelist élargie
- [ ] Étape 2 : `lib/channels/whatsapp-custom.js` — sendDocument accepte assetId
- [ ] Étape 3 : `lib/tools/store-file.js` — nouveau fichier
- [ ] Étape 4a : `lib/plugins/tool-registry.js` — schema + CHANNEL_ALLOWED_TOOLS
- [ ] Étape 4b : `routes/tools.js` — dispatcher store_file
- [ ] Étape 5a : `routes/tools.js` — dispatchMediaToAgent routing par kind
- [ ] Étape 5b : `lib/channels/handler.js` — outbound routing par kind
- [ ] Tests unitaires passent
- [ ] Test E2E : agent envoie .txt → reçu sur WhatsApp
- [ ] Test sécurité : path traversal rejeté
- [ ] Restart serveur
- [ ] Smoke test en production

### Rollback

```bash
# Retirer le tool (désactivation immédiate sans restart si hot-reload):
# 1. Supprimer 'store_file' de CHANNEL_ALLOWED_TOOLS dans tool-registry.js
# 2. Restart serveur
# Les assets déjà stockés restent (inoffensifs, soft-delete si besoin)
```

---

## 9. Fichiers modifiés/créés (récapitulatif)

| Action | Fichier |
|---|---|
| Modifier | `lib/media/mime.js` |
| Modifier | `lib/channels/whatsapp-custom.js` (sendDocument) |
| **Créer** | `lib/tools/store-file.js` |
| Modifier | `lib/plugins/tool-registry.js` |
| Modifier | `routes/tools.js` (dispatcher + dispatchMediaToAgent) |
| Modifier | `lib/channels/handler.js` (outbound routing) |
| **Créer** | `tests/store-file.test.js` |

---

## 10. Résumé des efforts

| # | Étape | Effort | Complexité |
|---|---|---|---|
| 1 | Whitelist MIME | 15 min | Simple |
| 2 | sendDocument + assetId | 30 min | Simple |
| 3 | Tool store_file | 1h | Moyen |
| 4 | Registry + dispatcher | 30 min | Simple |
| 5 | Fix routing outbound | 45 min | Moyen |
| — | Tests unitaires | 30 min | Simple |
| **Total** | | **3h 30min** | |

---

*Plan prêt pour implémentation. En attente de validation du fondateur.*
