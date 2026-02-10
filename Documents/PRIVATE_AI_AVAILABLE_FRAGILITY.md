# Why "Private AI Unavailable" modal was fragile

## The problem

The modal appeared even after the user completed the wizard (verified Current Medications and Patient Summary). Private AI only showed as available after a full page reload.

## Root cause: transition-based refetch

"Private AI available" was driven by **two separate sources of truth** that had to stay in sync:

1. **Server**: `GET /api/chat/providers` includes `digitalocean` only when the user has a deployed agent (`workflowStage === 'agent_deployed'` or `assignedAgentId` + `agentEndpoint`).
2. **Frontend**: `providers` (from that API) and `showPrivateUnavailableDialog`. The dialog is shown when providers don't include `digitalocean`, and cleared when they do.

The frontend **only refetched providers on specific transitions**:

- **In `refreshWizardState()`**: `loadProviders()` was called only when `statusResult.agentReady` was true **and** `!wasReady` (i.e. the first time we see agent ready in that run). So: refetch only when agent **just became** ready.
- **Watcher on `userResourceStatus.value?.hasAgent`**: `loadProviders()` only when `hasAgent` went from false → true. So: refetch only on the **first** time we see hasAgent true.

So refetch was tied to **one-time transitions**. If the app never observed that transition in the current session, it never refetched.

## When the transition was missed

1. **Initial load**: User opens app; `loadProviders()` runs and returns no `digitalocean` (agent not ready yet). Dialog is shown, `providers` has no Private AI.
2. **Later**: Agent becomes ready (Stage 1 complete, deployment up). Backend now returns `digitalocean` for this user.
3. **No refetch**:  
   - If `refreshWizardState()` had already run earlier with `agentReady: true` (e.g. from another tab or a quick first load), then `wasReady` is already true, so we never call `loadProviders()` again.  
   - If the first time we set `userResourceStatus.hasAgent` it was already true (e.g. first `/api/user-status` after agent ready), the watcher never sees false→true, so it never runs `loadProviders()`.
4. **User does Stage 2 & 3**: Verifies meds and summary. When they close My Stuff, we call `refreshWizardState()`. Server returns `agentReady: true` and `hasAgent: true`, but we don’t refetch because we only refetch on transition (`!wasReady` / hasAgent false→true). So `providers` stays stale (no `digitalocean`) and the dialog stays visible.
5. **Reload**: Full reload runs `loadProviders()` again; server returns `digitalocean`; dialog is cleared.

So the logic was fragile because it depended on **seeing the exact moment** the agent became ready. If that moment was missed (e.g. wizard already closed, or status already true on first fetch), no later action (like completing Stage 2/3) triggered a refetch.

## Additional fragility

- **Multiple booleans**: `wizardAgentReady`, `wizardStage1Complete`, `statusResult.agentReady`, `statusResult.hasAgent`, `userResourceStatus.hasAgent` can get out of sync; refetch was only triggered from two narrow paths.
- **Dialog clear only on refetch**: We clear the dialog when `providers` includes `digitalocean`, but that only happens when `loadProviders()` runs and returns that list. If we never refetch, the dialog is never cleared.

## Fix (in code)

**Single rule**: Whenever we learn from the server that the agent is ready (in `refreshWizardState()` or anywhere we get `hasAgent` / `agentReady`), if `providers` does not already include `digitalocean`, call `loadProviders()`. Do not depend on transitions; sync whenever we have evidence the agent is ready.

That way, after Stage 2/3 (or any time `refreshWizardState()` runs and the server says the agent is ready), we ensure the providers list and dialog state match the backend.

---

## Deep link: Private AI Unavailable even when owner enabled it

### The problem

When a deep link is shared and the visitor opens it, Private AI shows as "Unavailable" even though the **owner** has enabled "Allow deep link users to use Private AI" in the My AI Agent tab.

### Root cause: server ignores deep link and owner

1. **`GET /api/chat/providers`** decides whether to include `digitalocean` only from **`req.session.userId`**:
   - It loads the user doc for that `userId` and checks `hasAgentDeployed` (agent + endpoint).
   - If no `userId` or no agent, it filters out `digitalocean`.

2. **For a deep link user**, the session is a **deep link session**:
   - The session store deliberately sets **`userId: null`** for deep link (the visitor is identified by `deepLinkUserId` and session doc id `deeplink_${deepLinkUserId}`).
   - So `req.session.userId` is **null** (or missing) when the deep link visitor calls `/api/chat/providers`.

3. **Server behaviour**: With no `userId`, the handler hits the `else` branch and **always** filters out `digitalocean`. It never looks at:
   - whether the session is a deep link session,
   - who the **owner** (patient) is,
   - whether the owner has an agent deployed,
   - or the owner’s **`allowDeepLinkPrivateAI`** setting.

4. **Frontend**: The frontend receives a provider list that **already has no Private AI**. It then only **filters** when `ownerAllowDeepLinkPrivateAI === false`; it never **adds** Private AI when the server omitted it. So even with the owner setting enabled, the list stays without `digitalocean` and the modal stays.

### Why it’s fragile

- **Single user id**: The server treats “who is the user?” as “session userId”. For deep link, the acting identity is the visitor; the **agent and the allow setting** belong to the **owner**. The API never resolves the owner for providers.
- **Owner only on frontend**: The owner’s `allowDeepLinkPrivateAI` is only loaded on the frontend (e.g. when a chat is selected) and used to filter. The server never includes Private AI for deep link, so that frontend check never gets a chance to “allow” it.

### Fix (in code)

**Server**: In `GET /api/chat/providers`, when the request is a **deep link session** (`isDeepLinkSession(req)`):
- Resolve the **owner** (e.g. from the shared chat using `req.session.deepLinkShareId` or `deepLinkChatId`).
- Load the **owner’s** user doc; check `hasAgentDeployed` and `allowDeepLinkPrivateAI !== false`.
- If both are true, **include** `digitalocean` in the list (and do not filter it out for “no userId”).

Then the frontend will receive Private AI when the owner has an agent and has allowed deep link Private AI; the existing frontend filter for `ownerAllowDeepLinkPrivateAI === false` remains correct.
