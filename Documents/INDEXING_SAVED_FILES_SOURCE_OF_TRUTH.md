# Saved Files as source of truth for indexing

**→ Consolidated in [KB_AND_INDEXING.md](./KB_AND_INDEXING.md). The following is kept for reference.**

## Required behavior

1. **Saved Files tab** is the source of truth for indexing. It must be strictly correct based on **User Document** and **DO API**. If there is a **discrepancy** between these two sources, Saved Files must show a **modal** explaining the discrepancy and suggesting a fix.

2. **Wizard (Stage 1 when shown)** must be driven by the same Saved Files state. If there is a discrepancy (the same one that would be shown in Saved Files), that **same modal** must appear when the wizard is displayed.

3. **"Index your records" (needs-indexing) modal** must **never** appear if the Saved Files tab would show that **all files that should be indexed are indexed**. When the needs-indexing modal is dismissed (NOT YET), it must not appear again until the page is reloaded.

---

## Current behavior vs required (why it’s fragile/broken)

### 1. Two different definitions of “indexed”

- **Saved Files (MyStuffDialog)**  
  - Loads from `GET /api/user-files?userId=...&source=saved`.  
  - `indexedFiles` = `result.kbIndexedBucketKeys` (from **user doc** only).  
  - “Indexed in Knowledge Base” = file’s `bucketKey` is in `indexedFiles`.  
  - So Saved Files uses: **user doc** `kbIndexedBucketKeys` as the list of indexed files. It does **not** use DO for that list. It does **not** detect or show any discrepancy between user doc and DO.

- **Needs-indexing modal (ChatInterface)**  
  - Uses **only** `GET /api/user-status`: shows when `hasAgent && fileCount > 0 && (kbStatus === 'none' || kbStatus === 'not_attached' || !hasFilesInKB)`.  
  - `hasFilesInKB` is derived from **DO API** (`listDataSources` → folder datasource → `last_datasource_indexing_job`) with a **fallback** to user doc (`backendCompleted` or non-empty `kbIndexedBucketKeys`).  
  - So the modal does **not** use the same rule as Saved Files. Saved Files’ rule is: **“all files that should be indexed are indexed”** = every file with `inKnowledgeBase` has its `bucketKey` in `kbIndexedBucketKeys` (a per-file check over the file list). user-status has no file list; it only has a single boolean `hasFilesInKB`.  
  - **Bug:** If 3 files are in KB and only 2 are in `kbIndexedBucketKeys`, Saved Files would show one “To be added and indexed”. We **should** show the needs-indexing modal. But `hasFilesInKB` can be true (because `kbIndexedBucketKeys` is non-empty), so we **do not** show the modal. So the modal can **fail to show** when it should.  
  - **Bug (partially fixed):** When DO failed (e.g. 404), `hasFilesInKB` was false even when user doc had indexed keys; we added a fallback so we don’t show the modal in that case. So the modal no longer appears when Saved Files already shows all indexed **in that scenario**, but the modal is still not driven by “all KB files indexed” in the Saved Files sense.

### 2. No discrepancy detection or modal

- **User doc** has: `kbIndexedBucketKeys`, `kbIndexingStatus.backendCompleted`.  
- **DO API** gives: folder datasource’s `last_datasource_indexing_job` (and thus `kbIndexedDataSourceCount` in user-files).  
- These can disagree (e.g. DO 404 vs user doc with keys; or DO job done but user doc not updated). Today we **never** detect this or show a modal. So Saved Files is not “strictly correct” in the sense of “we show when user doc and DO disagree”.

### 3. Wizard not driven by Saved Files; no discrepancy on open

- The wizard fetches `/api/user-status` and `/api/user-files?source=wizard`.  
- It uses `filesResult.kbIndexedBucketKeys` (user doc) and `filesResult.kbIndexedDataSourceCount` (DO) for different purposes. It is **not** explicitly driven by the same “indexing state” as Saved Files, and it does **not** show any discrepancy modal when opened.

### 4. INDEXING_AND_NEEDS_INDEXING_MODAL.md – inaccuracies

