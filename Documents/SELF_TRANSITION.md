# SELF_TRANSITION

## Current provisioning steps (admin-driven)
1. User registers and requests support (workflowStage: `request_sent`).
2. Pre-provisioning generates agent and KB names; bucket folders created.
3. Initial import (optional) uploads a file into the KB folder.
4. Admin opens provision page and confirms provisioning.
5. Provisioning verifies bucket folders exist.
6. Knowledge base is created (or found) in DO.
7. If initial file exists, datasource is created and indexing starts.
8. Initial file is processed for Lists markdown and categories.
9. Indexing job is monitored to completion (or no-changes).
10. Agent is created and deployed.
11. KB is attached to the agent.
12. Agent config and API key are created.
13. Current medications token is generated.
14. Patient summary is generated.
15. Final verification runs and provisioning completion email is sent.

## KB management (MinIO + ephemeral Spaces)
### Storage layout (source of truth)
- **MinIO (local)** holds all user files and is the permanent source of truth.
- Folder structure mirrors existing bucket logic:
  - `{userId}/` (root)
  - `{userId}/archived/`
  - `{userId}/{kbName}/` (KB folder)
  - `{userId}/Lists/` (derived markdown)

### Indexing flow (ephemeral Spaces)
- When indexing starts, the app creates a **temporary Spaces bucket**.
- It copies **only KB folder files** (`{userId}/{kbName}/...`) into that bucket.
- It creates per-file datasources for those copied objects.
- It starts a DO indexing job.
- After completion, it deletes the datasources and the temporary bucket.

### Adding files to the KB index
1. User checks files in **Saved Files** (moves to `{userId}/{kbName}/`).
2. User clicks **Update and Index KB**.
3. App copies KB folder files into the ephemeral Spaces bucket.
4. Datasources are created and indexing starts.

### Removing files from the KB index
1. User unchecks files in **Saved Files** (moves out of KB folder).
2. User clicks **Update and Index KB**.
3. App indexes only the current KB folder contents.
4. KB should reflect the new, smaller set.

## Suggestions to make indexing less fragile
- **Delay indexing** until the user explicitly requests it (avoid premature indexing).
- **Treat NO_CHANGES as completion** (already done).
- **Use a single source of truth** for indexed files (e.g., snapshot the KB folder at index time).
- **Avoid overwriting kbIndexedFiles** based solely on datasource presence in ephemeral mode.
- **Persist an “index run record”** (runId, bucket name, file list, jobId, status).
- **Use deterministic retry rules** for indexing jobs to avoid duplicate runs.
- **Explicitly log KB index state transitions** (requested → running → completed).
