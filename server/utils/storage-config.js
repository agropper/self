export function normalizeStorageEnv() {
  if (!process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID && process.env.SPACES_AWS_ACCESS_KEY_ID) {
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID = process.env.SPACES_AWS_ACCESS_KEY_ID;
  }
  if (!process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY && process.env.SPACES_AWS_SECRET_ACCESS_KEY) {
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY = process.env.SPACES_AWS_SECRET_ACCESS_KEY;
  }

  const endpoint =
    process.env.DIGITALOCEAN_ENDPOINT_URL ||
    process.env.SPACES_ENDPOINT_URL ||
    'https://tor1.digitaloceanspaces.com';
  const accessKeyId =
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY;
  const bucket =
    process.env.DIGITALOCEAN_BUCKET;
  const region =
    process.env.DO_REGION ||
    process.env.SPACES_REGION ||
    'tor1';

  if (endpoint) {
    process.env.DIGITALOCEAN_ENDPOINT_URL = endpoint;
  }
  if (accessKeyId) {
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID = accessKeyId;
  }
  if (secretAccessKey) {
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY = secretAccessKey;
  }
  if (bucket) {
    process.env.DIGITALOCEAN_BUCKET = bucket;
  }
  if (process.env.S3_FORCE_PATH_STYLE === undefined) {
    process.env.S3_FORCE_PATH_STYLE = 'false';
  }

  return {
    backend: 'spaces',
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region
  };
}
