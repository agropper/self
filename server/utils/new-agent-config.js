/**
 * App Platform Settings from NEW-AGENT.txt (## App Platform Settings).
 * DO_REGION and PORT are read from that section; process.env overrides when set.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_AGENT_PATH = path.join(__dirname, '../../NEW-AGENT.txt');

let parsed = null;

function parseAppPlatformSettings() {
  if (parsed !== null) return parsed;
  parsed = {};
  try {
    if (!fs.existsSync(NEW_AGENT_PATH)) return parsed;
    const content = fs.readFileSync(NEW_AGENT_PATH, 'utf8');
    const sectionMatch = content.indexOf('## App Platform Settings');
    if (sectionMatch === -1) return parsed;
    const afterSection = content.slice(sectionMatch + '## App Platform Settings'.length);
    const nextSection = afterSection.search(/\n##\s/m);
    const block = nextSection === -1 ? afterSection : afterSection.slice(0, nextSection);
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) parsed[m[1].trim()] = m[2].trim();
    }
  } catch {
    // ignore
  }
  return parsed;
}

/**
 * DO_REGION: from NEW-AGENT.txt App Platform Settings, else process.env.DO_REGION, else 'tor1'.
 */
export function getDoRegion() {
  const settings = parseAppPlatformSettings();
  return process.env.DO_REGION || settings.DO_REGION || 'tor1';
}

/**
 * PORT: from NEW-AGENT.txt App Platform Settings, else process.env.PORT, else 3001.
 */
export function getPort() {
  const settings = parseAppPlatformSettings();
  const raw = process.env.PORT || settings.PORT || '3001';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 3001;
}
