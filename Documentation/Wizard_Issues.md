# Wizard Issues: Current State and Restructuring Plan

**Date:** 2026-07-02
**Version at time of writing:** 1.4.61
**Related docs:** `Wizards.md` (lifecycle flows), `Wizards2.md` (API inventory)

---

## 1. The Problem

The Setup Wizard is the most bug-prone part of the MAIA codebase. Every release
cycle produces UI-state bugs where the wizard's visual indicators (spinners,
orange borders, green checkmarks, elapsed timers) disagree with what actually
happened. The maia-log PDF captures the correct sequence of events, but the
on-screen UI tells a different story.

Recent examples (v1.4.54 -- v1.4.58):

- **Elapsed timer killed prematurely:** `refreshWizardState()` called from 15+
  places; one call site stopped the timer during Draft PS generation because it
  checked `indexingStatus.phase !== 'indexing'` without guarding for the
  preparation phase.
- **Indexing spinner persists after completion:** `handleIndexingFinished` didn't
  clear the polling interval ref (`stage3IndexingPoll`), so the computed
  `stage3IndexingActive` stayed true even though the server reported completion.
- **Orange "My Lists" border persists after setup complete:** The
  `medsNeedsVerify` computed checked server-derived state
  (`userResourceStatus.hasCurrentMedications`) independently of the wizard flow.
  A stale server response could override the in-memory completion flag.
- **Wizard spinner ring persists after setup complete:** Same root cause -- the
  `wizardActive` computed checked server-derived state without consulting the
  definitive in-memory `wizardPatientSummary` flag.

All of these share a common root cause: **there is no single source of truth for
wizard state.** Instead, multiple refs, computeds, server responses, localStorage
entries, and sessionStorage flags each hold a partial view, and they can
disagree.

---

## 2. Current Architecture (Why It's Fragile)

### 2.1 Scale of the Problem

The wizard implementation spans ~1,000+ lines across an 8,500-line single file
(`ChatInterface.vue`), with additional UI in `MyStuffDialog.vue` (7,400 lines).
The code audit found:

| Category | Count |
|----------|-------|
| Wizard-related refs (reactive state variables) | 55+ |
| Assignments to `wizardFlowPhase` | 11 |
| Call sites for `refreshWizardState()` | 23+ |
| Computed properties derived from wizard state | 14 |
| Watchers observing wizard state | 12 |
| Timers/intervals (setInterval + setTimeout) | 11 |
| Event channels between ChatInterface and MyStuffDialog | 8+ |

### 2.2 Three Competing State Systems

The wizard's visible state is driven by three independent systems that can
disagree:

**A. In-memory refs (session-local)**

These are the "source of truth" for the guided flow:

- `wizardFlowPhase` -- `'running'` | `'medications'` | `'summary'` | `'done'`
- `wizardPatientSummary` -- true when the user clicks Verify on Patient Summary
- `wizardCurrentMedications` -- true when the user clicks Verify on Medications
- `wizardStage1Complete` -- true when the agent is deployed
- `wizardDraftPsStatus` -- `'idle'` | `'running'` | `'done'` | `'failed'`

These are set by direct user actions (clicking Verify, completing deployment).
They are always correct in the moment.

**B. Server-derived state (async, can lag)**

`userResourceStatus` is an object rebuilt from `/api/user-status` responses by
two different functions:

- `refreshWizardState()` (line 2882) -- fetches 3 endpoints in parallel, rebuilds
  the entire object
- `updateContextualTip()` (line 7876) -- fetches 1 endpoint, also rebuilds the
  entire object

Both functions overwrite `userResourceStatus` with a fresh object. If the server
hasn't persisted a change yet (CouchDB conflict, write lag), the new object
reverts a field that was optimistically set to `true` back to `false`.

UI elements driven by `userResourceStatus`:

- `medsNeedsVerify` (orange border on My Lists) -- checks `hasCurrentMedications`
- `wizardActive` (yellow spinner ring) -- checks `hasPatientSummary`,
  `kbIndexingActive`, `workflowStage`
- `isRequestSent` (request-sent modal) -- checks `workflowStage`

**C. Persisted state (localStorage / sessionStorage)**

- `localStorage[wizardUserStorageKey]` -- JSON with `stage2Complete`,
  `stage3Complete`, `stage4Complete`; OR-merged into refs on reload
