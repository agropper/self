/** Region used for Spaces (DO_REGION or SPACES_REGION). */
export function getSpacesRegion() {
  return process.env.DO_REGION || process.env.SPACES_REGION || 'tor1';
}

/** Derived Spaces endpoint from region; no env var needed. */
export function getSpacesEndpoint() {
  return `https://${getSpacesRegion()}.digitaloceanspaces.com`;
}

/** Spaces bucket name (see NEW-AGENT.txt). No env var needed. */
export function getSpacesBucketName() {
  return 'maia';
}

export function normalizeStorageEnv() {
  if (!process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID && process.env.SPACES_AWS_ACCESS_KEY_ID) {
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID = process.env.SPACES_AWS_ACCESS_KEY_ID;
  }
  if (!process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY && process.env.SPACES_AWS_SECRET_ACCESS_KEY) {
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY = process.env.SPACES_AWS_SECRET_ACCESS_KEY;
  }

  const endpoint = getSpacesEndpoint();
  const accessKeyId =
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY;
  const region =
    process.env.DO_REGION ||
    process.env.SPACES_REGION ||
    'tor1';

  if (accessKeyId) {
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID = accessKeyId;
  }
  if (secretAccessKey) {
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY = secretAccessKey;
  }
  if (process.env.S3_FORCE_PATH_STYLE === undefined) {
    process.env.S3_FORCE_PATH_STYLE = 'false';
  }

  return {
    backend: 'spaces',
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket: getSpacesBucketName(),
    region
  };
}
