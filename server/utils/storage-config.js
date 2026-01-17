export function normalizeStorageEnv() {
  const backend = (process.env.STORAGE_BACKEND || '').toLowerCase();
  if (backend !== 'minio') {
    return { backend: backend || 'spaces' };
  }

  const endpoint =
    process.env.MINIO_ENDPOINT_URL ||
    process.env.DIGITALOCEAN_ENDPOINT_URL ||
    'http://localhost:9000';
  const accessKeyId =
    process.env.MINIO_ACCESS_KEY_ID ||
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.MINIO_SECRET_ACCESS_KEY ||
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY;
  const bucket =
    process.env.MINIO_BUCKET ||
    process.env.DIGITALOCEAN_BUCKET;
  const region =
    process.env.MINIO_REGION ||
    process.env.DO_REGION ||
    'us-east-1';

  if (!process.env.DIGITALOCEAN_ENDPOINT_URL && endpoint) {
    process.env.DIGITALOCEAN_ENDPOINT_URL = endpoint;
  }
  if (!process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID && accessKeyId) {
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID = accessKeyId;
  }
  if (!process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY && secretAccessKey) {
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY = secretAccessKey;
  }
  if (!process.env.DIGITALOCEAN_BUCKET && bucket) {
    process.env.DIGITALOCEAN_BUCKET = bucket;
  }
  if (!process.env.DO_REGION && region) {
    process.env.DO_REGION = region;
  }
  if (!process.env.S3_FORCE_PATH_STYLE) {
    process.env.S3_FORCE_PATH_STYLE = 'true';
  }

  return {
    backend: 'minio',
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region
  };
}
