# PouchDB / Local Snapshot (Current)

This document tracks the local snapshot behavior for temporary users.

---

## Current Behavior

- On sign‑out of a temporary user, the app saves a local snapshot in IndexedDB.
- Snapshot DB: `maia-user-${userId}`
- `localStorage.maia_last_snapshot_user` stores the last snapshot userId.
- Rehydration prompts the user to re‑upload files to Spaces; KB is re‑indexed on demand.

---

## Notes

- Filtered replication is **not** implemented.
- The server remains the source of truth while live.
