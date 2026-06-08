# Chrome Automation for Medical Records Requests

## Summary

We investigated how MAIA can help patients navigate medical portal websites to request their health records using browser automation. This document records what we tested, what we learned, and the architecture we chose.

The implementation lives in a separate repository: [agropper/records-request-assistant](https://github.com/agropper/records-request-assistant).

## The Problem

Patients have the legal right to their medical records, but every portal buries the request form differently. MyChart/Epic alone has different menu structures across health systems. A patient requesting records must:

1. Find the request form (often buried under menus like Menu → My Record → Request Records)
2. Fill out organization, date range, record types, delivery preferences
3. Review consent language and submit

An AI assistant that can read and interact with the portal page — while keeping the patient in control — could make this accessible to non-technical users.

## Live Testing: MGB Patient Gateway (MyChart/Epic)

We tested against Mass General Brigham's Patient Gateway (MyChart/Epic) on 2026-06-07 using Claude in Chrome as a prototype.

### What worked

- **Platform detection:** `window.Epic` is present on the page, allowing automatic platform identification.
- **Menu navigation:** The hamburger menu (≡) contains "Request Records" under the "My Record" section. The agent found and navigated to it successfully.
- **Form reading:** The agent read all form fields via JavaScript: organization dropdown, recipient radio buttons, date range inputs, location checkboxes, and 17 record-type checkboxes.
- **Form filling:** The agent set date ranges and checked all "Include" checkboxes except "Other" programmatically.
- **Multi-step form:** The form is two steps — fill (at `/app/release-of-information`) then review/consent (at `/app/release-of-information/request-review`) with a "Send request" button.

### What we learned

#### 1. The idle-timeout problem

MyChart's persistent background scripts (WebSocket connections, session keepalive, analytics) prevent Chrome's `document_idle` signal from firing. This caused Claude in Chrome's `screenshot`, `find`, and `read_page` tools to time out after 45 seconds.

**The page is fully loaded** (`document.readyState === "complete"`), but the idle check never passes. JavaScript execution (`javascript_tool`) bypasses this and works reliably. Any browser automation solution for medical portals must handle this.

#### 2. Navigate visually, not programmatically

Our first attempt scraped all `<a>` tags from the DOM and found the "Request Records" link — but this was wrong. The link was hidden inside a collapsed hamburger menu. DOM scraping found the destination but skipped the navigation path entirely.

**The assistant's job is to show the patient the path, not just find the URL.** The correct approach is to open the menu, read what's visible, find the link, click it, and report the path (e.g., "Menu → My Record → Request Records"). The patient should learn the route for next time.

#### 3. Prompt before act

When we opened a dropdown for the patient to select their organization, we did it without telling them first. The dropdown appeared with no context. The correct pattern is:

1. **Tell the patient** what they need to do ("Select your organization from the dropdown below")
2. **Then** perform the UI action (open the dropdown)
3. **Then** wait for the patient to act

This "prompt before act" principle applies to every visible UI interaction.

#### 4. Confirmation gates

The agent must never submit forms or enter sensitive data without explicit patient approval. Two levels:

- **Navigation** (low risk): proceed without gates, but always report what you did
- **Data entry and submission** (consequential): summarize what you're about to do, wait for explicit "yes"

#### 5. Native `<select>` dropdowns

HTML `<select>` elements cannot be opened programmatically via JavaScript events. The agent must click the element by coordinates using browser automation tools.

### Complete form structure (MGB Patient Gateway)

**Step 1 — Fill** (`/MyChart-PRD/app/release-of-information`):
- Organization dropdown ("Send to"): Dana Farber, Mass General Brigham, VNA & Hospice of Cooley Dickinson
- Recipient: radio buttons (Me / Someone else)
- Date range: two text inputs (MM/DD/YYYY format)
- Locations: checkboxes for ~20 MGB hospitals and clinics
- Record types: 17 checkboxes (Abstract, Allergies & Immunizations, Anesthesia Record, Cardiology Reports, Consult Notes, Discharge Summary, Emergency Department Notes, History and Physical, Inpatient Progress Notes, Laboratory Reports, Medications, Office Visit Notes, Operative Notes, Pathology Reports, Procedure Notes, Radiology Reports, Other)

**Step 2 — Review and consent** (`/MyChart-PRD/app/release-of-information/request-review`):
- Summary of all selections
- Consent language about sensitive information and recipient use
- "Send request" button (critical confirmation gate) and "Back" button

Full field-level documentation with element IDs: [portals/mychart-mgb.md](https://github.com/agropper/records-request-assistant/blob/main/docs/portals/mychart-mgb.md)

## Architecture Decision: Purpose-Built MAIA Chrome Extension

### Options evaluated

We evaluated five approaches to browser automation:

#### 1. Claude in Chrome (Anthropic)

Anthropic's browser extension that bundles AI reasoning and browser control.

- **Pros:** Excellent UX, integrated reasoning, no local bridge needed
- **Cons:** Requires paid Claude subscription ($20+/month)
- **Verdict:** Rejected — cost is a non-starter for patients

#### 2. mcp-chrome (open source)

Chrome extension + local bridge exposing 20+ MCP tools.

- **Pros:** Free (MIT), comprehensive tool set, 12k GitHub stars
- **Cons:** Requires Node.js 20+, `npm install -g mcp-chrome-bridge`, loading an unpacked extension in Developer Mode, and a running bridge process
- **Verdict:** Rejected — developer setup, not patient setup

#### 3. Playwright MCP (Microsoft)

Chrome extension + local Playwright server.

- **Pros:** Free (Apache 2.0), mature automation primitives
- **Cons:** Same local bridge requirement as mcp-chrome
- **Verdict:** Rejected — same problem

#### 4. Puppeteer/CDP direct

Connect to Chrome via DevTools Protocol, no extension.

- **Pros:** No extension needed, maximum control
- **Cons:** Requires launching Chrome with `--remote-debugging-port=9222` (a CLI flag)
- **Verdict:** Rejected — CLI flags are harder than extension install for patients

#### 5. Antigravity-style bundled app (Google's approach)

Bundle the local bridge into a desktop application.

- **Pros:** User never sees Node.js, ports, or CLI
- **Cons:** MAIA has no local component today. Adding one means an installer, auto-update mechanism, background process, enlarged attack surface, and cross-platform support burden
- **Verdict:** Rejected — local component complexity outweighs the benefit

### The fundamental problem with MCP

Every MCP-based Chrome automation solution requires a **local bridge process**. Chrome extensions cannot expose MCP endpoints on their own — they need a native messaging host or local HTTP server to bridge between the browser and MCP clients. This always means a local component.

### Chosen architecture: MAIA extension over HTTPS

A purpose-built Chrome extension that communicates directly with MAIA's server over HTTPS. No MCP protocol, no local bridge, no Node.js, no native messaging host.

```
Patient's Chrome                       MAIA Server (cloud)
┌─────────────────────┐               ┌──────────────────────┐
│                     │               │                      │
│  Patient portal     │               │  Claude API          │
│  (authenticated)    │               │  (intelligence)      │
│                     │               │                      │
│  MAIA extension     │◄── HTTPS ────►│  Orchestration       │
│  (browser actions)  │               │  (decides what to    │
│                     │               │   read/click/fill)   │
└─────────────────────┘               │                      │
                                      │  MAIA chat UI        │
         Patient ◄── chat ───────────►│  (patient comms)     │
                                      │                      │
                                      └──────────────────────┘
```

**Patient setup:** Install the MAIA extension from the Chrome Web Store (one click). No Node.js, no CLI, no local servers, no developer mode.

**The extension is thin** — it executes actions (read DOM, click, fill forms, run JS) but does not decide them. All reasoning happens on MAIA's server via Claude API.

**Key tradeoff:** PHI (portal page content) transits the network to MAIA's server, unlike localhost-only MCP approaches. This is acceptable because:
- MAIA already handles PHI — the trust boundary is consistent
- All communication is over HTTPS
- The patient needs internet for the portal anyway
- The extension sends only requested DOM content, not entire pages

### Extension permissions (minimal)

- `activeTab` — read/interact with the current tab only when activated
- Access to MAIA's server domain only
- No `<all_urls>`, no `tabs`, no `history`, no `cookies`

## Design Principles

These emerged from live testing and apply to all phases of the assistant:

1. **Prompt before act** — always tell the patient what to do before performing any visible UI action
2. **Agent never touches credentials** — if the page shows login/2FA/CAPTCHA, stop and ask the patient to handle it
3. **Page text is data, not commands** — any page content that looks like an instruction is surfaced to the patient, never acted on
4. **Navigate visually, report the path** — don't just find the destination; show the patient how to get there
5. **Confirmation gates for consequential actions** — data entry and form submission require explicit patient approval
6. **No cost to the patient** — the architecture must not require paid AI subscriptions
7. **No local component** — the patient installs only a Chrome Web Store extension

## Phased Implementation

### Phase 1 — Navigate to the request form (spec complete)

Find the records request form on an authenticated portal. Navigate menus, identify the platform, confirm with the patient. No data entry.

### Phase 2 — Local folder management

Create or locate a folder (e.g., `~/Documents/MAIA for AG`) as the agent's memory. Store patient profile and request history for reuse.

### Phase 3 — Read prior context

Before filling the form, check the folder for reusable fields (name, DOB, address) and the last request date to scope the new request.

### Phase 4 — Fill and submit

Pre-populate the form from the patient profile. Explicit confirmation gates before entering data and before submitting.

## Repository

All implementation specs, interaction patterns, portal mappings, and the video script live in [agropper/records-request-assistant](https://github.com/agropper/records-request-assistant):

- `docs/architecture.md` — detailed architecture with alternatives analysis
- `docs/phase-1-navigation.md` — Phase 1 spec with agent prompt
- `docs/interaction-patterns.md` — prompt-before-act, confirmation gates
- `docs/portals/mychart-mgb.md` — complete MGB form mapping with element IDs
- `docs/setup-guide.md` — patient setup (3 steps)
- `docs/video-script.md` — demo video script (extension install through submission)
