/**
 * OpenSearch (DO-managed) config: one database per DO account, shared across all knowledge bases.
 * database_id is parsed from env OPENSEARCH_URL (DO dashboard URL, e.g. .../databases/<uuid>?i=...).
 * Used only for KB creation (attach new KBs to existing cluster); no direct OpenSearch access.
 */

/** Match UUID in DO dashboard URL: .../databases/95abbf7a-d15c-4048-a47c-8e20ee31fef5?i=... */
const OPENSEARCH_URL_UUID = /\/databases\/([a-f0-9-]{36})/i;

let cachedDbId = undefined;
let loggedSource = false;

function maskUuid(uuid) {
  if (!uuid || typeof uuid !== 'string') return '(none)';
  const t = uuid.trim();
  if (t.length < 8) return t.length ? '***' : '(empty)';
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}

/**
 * Returns the OpenSearch database UUID (for KB creation).
 * Only source: UUID parsed from env OPENSEARCH_URL (DO database dashboard URL).
 */
export function getOpenSearchDatabaseId() {
  if (cachedDbId !== undefined) {
    return cachedDbId;
  }
  const url = process.env.OPENSEARCH_URL;
  if (!url || typeof url !== 'string') {
    cachedDbId = null;
    if (!loggedSource) {
      console.log('[DO] OpenSearch database_id: not set (OPENSEARCH_URL not set). Set OPENSEARCH_URL to your DO database dashboard URL, e.g. https://cloud.digitalocean.com/databases/<uuid>?i=...');
      loggedSource = true;
    }
    return cachedDbId;
  }
  const m = url.match(OPENSEARCH_URL_UUID);
  cachedDbId = m ? m[1] : null;
  if (!loggedSource) {
    if (cachedDbId) {
      console.log(`[DO] OpenSearch database_id: ${maskUuid(cachedDbId)} (from OPENSEARCH_URL)`);
    } else {
      console.log('[DO] OpenSearch database_id: not set (OPENSEARCH_URL set but no UUID in path). Use URL like https://cloud.digitalocean.com/databases/<uuid>?i=...');
    }
    loggedSource = true;
  }
  return cachedDbId;
}
