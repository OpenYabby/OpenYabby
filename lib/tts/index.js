/* ═══════════════════════════════════════════════════════
   YABBY — TTS Manager
   ═══════════════════════════════════════════════════════
   speak(text, opts), getProvider, listVoices.
   Does NOT replace OpenAI Realtime voice. Used for
   notifications, channel audio, standalone TTS.
*/

import { log } from "../logger.js";

const providers = new Map();

// Lazy-load providers
async function getProvider(name) {
  if (providers.has(name)) return providers.get(name);

  let provider;
  switch (name) {
    case "elevenlabs": {
      const { ElevenLabsProvider } = await import("./elevenlabs.js");
      provider = new ElevenLabsProvider();
      break;
    }
    case "edge-tts": {
      const { EdgeTTSProvider } = await import("./edge-tts.js");
      provider = new EdgeTTSProvider();
      break;
    }
    case "openai": {
      const { OpenAITTSProvider } = await import("./openai.js");
      provider = new OpenAITTSProvider();
      break;
    }
    case "system": {
      const { SystemProvider } = await import("./system.js");
      provider = new SystemProvider();
      break;
    }
    default:
      throw new Error(`Unknown TTS provider: ${name}`);
  }

  providers.set(name, provider);
  return provider;
}

export async function speak(text, opts = {}) {
  const providerName = opts.provider || "system";
  const provider = await getProvider(providerName);
  return provider.speak(text, opts);
}

export async function listVoices(providerName = "system") {
  const provider = await getProvider(providerName);
  return provider.listVoices();
}

export function listProviderNames() {
  return ["openai", "elevenlabs", "edge-tts", "system"];
}
