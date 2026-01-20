Indexing: Ephemeral Spaces Changes (Temporary)
=============================================

Context
-------
We switched to ephemeral DigitalOcean Spaces for KB indexing input. The goal
was to avoid using MinIO paths as mutable KB folder locations and to prevent
datasource churn while keeping the DO KB API as the source of truth. Indexing
is currently broken and will be revisited after provisioning changes.

Changes Made (Summary)
----------------------
1) Keep MinIO paths stable; KB membership is metadata-only.
   - `/api/toggle-file-knowledge-base` now updates `knowledgeBases` on the file
     and does not move objects between root/archived/KB folders when using
     ephemeral Spaces. This keeps file display and PDF page links stable.

2) Per-file datasources in ephemeral Spaces.
   - Each file is copied to a per-file folder in the ephemeral bucket.
   - Folder format: `userId/kbName/kb-src-<encoded-source-key>/filename`.
   - DO datasources point to the folder, not a shared KB folder.
   - Rationale: DO datasource must map 1:1 with a file so removal is possible.

3) Datasource de-duplication and legacy cleanup.
   - During KB update, datasources are indexed by:
     - exact item_path,
     - decoded source key from the temp folder,
     - filename.
   - Before creating a new datasource for a file, any duplicates are deleted.
   - When ephemeral Spaces is enabled, legacy datasources under
     `userId/kbName/` that are not per-file folders are deleted. This is to
     prevent multiple temp buckets from accumulating and being re-indexed.

4) KB selection and indexing state use metadata, not bucket paths.
   - `/api/user-files` now returns `kbName` so the UI can use
     `knowledgeBases` to determine in-KB state.
   - `kbIndexedFiles` is updated from DO datasource status and uses decoded
     source keys (from the temp folder) so the UI compares against stable
     MinIO keys.

Files Touched (Primary)
-----------------------
- `server/index.js`
  - Added helpers for temp folder naming/decoding.
  - Adjusted KB update flow to copy files into per-file folders.
  - Added cleanup of stale/legacy datasources when using ephemeral Spaces.
  - Updated indexing state calculation to use metadata rather than KB paths.
- `src/components/MyStuffDialog.vue`
  - `inKnowledgeBase` now derives from `knowledgeBases` + `kbName`.

Why This Was Done
-----------------
- DO KB API does not track if a datasource path still exists in Spaces.
- Ephemeral buckets make old datasource paths stale immediately.
- A single shared folder datasource cannot support per-file removal.
- UI should show files consistently regardless of KB status.

Current Problems Observed
-------------------------
- DO Console shows multiple stale datasources from old temp buckets.
- Indexing jobs report "No changes" but still index stale sources.
- UI Update/Index button remains highlighted due to mismatch between selected
  files and `kbIndexedFiles`.

Next Steps (After Provisioning Changes)
---------------------------------------
- Re-evaluate KB update flow and datasource lifecycle.
- Decide whether to purge all KB datasources and rebuild from current selection.
- Validate index completion updates `kbIndexedFiles` and tokens reliably.