- `sessionStorage['wizardSetupCompleted']` -- prevents reload recovery from
  re-entering the guided flow
- `sessionStorage['autoProcessInitialFile']` -- triggers auto-processing on reload
- `sessionStorage[agentSetupKey]` -- persists deployment start timestamp

These survive page reloads but not browser restarts (sessionStorage) or
cross-device (both). They can become stale if the server state changes
independently (e.g., admin action).

### 2.3 The Overwrite Problem

The core fragility is that `refreshWizardState()` and `updateContextualTip()`
both **replace the entire `userResourceStatus` object** every time they run.
Each function fetches from the server, builds a new object, and assigns it.

If an optimistic update set `hasCurrentMedications = true` at 5:14:32 PM, and
`refreshWizardState()` fires at 5:14:33 PM but the server response was fetched
at 5:14:32.5 PM (before the save propagated), the optimistic update is lost.

The current mitigations are fragile:

- `priorHasPatientSummary` preservation (line 2881) -- only covers one field
- Optimistic update in `handleMyStuffMedsSaved` (line 7700) -- overwritten by
  the next `refreshWizardState()` call
- `inGuidedFlow` guard (line 2982) -- prevents auto-setting
  `wizardPatientSummary` during guided flow, but doesn't prevent the
  `userResourceStatus` overwrite that affects `wizardActive`

### 2.4 Implicit State Machine

`wizardFlowPhase` is the closest thing to a state machine, but:

- It's set from 11 different places across the file
- There's no validation that transitions are legal (e.g., nothing prevents
  going from `'done'` back to `'running'`)
- The reload recovery logic (line 6865) reconstructs the phase from server
  state, which may not match what the user actually did
- The dismiss-count logic (line 8010) adds a hidden sub-state that isn't
  reflected in `wizardFlowPhase`

### 2.5 Timer Proliferation

The wizard uses 3 interval timers and 8+ one-shot timeouts. Cleanup calls
(`clearInterval`, `stopStage3ElapsedTimer`, `stopAgentSetupTimer`) appear 15+
times, scattered across event handlers, watchers, and lifecycle hooks. A missed
cleanup means:

- Elapsed timer counts past completion
- Polling continues after the job is done
- Memory leaks from orphaned intervals

### 2.6 refreshWizardState as a Side-Effect Bomb

`refreshWizardState()` is a ~340-line function that:

1. Fetches 3 API endpoints in parallel
2. Updates 20+ refs
3. Starts/stops timers
4. Reads/writes localStorage
5. Conditionally triggers UI changes (open dialogs, set tab focus)

It's called from 23+ places, including inside watchers that fire on ref changes
that `refreshWizardState` itself sets -- creating potential feedback loops
(guarded by `if` checks, but hard to reason about).

---

## 3. Restructuring Plan

### 3.1 Goal

Replace the scattered state management with a single, auditable state machine
that makes illegal states unrepresentable and eliminates the possibility of
UI/log disagreement.

### 3.2 Phase 1: Extract Wizard State into a Composable

**File:** `src/composables/useWizardState.ts`

Move all 55+ wizard refs, 14 computed properties, and the `wizardFlowPhase`
state machine into a single composable. This is a mechanical extraction -- no
behavior changes, just consolidation.

```
// Rough shape
export function useWizardState(userId: Ref<string | null>) {
  // All wizard refs live here
  const phase = ref<WizardPhase>('idle')
  const agentDeployed = ref(false)
  const kbIndexed = ref(false)
  const medsVerified = ref(false)
  const summaryVerified = ref(false)
  // ...

  // All computeds derive from these refs
  const isActive = computed(() => ...)
  const medsNeedsVerify = computed(() => ...)

  // State transitions are methods, not scattered assignments
  function advanceToMedications() { ... }
  function advanceToSummary() { ... }
  function complete() { ... }

  return { phase, isActive, medsNeedsVerify, ... }
}
```

**Benefit:** All wizard state is in one file. Every transition is a named method
call instead of a bare assignment. You can grep for `advanceToSummary` to find
every place the flow advances, instead of grepping for
`wizardFlowPhase.value = 'summary'` and hoping you found them all.

**Risk:** Low. This is a refactor, not a rewrite. ChatInterface.vue imports the
composable and calls the same methods.

### 3.3 Phase 2: Formal State Machine with Transition Guards

