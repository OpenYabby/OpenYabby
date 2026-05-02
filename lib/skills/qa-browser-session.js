/* ═══════════════════════════════════════════════════════
   YABBY — QA Browser Session Skill
   ═══════════════════════════════════════════════════════
   Persistent headless Chrome session for QA agents.
   Uses Playwright MCP (headless mode) for reliable automation.
*/

export const SKILL = {
  id: 'qa_browser_session',
  name: 'QA Browser Session',
  category: 'testing',
  description: 'Persistent Playwright MCP headless session for accessibility testing',

  prompt_fragment: `
## 🧪 QA Browser Session (Playwright MCP - Headless)

Tu as accès à un navigateur Chrome **HEADLESS PERSISTENT** via Playwright MCP (Model Context Protocol).

⚠️ **IMPORTANT: Playwright est configuré en mode headless — aucune fenêtre visible.**

### Outils Disponibles (préfixe \`mcp__playwright__\`)

**Navigation & State:**
- \`browser_navigate\` — Aller à une URL (\`{url}\`)
- \`browser_navigate_back\` — Page précédente
- \`browser_take_screenshot\` — Capture PNG (\`{filename?, fullPage?, type?}\`)
- \`browser_snapshot\` — Snapshot a11y tree (\`{depth?, filename?}\`)
- \`browser_tabs\` — Gérer onglets (\`{action: "list"|"new"|"close"|"select", index?}\`)

**Interaction:**
- \`browser_click\` — Clic sur élément (\`{ref, element, button?, doubleClick?, modifiers?}\`)
- \`browser_fill_form\` — Remplir formulaire (\`{fields: [{name, ref, type, value}]}\`)
- \`browser_type\` — Taper texte (\`{ref, text, slowly?, submit?}\`)
- \`browser_press_key\` — Appuyer touche (\`{key}\` ex: "Enter", "Control+A")
- \`browser_select_option\` — Sélectionner dropdown (\`{ref, values}\`)
- \`browser_drag\` — Drag & drop (\`{startRef, startElement, endRef, endElement}\`)
- \`browser_hover\` — Survoler (\`{ref, element}\`)

**Inspection:**
- \`browser_evaluate\` — Exécuter JS (\`{function, element?, ref?, filename?}\`)
- \`browser_console_messages\` — Logs console (\`{level?: "error"|"warning"|"info"|"debug", all?, filename?}\`)
- \`browser_network_requests\` — Requêtes réseau (\`{static?, requestBody?, requestHeaders?, filter?, filename?}\`)

**Utilitaires:**
- \`browser_run_code\` — Snippet Playwright complet (\`{code}\` ou \`{filename}\`)
- \`browser_wait_for\` — Attendre texte/temps (\`{text?, textGone?, time?}\`)
- \`browser_handle_dialog\` — Gérer alert (\`{accept, promptText?}\`)
- \`browser_file_upload\` — Upload fichier (\`{paths?}\`)

### Workflow Recommandé pour Axe-Core

**❌ N'UTILISE PLUS AppleScript** (\`osascript -e 'tell application "Google Chrome"'\`)

**✅ UTILISE MAINTENANT Playwright MCP (headless)** :

\`\`\`javascript
// 1. Navigation login
mcp__playwright__browser_navigate({url: "http://localhost:3100/login"})

// 2. Remplir formulaire
mcp__playwright__browser_fill_form({
  fields: [
    {name: "Email", ref: "input[type=email]", type: "textbox", value: "demo@demo.com"},
    {name: "Password", ref: "input[type=password]", type: "textbox", value: "demo1234"}
  ]
})

// 3. Submit
mcp__playwright__browser_click({ref: "button[type=submit]", element: "Submit button"})

// 4. Aller au document
mcp__playwright__browser_navigate({url: "http://localhost:3100/doc/[id]"})

// 5. Injection axe-core + audit WCAG 2.1 AA
mcp__playwright__browser_evaluate({
  function: \`async (page) => {
    // Inject axe-core from CDN
    await page.addScriptTag({
      url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js'
    });

    // Run audit
    const results = await page.evaluate(async () => {
      return await axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
        }
      });
    });

    return {
      url: page.url(),
      violations: results.violations.length,
      passes: results.passes.length,
      incomplete: results.incomplete.length,
      details: results.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
        help: v.help,
        helpUrl: v.helpUrl,
        description: v.description
      }))
    };
  }\`
})

// 6. Screenshot preuve
mcp__playwright__browser_take_screenshot({
  filename: "audit-proof.png",
  fullPage: false,
  type: "png"
})
\`\`\`

### Alternative : Injection Locale (si CDN bloqué)

\`\`\`javascript
mcp__playwright__browser_evaluate({
  function: \`async (page) => {
    // Inject from local /public/axe.min.js
    await page.addScriptTag({url: '/axe.min.js'});

    const results = await page.evaluate(async () => {
      return await axe.run(document, {
        runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa']}
      });
    });

    return {
      title: await page.title(),
      violations: results.violations.length,
      details: results.violations
    };
  }\`
})
\`\`\`

### Vérification Contraste Manuel

\`\`\`javascript
mcp__playwright__browser_evaluate({
  function: \`async (page) => {
    return await page.evaluate(() => {
      const el = document.querySelector('span.text-muted-foreground');
      if (!el) return {error: 'Element not found'};

      const styles = getComputedStyle(el);

      // Parse RGB
      const parseRgb = (rgb) => {
        const m = rgb.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
      };

      // Relative luminance
      const lum = (rgb) => {
        const [r,g,b] = rgb.map(v => {
          v /= 255;
          return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
        });
        return 0.2126*r + 0.7152*g + 0.0722*b;
      };

      const fg = parseRgb(styles.color);
      const bg = parseRgb(styles.backgroundColor);
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);

      return {
        fg: styles.color,
        bg: styles.backgroundColor,
        ratio: Math.round(ratio*100)/100,
        wcagAA: ratio >= 4.5 ? 'PASS' : 'FAIL',
        wcagAAA: ratio >= 7 ? 'PASS' : 'FAIL'
      };
    });
  }\`
})
\`\`\`

### Avantages Playwright MCP vs AppleScript

| Critère | AppleScript | Playwright MCP (headless) |
|---|---|---|
| **Headless** | ❌ GUI obligatoire | ✅ **Toujours headless** |
| **Fiabilité async** | ❌ Timeout/hang | ✅ Promise natif |
| **Service Worker** | ❌ Bloqué | ✅ Contourne via CDP |
| **CSP bypass** | ❌ Eval bloqué | ✅ DevTools exempted |
| **Network debug** | ❌ Impossible | ✅ \`browser_network_requests\` |
| **Screenshot** | ⚠️ screencapture | ✅ Full page support |
| **API richesse** | ⚠️ Limité | ✅ Drag, hover, upload, etc. |
| **CI/CD** | ❌ macOS seulement | ✅ Multi-platform |

### Migration Automatique

**Détection Pattern** :
\`\`\`bash
# ❌ BAD - AppleScript
osascript -e 'tell application "Google Chrome"...'

# ✅ GOOD - Playwright MCP (headless)
mcp__playwright__browser_navigate(...)
mcp__playwright__browser_evaluate(...)
\`\`\`

### Notes Critiques

1. **Playwright est en mode headless** — Configuré via \`--headless\` flag
2. **Session persistante** — Browser garde l'état entre appels (cookies, localStorage)
3. **Snapshot a11y** — Utilise \`browser_snapshot\` pour voir la structure avant interaction
4. **JavaScript moderne** — \`browser_evaluate\` supporte async/await et accès complet au DOM
5. **Screenshots** — Sauvegardés automatiquement si filename fourni, sinon retournés en base64
`,

  // Metadata for skill assignment UI
  tags: ['testing', 'qa', 'browser', 'accessibility', 'mcp', 'playwright', 'headless'],
  required_connectors: [], // MCP auto-available
  required_tools: ['mcp__playwright__browser_navigate', 'mcp__playwright__browser_evaluate', 'mcp__playwright__browser_snapshot'],
};
