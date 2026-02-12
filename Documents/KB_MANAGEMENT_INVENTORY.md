# KB Management Logic Inventory (Current)

**→ Consolidated in [KB_AND_INDEXING.md](./KB_AND_INDEXING.md). The following is kept for reference.**

This document summarizes the current KB management logic. Per‑file datasources are
no longer used; the KB uses a **single folder datasource**.

---

## Key Principles

- **Spaces folder membership is the source of truth** for “in KB”.
- **Indexing is KB‑level**, not per‑file.
- **Server persists canonical indexing status** in `userDoc.kbIndexingStatus` for UI.

---

## Operations

### File Membership
- Files are moved between:
  - `userId/` (root uploads)
  - `userId/archived/`
  - `userId/<kbName>/` (KB folder)
- `/api/toggle-file-knowledge-base` moves files into/out of the KB folder.

### Indexing
- `/api/update-knowledge-base` starts indexing on the **single folder datasource**.
- Background polling (`runPoll`) persists status to `userDoc.kbIndexingStatus`.
- UI uses `kbIndexingStatus` from `/api/user-files` as the canonical status.

### Attachment
- KB attachment is automatic once both:
  - agent is ready (endpoint set), and
  - `kbIndexingStatus.backendCompleted` is true.

---

## Key User Document Fields (Current)

- `kbId`, `kbName`
- `kbIndexingStatus` (server‑canonical status snapshot)
- `kbIndexedBucketKeys` (indexed keys list)

---

## DO API Usage (Current)

- `doClient.kb.listDataSources(kbId)` → find folder datasource
- `doClient.indexing.startGlobal(kbId, [dataSourceId])` → start indexing
- `doClient.indexing.listForKB(kbId)` / `getStatus` → status polling

---

For deeper architectural context, see `Documents/KB_MANAGEMENT.md`.
