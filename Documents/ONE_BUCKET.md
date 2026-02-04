## One Bucket KB Strategy (Implemented)

The app now uses a **single KB folder datasource** as the only source of truth.
Per‑file datasources are no longer used.

---

## Current Behavior

- KB datasource path: `userId/<kbName>/`
- KB membership: files present in that folder
- Indexing: single job on the folder datasource
- UI status: derived from server‑canonical `kbIndexingStatus`

---

## File Movement

- Uploads land in `userId/`
- KB selection moves files through:
  - `userId/archived/` → `userId/<kbName>/`
- `/api/toggle-file-knowledge-base` performs the move.

---

## Indexing

- `/api/update-knowledge-base` starts indexing on the folder datasource.
- Server polling persists status to `userDoc.kbIndexingStatus`.

---

## UI

- Saved Files and Wizard read status from `/api/user-files`.
- KB indexing is shown at KB level, not per file.
