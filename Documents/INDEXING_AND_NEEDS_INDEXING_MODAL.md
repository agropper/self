# Indexing status and the "Index your records" modal

**→ Consolidated in [KB_AND_INDEXING.md](./KB_AND_INDEXING.md). The following is kept for reference.**

**Saved Files is the source of truth for indexing.** See **INDEXING_SAVED_FILES_SOURCE_OF_TRUTH.md** for the full design, discrepancy handling, and why the previous approach was fragile.

## How indexing is tracked (current)

1. **Saved Files (My Stuff → Saved Files)**  
   - Loads from `GET /api/user-files`.  
   - Display: each file’s “Indexed in Knowledge Base” chip is driven by whether its `bucketKey` is in `kbIndexedBucketKeys` (from the user document, returned in the same response).  
   - The same response includes **indexingState**: `allKbFilesIndexed` (true iff every file with `inKnowledgeBase` is in `kbIndexedBucketKeys`), and `discrepancy` (true when user doc and DO API disagree on whether indexing is complete).  
   - If `indexingState.discrepancy` is true, Saved Files shows a **discrepancy modal** (message + suggested fix).

2. **Wizard (when displayed)**  
   - Uses the same `GET /api/user-files` (with `source=wizard`) and thus the same **indexingState**.  
   - If `indexingState.discrepancy` is true when the wizard is loaded, ChatInterface shows the **same** discrepancy modal (same copy as Saved Files).

3. **“Index your records” (needs-indexing) modal**  
   - **Driven by Saved Files state:** The client fetches `GET /api/user-files` and `GET /api/user-status`. It shows the modal **only** when:
     - `indexingState.allKbFilesIndexed === false` (so Saved Files would show at least one “To be added and indexed”), and  
     - `indexingState.discrepancy === false` (if there’s a discrepancy, the discrepancy modal is shown instead), and  
     - `hasAgent && fileCount > 0` and the usual kbStatus checks from user-status.  
   - So the modal **never** appears when Saved Files would show that all files that should be indexed are indexed.  
   - When the user dismisses with “NOT YET”, the modal is not shown again until the page is reloaded (`needsIndexingPromptDismissedThisSession`).

## Previous fragility (corrected)

- The needs-indexing modal used to depend only on `/api/user-status` and a single `hasFilesInKB` flag. That did **not** match the Saved Files rule (“all in-KB files are in kbIndexedBucketKeys”). So the modal could (1) appear when Saved Files already showed all indexed (e.g. when DO API failed), or (2) **not** appear when Saved Files showed some “To be added and indexed” (e.g. 2 of 3 files indexed).  
- There was no detection or explanation when the **user document** and the **DO API** disagreed (discrepancy).  
- **INDEXING_AND_NEEDS_INDEXING_MODAL.md** previously said the modal “stays in sync with Saved Files” via a user-doc fallback in user-status. That was incomplete: the modal was still not using the same “all KB files indexed” definition as Saved Files. The current implementation fixes this by driving the modal from `indexingState.allKbFilesIndexed` from the same endpoint Saved Files uses.

## Summary

- **Saved Files** is the source of truth; display uses `kbIndexedBucketKeys` from `/api/user-files`; the same response provides `indexingState.allKbFilesIndexed` and `indexingState.discrepancy`.  
- **Needs-indexing modal** is shown only when `!allKbFilesIndexed && !discrepancy` (plus agent/file checks), so it never appears when Saved Files would show all indexed.  
- **Discrepancy** between user doc and DO is surfaced in a dedicated modal in Saved Files and when the wizard is displayed.  
- Dismissing the needs-indexing modal with “NOT YET” suppresses it until reload.
