/* ═══════════════════════════════════════════════════════
   YABBY — Built-in Connector Base Class
   ═══════════════════════════════════════════════════════
   Each built-in connector extends this and provides:
   - getTools() → OpenAI function-calling schemas
   - executeTool(name, args) → string result
*/

export class BuiltinConnector {
  constructor(credentials) {
    this.credentials = credentials;
  }

  /** Returns array of tool definitions (OpenAI function-calling format) */
  getTools() {
    return [];
  }

  /** Execute a tool call. Returns a string result for the voice model. */
  async executeTool(toolName, args) {
    throw new Error(`Tool ${toolName} not implemented`);
  }

  /** Helper: HTTP request with auth */
  async _fetch(url, options = {}) {
    const resp = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...this._authHeaders(),
        ...(options.headers || {}),
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }
    return resp.json();
  }

  /** Override in subclass to add auth headers */
  _authHeaders() {
    return {};
  }

  /** Test that credentials are valid (lightweight check) */
  async testCredentials() {
    throw new Error("testCredentials not implemented");
  }
}
