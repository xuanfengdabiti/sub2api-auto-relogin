# ChatGPT Session Conversion and SUB2API Import

The converter logic runs locally and does not upload tokens to remote
conversion websites.

Unified modules:

- `src/chatgpt-session-converter.js`
- `src/sub2api-session-importer.js`

## Defaults

Import defaults are read from `.env.local`:

- `SUB2API_GROUP_NAMES`
- `SUB2API_PROXY_NAME`
- `SUB2API_ACCOUNT_CONCURRENCY`
- `SUB2API_ACCOUNT_PRIORITY`
- `SUB2API_ACCOUNT_RATE_MULTIPLIER`

The program resolves group IDs and proxy IDs from SUB2API at runtime.

## Commands

Convert a captured ChatGPT session JSON into SUB2API import JSON:

```powershell
node bin\auto-relogin.js session:convert --from data\sessions\account.session.local.json
```

Directly import/update a captured ChatGPT session JSON into SUB2API:

```powershell
node bin\auto-relogin.js session:import --from data\sessions\account.session.local.json
```

Capture and save `https://chatgpt.com/api/auth/session` locally:

```powershell
node bin\auto-relogin.js relogin:capture --account user@example.com --headless
```

Capture and then directly import/update SUB2API:

```powershell
node bin\auto-relogin.js relogin:import --account user@example.com --headless
```

Manual cleanup commands require `--apply`:

```powershell
node bin\auto-relogin.js sub2api:cleanup-duplicates --apply
node bin\auto-relogin.js cleanup:dead-mailbox --account user@example.com --apply
node bin\auto-relogin.js mail:delete --account user@example.com --apply
```

Import an already converted `exported_at/proxies/accounts` document:

```powershell
node bin\auto-relogin.js sub2api:import-json --from data\converted-sub2api\account.sub2api.json
```

## Sensitive Data

Captured ChatGPT sessions contain access tokens and usually session tokens.
Keep them under ignored local data paths such as:

```text
data/sessions/
data/browser-profiles/
data/debug-login/
```

Do not paste full session JSON into chat, issues, logs, or GitHub commits.
