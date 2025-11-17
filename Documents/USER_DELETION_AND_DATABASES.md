# User Deletion and Database Management

## Difference Between `maia_sessions` and `maia_audit_log`

### `maia_sessions` Database
**Purpose**: Stores active user session data (temporary, runtime state)

**Contents**:
- Active session documents with session IDs
- User authentication state (userId, username, displayName)
- Session metadata (createdAt, lastActivity, authenticatedAt, expiresAt)
- Session type information (regular user vs deep link user)
- Temporary session mappings

**Characteristics**:
- **Temporary**: Sessions expire and are cleaned up automatically
- **Runtime state**: Used for maintaining user login state during active use
- **Can be safely deleted**: When a user is deleted, their sessions should be removed
- **No historical value**: Once a session expires, the data has no long-term value

**When User is Deleted**:
- ✅ **DELETE all sessions** for that user
- Sessions are temporary runtime state and should be cleaned up
- Prevents orphaned session documents

### `maia_audit_log` Database
**Purpose**: Stores security audit events (permanent security records)

**Contents**:
- Security events: `login_success`, `login_failure`, `logout`, `passkey_registered`, `session_expired`
- Event metadata: timestamp, IP address, user agent
- User ID associated with the event
- Additional event details

**Characteristics**:
- **Permanent**: Audit logs are kept for security and compliance purposes
- **Historical record**: Provides audit trail of security events
- **Compliance**: May be required for security audits, incident investigation, or regulatory compliance
- **Should NOT be deleted**: Even when a user is deleted, audit logs should be retained

**When User is Deleted**:
- ❌ **DO NOT DELETE** audit log entries for that user
- Keep audit logs for:
  - Security incident investigation
  - Compliance requirements
  - Historical analysis
  - Forensic purposes
- Audit logs may need to be retained for years depending on compliance requirements

## User Deletion Process

When a user is deleted via the admin interface, the following actions are taken:

1. **Delete Spaces Folder**: All files in the user's DigitalOcean Spaces folder (`userId/`) are deleted
2. **Delete Knowledge Base**: The user's Knowledge Base is deleted from DigitalOcean
3. **Delete Agent**: The user's AI agent is deleted from DigitalOcean
4. **Delete Sessions**: All user sessions are deleted from `maia_sessions` database
5. **Delete User Document**: The user document is deleted from `maia_users` database
6. **Retain Audit Logs**: Audit log entries in `maia_audit_log` are **NOT deleted** (permanent record)

## Rationale

- **Sessions are temporary**: They represent active login state and should be cleaned up when a user is deleted
- **Audit logs are permanent**: They provide a security audit trail that may be needed for compliance, incident investigation, or historical analysis
- **Separation of concerns**: Runtime state (sessions) vs. historical records (audit logs)

## Compliance Considerations

If your organization has specific data retention requirements:
- Audit logs may need to be retained for a specific period (e.g., 7 years)
- Consider implementing automated archival or deletion policies for audit logs after the retention period
- Consult with legal/compliance team for specific requirements

