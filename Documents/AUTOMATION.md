

## Automation / Workflow Stages (Current)

This document is now a short reference. Detailed, current behavior lives in
`server/index.js` and `server/routes/auth.js`.

---

## Current Workflow Stages

- `null` – initial state on registration
- `approved` – admin provisioning started
- `agent_named` – agent created
- `agent_deployed` – agent running
- `files_stored` – files exist in user doc
- `files_archived` – files moved to archived
- `indexing` – KB indexing active
- `patient_summary` – summary saved

---

## Current Notes

- KB attachment is automatic when the agent is ready and indexing is complete.
- KB status is persisted in `userDoc.kbIndexingStatus` for UI.

See `Documents/WORKFLOW_STAGES_IMPLEMENTATION.md` for exact code paths.