Replace the implicit `wizardFlowPhase` ref with an explicit state machine that
validates transitions:

```
type WizardPhase =
  | 'idle'           // No wizard activity
  | 'deploying'      // Agent being provisioned
  | 'uploading'      // Files being uploaded
  | 'indexing'       // KB indexing in progress
  | 'preparing'      // Draft PS + medication worksheets generating
  | 'verify-meds'    // Waiting for user to verify medications
  | 'verify-summary' // Waiting for user to verify patient summary
  | 'complete'       // All done

const VALID_TRANSITIONS: Record<WizardPhase, WizardPhase[]> = {
  'idle':            ['deploying'],
  'deploying':       ['uploading', 'idle'],
  'uploading':       ['indexing', 'uploading'],
  'indexing':        ['preparing', 'indexing'],
  'preparing':       ['verify-meds'],
  'verify-meds':     ['verify-summary'],
  'verify-summary':  ['complete'],
  'complete':        ['idle'],  // Only via explicit re-run
}

function transition(to: WizardPhase) {
  if (!VALID_TRANSITIONS[phase.value].includes(to)) {
    console.error(`Invalid wizard transition: ${phase.value} -> ${to}`)
    return
  }
  phase.value = to
  logProvisioningEvent({ event: 'phase-transition', from: phase.value, to })
}
```

**Benefit:** Illegal transitions (like `'complete'` -> `'verify-meds'`) are
caught immediately instead of silently corrupting state. Every transition is
logged, so the maia-log always matches reality.

**Key rule:** Once `phase` reaches `'complete'`, no server response, timer
callback, or `refreshWizardState` call can move it backward. The UI indicators
(`wizardActive`, `medsNeedsVerify`, orange borders) derive directly from
`phase`, not from server state.

### 3.4 Phase 3: Split refreshWizardState

Break the 340-line `refreshWizardState()` into focused functions:

| Function | Fetches | Updates |
|----------|---------|---------|
| `fetchAgentStatus()` | `/api/agent-setup-status` | `agentDeployed`, `agentId` |
| `fetchFileStatus()` | `/api/user-files` | `files`, `kbIndexed`, `tokenCount` |
| `fetchSummaryStatus()` | `/api/patient-summary` | `hasSummary`, `summaryText` |
| `syncServerState()` | All three | Calls the above, updates `userResourceStatus` |

Each function updates only its own slice of state. No function overwrites fields
managed by another function. The phase machine's `complete` state is never
overridden by any fetch result.

**Benefit:** When a bug appears in the indexing display, you look at
`fetchFileStatus()`. When the summary flag is wrong, you look at
`fetchSummaryStatus()`. You don't have to read 340 lines to find which of the
20+ ref assignments is wrong.

### 3.5 Phase 4: Centralize Timer Management

Create a timer registry that tracks all active timers:

```
const timers = useTimerRegistry()

// Starting a timer
timers.start('indexing-elapsed', () => tick.value++, 1000)
timers.start('indexing-poll', () => pollKbStatus(), 10000)

// Stopping is explicit and named
timers.stop('indexing-elapsed')

// Phase transitions auto-clear timers registered to the previous phase
function transition(to: WizardPhase) {
  timers.clearPhase(phase.value)
  phase.value = to
}
```

**Benefit:** No orphaned timers. When the phase changes, all timers from the
previous phase are automatically cleared. No more hunting for 15 scattered
`clearInterval` calls.

### 3.6 Phase 5: Eliminate Dual-Path State Updates

The current architecture has two functions (`refreshWizardState` and
`updateContextualTip`) that both overwrite `userResourceStatus`. This should be
reduced to one:

- `updateContextualTip` should read from `userResourceStatus` (already populated
  by `refreshWizardState`), not re-fetch and overwrite it.
- If `updateContextualTip` needs fresh data, it should call `syncServerState()`
  (the refactored version) which knows not to overwrite in-memory completion
  flags.

### 3.7 Phase 6: Derived UI State

All UI indicators should derive from the phase machine, not from independent
computeds that consult server state:

```
const wizardActive = computed(() =>
  phase.value !== 'idle' && phase.value !== 'complete'
)

const medsNeedsVerify = computed(() =>
  phase.value === 'verify-meds'
)

const showIndexingSpinner = computed(() =>
  phase.value === 'indexing'
)
```

