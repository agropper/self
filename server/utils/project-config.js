/**
 * DigitalOcean project ID for GenAI (agents, knowledge bases).
 * When DO_PROJECT_ID is not set, the app discovers the default or first project
 * via GET /v2/projects/default or GET /v2/projects. Optional env override: DO_PROJECT_ID.
 */

let cachedProjectId = null;
let loggedSource = false;

function isValidUUID(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
}

/**
 * Resolve GenAI project ID: use cache, env DO_PROJECT_ID, or DO API (default/first project).
 * @param {object} doClient - DigitalOceanClient instance (with .request())
 * @returns {Promise<string|null>} Project UUID or null
 */
export async function getProjectIdForGenAI(doClient) {
  if (cachedProjectId !== null) {
    return cachedProjectId;
  }

  const envId = process.env.DO_PROJECT_ID;
  if (envId && isValidUUID(envId)) {
    cachedProjectId = envId.trim();
    if (!loggedSource) {
      console.log(`[DO] Project ID: ${cachedProjectId.slice(0, 8)}... (from DO_PROJECT_ID)`);
      loggedSource = true;
    }
    return cachedProjectId;
  }

  if (!doClient) {
    return null;
  }

  try {
    const defaultRes = await doClient.request('/v2/projects/default');
    const project = defaultRes.project || defaultRes;
    const id = project?.id || project?.uuid;
    if (id && isValidUUID(id)) {
      cachedProjectId = id.trim();
      if (!loggedSource) {
        console.log(`[DO] Project ID: ${cachedProjectId.slice(0, 8)}... (from API default project)`);
        loggedSource = true;
      }
      return cachedProjectId;
    }
  } catch {
    // Fall through to list
  }

  try {
    const listRes = await doClient.request('/v2/projects');
    const projects = listRes.projects || listRes.data?.projects || [];
    const first = projects[0];
    const id = first?.id || first?.uuid;
    if (id && isValidUUID(id)) {
      cachedProjectId = id.trim();
      if (!loggedSource) {
        console.log(`[DO] Project ID: ${cachedProjectId.slice(0, 8)}... (from API first project)`);
        loggedSource = true;
      }
      return cachedProjectId;
    }
  } catch (err) {
    console.warn('[DO] Could not resolve project ID from API:', err.message);
  }

  if (!loggedSource) {
    console.log('[DO] Project ID: not set. Set DO_PROJECT_ID or ensure the account has a (default) project.');
    loggedSource = true;
  }
  return null;
}
