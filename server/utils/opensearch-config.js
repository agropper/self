/**
 * OpenSearch (DO-managed) config: one database per DO account, shared across all knowledge bases.
 * Values are read from NEW-AGENT.txt section "## OpenSearch (DO-managed)" or from env (fallback).
 * No env vars required if NEW-AGENT.txt is configured during provisioning.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NEW_AGENT_PATHS = [
  join(__dirname, '../../NEW-AGENT.txt'),
  join(process.cwd(), 'NEW-AGENT.txt')
];

const SECTION_HEADER = '## OpenSearch (DO-managed)';
const KEY_PATTERN = /^\s*(database_id|endpoint|username|password)\s*:\s*(.+?)\s*$/im;

function parseNewAgentOpenSearchSection() {
  for (const filePath of NEW_AGENT_PATHS) {
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf8');
      const sectionIndex = content.indexOf(SECTION_HEADER);
      if (sectionIndex === -1) continue;
      const nextSection = content.indexOf('\n## ', sectionIndex + 1);
      const section = nextSection === -1
        ? content.slice(sectionIndex)
        : content.slice(sectionIndex, nextSection);
      const out = {};
      for (const line of section.split('\n')) {
        const m = line.match(KEY_PATTERN);
        if (m) out[m[1].trim().toLowerCase().replace('_', '')] = m[2].trim();
      }
      return out;
    } catch (e) {
      continue;
    }
  }
  return null;
}

let cached = null;

function getParsed() {
  if (cached === null) cached = parseNewAgentOpenSearchSection();
  return cached;
}

export function getOpenSearchDatabaseId() {
  const p = getParsed();
  if (p?.databaseid) return p.databaseid;
  return process.env.DO_DATABASE_ID || null;
}

export function getOpenSearchEndpoint() {
  const p = getParsed();
  if (p?.endpoint) return p.endpoint;
  return process.env.OPENSEARCH_ENDPOINT || null;
}

export function getOpenSearchUsername() {
  const p = getParsed();
  if (p?.username) return p.username;
  return process.env.OPENSEARCH_USERNAME || null;
}

export function getOpenSearchPassword() {
  const p = getParsed();
  if (p?.password) return p.password;
  return process.env.OPENSEARCH_PASSWORD || null;
}

/** Returns { databaseId, endpoint, username, password } or null if endpoint not configured. */
export function getOpenSearchConfig() {
  const endpoint = getOpenSearchEndpoint();
  if (!endpoint) return null;
  return {
    databaseId: getOpenSearchDatabaseId(),
    endpoint,
    username: getOpenSearchUsername(),
    password: getOpenSearchPassword()
  };
}
