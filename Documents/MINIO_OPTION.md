## MinIO Option

We previously introduced a MinIO-backed storage option to reduce persistent DigitalOcean Spaces costs. In that setup, MinIO held the primary files and we used ephemeral Spaces buckets only during indexing. The goal was to avoid paying for long-lived Spaces storage while still using the DigitalOcean KB API.

We removed this option because it became overly complicated for the benefit and could fail in multi-user scenarios. The extra operational steps around ephemeral buckets, per-file datasources, and cleanup added risk and increased the chance of a mismatch between storage and the KB.

Going forward, we always use DigitalOcean Spaces directly (no MinIO). The Docker container now holds only CouchDB.
