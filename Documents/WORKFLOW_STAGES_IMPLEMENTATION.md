# Workflow Stages Implementation (Current)

This document summarizes active workflow stages. Exact lines change often; use
`server/index.js` and `server/routes/auth.js` as authoritative sources.

---

## Active Stages

- `null` – initial state at registration
- `approved` – admin provisioning started
- `agent_named` – agent created
- `agent_deployed` – agent running
- `files_stored` – user has files
- `files_archived` – files moved to archived
- `indexing` – KB indexing active
- `patient_summary` – summary saved

---

## Where Stages Are Set

- Registration: `server/routes/auth.js`
- Provisioning: `server/index.js` (`provisionUserAsync`)
- File metadata updates: `server/index.js` (`/api/user-file-metadata`)
- KB indexing: `server/index.js` (`/api/update-knowledge-base`)
- Patient summary: `server/index.js` (`/api/patient-summary`, `/api/generate-patient-summary`)

---

## Contextual Tips

Tips are derived from `NEW-AGENT.txt` and UI state in `ChatInterface.vue`.