**Benefit:** The UI is a pure function of the phase. If the log says "Setup
complete," the phase is `'complete'`, and every UI indicator reflects that. There
is no second state system that can disagree.

---

## 4. Migration Strategy

### Ordering

The phases are designed to be done incrementally, one PR at a time:

1. **Phase 1** (composable extraction) can be done first with zero behavior
   change. It just moves code. This is the highest-value lowest-risk step.
2. **Phase 2** (state machine) changes how transitions work but keeps the same
   states. Test by running the wizard end-to-end and verifying the maia-log
   matches the UI at every step.
3. **Phases 3-6** can be done in any order after Phase 2.

### Testing

There is no automated test suite for the wizard. Each phase should be validated
by:

1. Running the full wizard flow (upload files, index KB, verify meds, verify PS)
2. Checking the maia-log PDF matches the on-screen state at every step
3. Reloading mid-flow and confirming the wizard resumes correctly
4. Running the Restore flow and confirming it doesn't conflict

### What Not to Change

- The maia-log PDF generation (`logProvisioningEvent` + `generateSetupLogPdf`)
  is working correctly and should not be restructured. It's the one reliable
  record of what happened.
- The MyStuffDialog rail UI and tab structure are fine. The problem is in what
  drives the `wizardActive` and `medsNeedsVerify` props.

---

## 5. Immediate Tactical Fixes (Already Applied)

### v1.4.58 — Post-completion UI guards

- `wizardActive` now returns `false` immediately if `wizardPatientSummary` is
  true, before consulting any server-derived state.
- `medsNeedsVerify` now returns `false` immediately if `wizardPatientSummary` is
  true, since medications must have been verified before the patient summary
  (the flow enforces this order).

### v1.4.59 — Prevent worksheet from auto-provisioning secondary agent

- `triggerSetupWorksheets` changed from `['default', 'gpt']` to `['default']`
  only. The `'gpt'` entry caused `/api/medications/worksheet` to call
  `ensureSecondaryAgent` during setup, creating the secondary agent without user
  action.

### v1.4.60 — Tab override fix

- `handlePatientSummaryVerified` now resets `myStuffInitialTab` to `'files'` when
  setup completes, preventing the stale `'summary'` value from overriding user
  tab navigation on reopen.

### v1.4.61 — Indexing spinner race + secondary agent lazy provisioning

**Bug: Indexing spinner persists alongside Draft PS generation.**

Root cause: a race between the frontend's 10-second indexing poll and
`refreshWizardState`. The frontend poll detects indexing completion (via
`inferredComplete`: tokens > 0 and DO API not active) and sets
`indexingStatus.value.phase = 'complete'`. This triggers the preparation-phase
watcher, which starts Draft PS generation. But the poll handler also calls
`refreshWizardState()`, which fetches `/api/user-files`. The server's own 15s KB
polling hasn't persisted `backendCompleted: true` yet, so the response contains
stale data (`phase: 'indexing'`). At line 2950, `refreshWizardState` overwrites
`indexingStatus.value` with `{ phase: 'indexing' }`, making `stage3IndexingActive`
true again and reviving the spinner.

Fix: guard the overwrite at line 2950 with
`indexingStatus.value?.phase !== 'complete'` — never regress a completed phase
with stale server data.

**Bug: Secondary agent auto-deploying without user action.**

Root cause: the `/api/chat/providers` endpoint in `server/routes/chat.js` (lines
700-721) lazily calls `ensureSecondaryAgent` whenever the primary agent is
deployed and a KB exists, even if the user has never deployed the secondary
agent. This fires every time `loadProviders()` is called from
`refreshWizardState` (line 2882), which happens many times during setup. The
secondary agent silently gets created as a side effect of loading the provider
dropdown list.

Fix: changed the guard from "no endpoint or not live" (which matched first-time
creation) to "agentId exists AND (no endpoint or not live)" — i.e., only repair
an agent that was previously deployed, never auto-create one from scratch. First
creation is the user's action via the Deploy button in My AI Agent.

### General observations

These fixes are band-aids. They prevent specific symptoms (stale server data
overriding in-memory completion, silent agent provisioning) but don't address the
underlying architectural problem of having multiple independent state systems.
The restructuring plan in sections 3.1–3.7 remains the correct long-term
solution.
