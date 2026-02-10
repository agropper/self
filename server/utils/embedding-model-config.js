/**
 * Embedding model for KB creation: human-readable name in NEW-AGENT.txt is resolved
 * to a DigitalOcean model UUID at runtime via GET /v2/gen-ai/models.
 * Optional override: DO_EMBEDDING_MODEL_ID in env.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_AGENT_PATH = path.join(__dirname, '../../NEW-AGENT.txt');

let cachedEmbeddingModelUuid = null;
let loggedSource = false;

function isValidUUID(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
}

/**
 * Read NEW-AGENT.txt and return the embedding_model value (trimmed) or null.
 */
export function getEmbeddingModelNameFromNewAgent() {
  try {
    if (!fs.existsSync(NEW_AGENT_PATH)) return null;
    const content = fs.readFileSync(NEW_AGENT_PATH, 'utf8');
    const line = content.split(/\r?\n/).find(l => /^\s*embedding_model\s*:/.test(l));
    if (!line) return null;
    const value = line.replace(/^\s*embedding_model\s*:\s*/, '').trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Resolve embedding model to UUID: use cache, env DO_EMBEDDING_MODEL_ID, or
 * name from NEW-AGENT.txt via DO GenAI models API. Returns UUID or null.
 * @param {object} doClient - DigitalOceanClient instance (with .request())
 */
export async function getEmbeddingModelIdForKb(doClient) {
  if (cachedEmbeddingModelUuid !== null) {
    return cachedEmbeddingModelUuid;
  }

  const envId = process.env.DO_EMBEDDING_MODEL_ID;
  if (envId && isValidUUID(envId)) {
    cachedEmbeddingModelUuid = envId.trim();
    if (!loggedSource) {
      console.log(`[DO] Embedding model: ${cachedEmbeddingModelUuid.slice(0, 8)}... (from DO_EMBEDDING_MODEL_ID)`);
      loggedSource = true;
    }
    return cachedEmbeddingModelUuid;
  }

  const modelName = getEmbeddingModelNameFromNewAgent();
  if (!modelName || !doClient) {
    if (!loggedSource) {
      console.log('[DO] Embedding model: not set (no embedding_model in NEW-AGENT.txt and no DO_EMBEDDING_MODEL_ID). DO may use default.');
      loggedSource = true;
    }
    return null;
  }

  try {
    // Only embedding/knowledge-base models support vectorization; unfiltered list can match wrong model
    const res = await doClient.request('/v2/gen-ai/models?usecases=MODEL_USECASE_KNOWLEDGEBASE');
    const models = res.models || res.data?.models || [];
    const want = modelName.trim().toLowerCase().replace(/\*+$/, '').trim();
    const match = models.find(m => {
      const name = (m.name || '').trim().toLowerCase();
      const inference = (m.inference_name || '').trim().toLowerCase();
      return name.includes(want) || inference.includes(want) ||
        want.includes(name) || want.includes(inference);
    });
    if (match && (match.uuid || match.id) && isValidUUID(match.uuid || match.id)) {
      cachedEmbeddingModelUuid = (match.uuid || match.id).trim();
      if (!loggedSource) {
        console.log(`[DO] Embedding model: ${cachedEmbeddingModelUuid.slice(0, 8)}... (resolved from NEW-AGENT.txt "${modelName}")`);
        loggedSource = true;
      }
      return cachedEmbeddingModelUuid;
    }
  } catch (err) {
    console.warn('[DO] Could not resolve embedding model from API:', err.message);
  }

  if (!loggedSource) {
    console.log(`[DO] Embedding model: not set (no match for "${modelName}" in DO models). Set DO_EMBEDDING_MODEL_ID to override.`);
    loggedSource = true;
  }
  return null;
}
