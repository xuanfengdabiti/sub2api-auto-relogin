# Relogin Flow Notes

This is the intended high-level relogin flow implemented by the unified
program. Values such as SUB2API group, proxy, and concurrency are read from
`.env.local`.

## Scope

- Only handle SUB2API accounts in `SUB2API_GROUP_NAMES`.
- Source of failed accounts: the SUB2API admin API.
- Browser isolation:
  - Use a temporary Chromium profile.
  - Delete the temporary profile after capture by default.
  - Do not use ChatGPT website logout, because logout can invalidate sessions.

## Flow

1. Detect failed SUB2API accounts in configured groups.
2. Read the account email from the failed SUB2API account.
3. Remove stale duplicate failed records for the same email when safe.
4. Open ChatGPT login in an isolated browser profile.
5. Submit the email address.
6. If the page does not advance within the timeout, refresh and retry.
7. Wait before polling the mailbox for a login code.
8. Fetch the newest ChatGPT verification code through Graph/Outlook or IMAP.
9. Submit the code.
10. If Cloudflare or authentication pages produce retryable errors, retry the
    login flow.
11. Open `https://chatgpt.com/api/auth/session`.
12. Save the session JSON under ignored local data paths.
13. Import the session into SUB2API with configured group, proxy, concurrency,
    priority, and rate multiplier.
14. Verify the account is no longer in error state.

## Cleanup Rules

- If mailbox authentication is confirmed dead while waiting for the code, delete
  the local mailbox record and matching SUB2API records.
- If ChatGPT shows the account deleted/deactivated identity error, delete the
  local mailbox record and matching SUB2API records.
- Ordinary login failures, Cloudflare checks, temporary region errors, and
  missing session tokens are retryable and should not delete records.

## Useful Commands

```powershell
node bin\auto-relogin.js sub2api:check --json
node bin\auto-relogin.js relogin:capture --account user@example.com --headless --debug
node bin\auto-relogin.js relogin:import --account user@example.com --headless
node bin\auto-relogin.js run --once
```

## Sensitive Data

Never print or commit full ChatGPT session JSON, access tokens, session tokens,
SUB2API passwords, mailbox passwords, or mailbox refresh tokens.