- The doc says the modal “stays in sync with Saved Files” after the server fallback. That is **incomplete**: the modal uses a **single** `hasFilesInKB` flag, not the Saved Files rule (“every in-KB file in kbIndexedBucketKeys”). So the modal can still **not** show when Saved Files would show “To be added and indexed” (e.g. partial indexing).  
- The doc does **not** say that Saved Files is the **single source of truth** or that the modal should be driven by the **same** “all KB files indexed” check as Saved Files.  
- The doc does **not** mention discrepancy between user doc and DO or a dedicated discrepancy modal.

---

## Suggested fix (high level)

1. **Single canonical state from `/api/user-files`**  
   - In the same response that Saved Files uses, add an **indexing state** object:
     - **allKbFilesIndexed:** `true` iff every file with `inKnowledgeBase` (bucketKey in KB folder) has `bucketKey` in `kbIndexedBucketKeys`. This is exactly the condition under which Saved Files would show **no** “To be added and indexed” for in-KB files.
     - **discrepancy:** `true` when (user doc says “we have indexed data”: `kbIndexedBucketKeys.length > 0` or `kbIndexingStatus?.backendCompleted`) differs from (DO says “indexing job completed”: e.g. `kbIndexedDataSourceCount > 0` or folder datasource has `last_datasource_indexing_job`).
     - When `discrepancy` is true, include **discrepancyMessage** and **suggestedFix** (e.g. “Indexing state in your account doesn’t match the server. Re-run indexing from Saved Files (INDEX NOW) or refresh the page.”).

2. **Saved Files tab**  
   - After loading files, if the response has `indexingState.discrepancy === true`, show a **discrepancy modal** (message + suggested fix). No other UI change for “indexed” chips: keep using `kbIndexedBucketKeys` from the response (user doc) so display stays consistent.

3. **Wizard (when shown)**  
   - When the wizard is displayed (e.g. on open or when entering stage 1), obtain the same indexing state (e.g. from the same `/api/user-files` call the wizard already uses, or from a dedicated lightweight endpoint that returns this state). If `indexingState.discrepancy === true`, show the **same** discrepancy modal as Saved Files.

4. **Needs-indexing modal**  
   - **Stop** using only `/api/user-status` to decide whether to show.  
   - Before showing: fetch the **same** indexing state (e.g. from `/api/user-files` or the new indexing-state endpoint).  
   - Show the needs-indexing modal **only** when:  
     - `!indexingState.allKbFilesIndexed` (so Saved Files would show at least one “To be added and indexed”), and  
     - `!indexingState.discrepancy` (if there’s a discrepancy, show the discrepancy modal instead, not needs-indexing), and  
     - `hasAgent && fileCount > 0` (and optionally existing kbStatus checks).  
   - When the user dismisses with NOT YET: keep current behavior (do not show again until page reload).

5. **Docs**  
   - Update **INDEXING_AND_NEEDS_INDEXING_MODAL.md** to state that:  
     - Saved Files is the **source of truth**; “all files that should be indexed are indexed” is defined as **allKbFilesIndexed** (every in-KB file in `kbIndexedBucketKeys`).  
     - The needs-indexing modal must use that **same** definition via the user-files (or indexing-state) response, not only user-status.  
     - Discrepancy between user doc and DO is detected and shown in a dedicated modal in Saved Files and when opening the wizard.

---

## Implementation checklist

- [ ] **Server:** In `GET /api/user-files`, compute and return `indexingState: { allKbFilesIndexed, discrepancy, discrepancyMessage?, suggestedFix? }` using user doc + DO (same data already loaded for the response).
- [ ] **MyStuffDialog:** After `loadFiles()`, if `indexingState.discrepancy`, show discrepancy modal (new dialog + copy).
- [ ] **ChatInterface (wizard):** When wizard is shown (e.g. when opening setup wizard or entering stage 1), if the user-files (or state) response has `indexingState.discrepancy`, show the same discrepancy modal.
- [ ] **ChatInterface (needs-indexing):** Change `checkAndShowNeedsIndexingPrompt` to fetch indexing state from `/api/user-files` (or new endpoint); show needs-indexing only when `!allKbFilesIndexed && !discrepancy && hasAgent && fileCount > 0` (and existing guards). Keep session dismiss (NOT YET) until reload.
- [ ] **Docs:** Update INDEXING_AND_NEEDS_INDEXING_MODAL.md per above; add reference to this document for Saved Files as source of truth and discrepancy handling.
