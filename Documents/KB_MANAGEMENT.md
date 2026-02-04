## KB Management Source of Truth (Current)

This document describes the **current** KB architecture.
It supersedes prior per‑file datasource guidance.

---

## Current Architecture

- **Single folder datasource** per KB: `userId/<kbName>/`
- **KB membership** is determined by object placement in that folder.
- **Indexing is KB‑level** on the folder datasource.
- **Server persists canonical status** in `userDoc.kbIndexingStatus` for UI.

---

## Flow Summary

1. **Upload files** to root (`userId/<filename>`).
2. **Toggle KB membership** via `/api/toggle-file-knowledge-base`:
   - `root → archived → kbFolder`
3. **Start indexing** via `/api/update-knowledge-base`:
   - Starts a single KB indexing job.
4. **Poll status** server‑side:
   - `runPoll` persists status to `userDoc.kbIndexingStatus`.
5. **Attach KB to agent** when:
   - agent endpoint exists, and
   - `kbIndexingStatus.backendCompleted === true`.

---

## Canonical Status Fields

- `userDoc.kbIndexingStatus`
  - server‑canonical snapshot used by the UI
- `userDoc.kbIndexedBucketKeys`
  - list of indexed keys
- `kbId`, `kbName`

---

## Primary Endpoints

- `GET /api/user-files?source=wizard`
  - returns file list + `kbIndexingStatus`
- `POST /api/toggle-file-knowledge-base`
  - moves files into/out of KB folder
- `POST /api/update-knowledge-base`
  - starts indexing job

---

## Notes

- DO API remains the authoritative backend; the server stores status so the UI is consistent.
- UI polling reads from the server, not directly from DO.
