# Lists Flow (Deprecated)

This document reflects an older Lists pipeline. The current Lists behavior is
driven by `src/components/Lists.vue` and the server endpoints in
`server/routes/files.js`.

Key updates since this doc was written:

- Apple Health detection is set at import time and stored in file metadata.
- Categories are built **once** for Apple Health files and tracked in the user doc.
- The “Extract Lists from Initial File” block is removed from the UI.

Use the codebase as the authoritative reference for current behavior.
