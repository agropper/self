/**
 * Ensure CouchDB droplet exists on DigitalOcean.
 * Creates ubuntu-s-1vcpu-1gb-tor1-01 if missing.
 * Password is derived deterministically from DIGITALOCEAN_TOKEN via HMAC —
 * no need to store credentials in Spaces or local files.
 */

import { createHmac } from 'crypto';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSpacesEndpoint, getSpacesBucketName } from './storage-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DROPLET_NAME = 'ubuntu-s-1vcpu-1gb-tor1-01';
const REGION = 'tor1';
const SIZE = 's-1vcpu-1gb';
const IMAGE = 'ubuntu-22-04-x64';
const COUCHDB_PORT = 5984;

/**
 * Derive CouchDB admin password deterministically from the DIGITALOCEAN_TOKEN.
 * HMAC-SHA256(token, "maia-couchdb-admin") → base64url (32 chars).
 * Same token always produces same password; no storage needed.
 */
function derivePassword(token) {
  return createHmac('sha256', token)
    .update('maia-couchdb-admin')
    .digest('base64url')
    .slice(0, 32);
}

async function doRequest(token, method, path, body = null) {
  const url = `https://api.digitalocean.com${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO API ${method} ${path}: ${res.status} - ${text}`);
  }
  // DELETE returns 204 with no body
  if (res.status === 204) return {};
  return res.json();
}

async function listDroplets(token) {
  const data = await doRequest(token, 'GET', '/v2/droplets');
  return data.droplets || [];
}

async function createDroplet(token, userData) {
  const body = {
    name: DROPLET_NAME,
    region: REGION,
    size: SIZE,
    image: IMAGE,
    user_data: userData
  };
  const data = await doRequest(token, 'POST', '/v2/droplets', body);
  return data.droplet;
}

async function getDroplet(token, dropletId) {
  const data = await doRequest(token, 'GET', `/v2/droplets/${dropletId}`);
  return data.droplet;
}

function getDropletIp(droplet) {
  const nets = droplet?.networks?.v4 || [];
  const pub = nets.find(n => n.type === 'public');
  return pub?.ip_address || null;
}

function buildUserData(password) {
  const escaped = password.replace(/'/g, "'\\''");
  return `#!/bin/bash
set -e
apt-get update
apt-get install -y docker.io
systemctl enable --now docker
docker run -d --name couchdb --restart unless-stopped -p ${COUCHDB_PORT}:${COUCHDB_PORT} \\
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD='${escaped}' \\
  -v couchdb_data:/opt/couchdb/data \\
  couchdb:3
`;
}

async function waitForIp(token, dropletId, maxWaitMs = 120000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const droplet = await getDroplet(token, dropletId);
    const ip = getDropletIp(droplet);
    if (ip) return ip;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Droplet ${dropletId} did not get an IP within ${maxWaitMs / 1000}s`);
}

async function waitForCouchDBReady(url, maxWaitMs = 180000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${url}/`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`CouchDB at ${url} did not become ready within ${maxWaitMs / 1000}s`);
}

export async function ensureCouchDBDroplet() {
  const token = process.env.DIGITALOCEAN_TOKEN;
  if (!token) {
    throw new Error('DIGITALOCEAN_TOKEN is required for CouchDB droplet');
  }

  const password = derivePassword(token);
  const existing = await listDroplets(token);
  const droplet = existing.find(d => d.name === DROPLET_NAME);

  if (droplet) {
    const ip = getDropletIp(droplet);
    if (!ip) {
      throw new Error(`CouchDB droplet "${DROPLET_NAME}" has no public IP yet`);
    }
    const url = `http://${ip}:${COUCHDB_PORT}`;
    process.env.CLOUDANT_URL = url;
    process.env.CLOUDANT_USERNAME = 'admin';
    process.env.CLOUDANT_PASSWORD = password;
    console.log(`[CouchDB Droplet] Found existing droplet "${DROPLET_NAME}" at ${url} (password derived from token)`);
    return;
  }

  // No droplet — create one with the derived password
  console.log(`[CouchDB Droplet] No droplet found, creating "${DROPLET_NAME}"...`);
  const userData = buildUserData(password);
  const created = await createDroplet(token, userData);
  console.log(`[CouchDB Droplet] Created droplet "${DROPLET_NAME}" (id: ${created.id}), waiting for IP...`);
  const ip = await waitForIp(token, created.id);
  const url = `http://${ip}:${COUCHDB_PORT}`;
  process.env.CLOUDANT_URL = url;
  process.env.CLOUDANT_USERNAME = 'admin';
  process.env.CLOUDANT_PASSWORD = password;
  waitForCouchDBReady(url).then(() => {
    console.log(`[CouchDB Droplet] CouchDB ready at ${url}`);
  }).catch((err) => {
    console.warn(`[CouchDB Droplet] CouchDB readiness wait failed:`, err.message);
  });
  console.log(`[CouchDB Droplet] Password derived from DIGITALOCEAN_TOKEN — no credentials file needed`);
}
