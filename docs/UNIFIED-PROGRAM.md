# Unified Auto Relogin Program

This workspace now uses one program entry:

`bin\auto-relogin.js`

It merges:

- SUB2API failed-account monitoring.
- Hotmail/Outlook account storage.
- Hotmail/Outlook health checks.
- Latest OpenAI/ChatGPT verification-code fetching.
- ChatGPT session JSON conversion/import for SUB2API.

SUB2API monitoring is scoped to the configured group names. Example:

`SUB2API_GROUP_NAMES=your-group-name`

The local monitor interval is:

`SUB2API_POLL_INTERVAL_MINUTES=15`

SUB2API session import settings are:

- `SUB2API_PROXY_NAME=your-proxy-name`
- `SUB2API_ACCOUNT_CONCURRENCY=10`
- `SUB2API_ACCOUNT_PRIORITY=1`
- `SUB2API_ACCOUNT_RATE_MULTIPLIER=1`

## Commands

Run from the project root.

```powershell
npm run status
npm run run:once
npm run run
npm run web
npm run monitor:sub2api-fail:start
npm run monitor:sub2api-fail:stop
```

Mail functions are now subcommands of the same program:

```powershell
npm run mail:list
npm run mail:check
npm run mail:check-all
npm run mail:latest-code
```

Session conversion/import is also part of the same program:

```powershell
npm run session:convert -- --from data\sessions\account.session.local.json
npm run session:import -- --from data\sessions\account.session.local.json
npm run sub2api:import-json -- --from data\converted-sub2api\account.sub2api.json
npm run sub2api:cleanup-duplicates -- --apply
npm run cleanup:dead-mailbox -- --account user@example.com --apply
npm run relogin:capture -- --account user@example.com
npm run relogin:import -- --account user@example.com
```

Direct CLI examples:

```powershell
node bin\auto-relogin.js status
node bin\auto-relogin.js sub2api:check
node bin\auto-relogin.js mail:latest-code --account user@example.com --top 10
node bin\auto-relogin.js session:convert --from data\sessions\account.session.local.json
node bin\auto-relogin.js session:import --from data\sessions\account.session.local.json
node bin\auto-relogin.js sub2api:cleanup-duplicates --apply
node bin\auto-relogin.js cleanup:dead-mailbox --account user@example.com --apply
node bin\auto-relogin.js relogin:capture --account user@example.com
node bin\auto-relogin.js relogin:import --account user@example.com
node bin\auto-relogin.js run
node bin\auto-relogin.js web --port 8083
node bin\auto-relogin.js stop
```

## Startup

The optional Windows startup task is installed as:

`Sub2API Auto Relogin`

It runs:

`scripts\start-sub2api-fail-monitor.ps1`

Useful commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1
powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup-task.ps1
```

Docker files are also present for Docker Desktop:

```powershell
docker compose up -d --build
docker compose logs -f
docker compose down
```

The continuous `run` command starts the web manager by default:

```text
http://localhost:8083
```

The web page can import one or many Hotmail lines, list mailbox status, copy the latest login code, batch-check mailboxes, delete mailboxes, optionally delete matching SUB2API accounts, and show monitor logs.

Only run one supervisor at a time. If using Docker, stop the Windows hidden process first:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-sub2api-fail-monitor.ps1
```

## Add Mailboxes

For one mailbox:

```powershell
node bin\auto-relogin.js mail:add --email user@example.com --client-id CLIENT_ID --refresh-token REFRESH_TOKEN
node bin\auto-relogin.js mail:add --line "user@example.com----PASSWORD----CLIENT_ID----REFRESH_TOKEN"
node bin\auto-relogin.js mail:check --account user@example.com
```

The `--line` format is compatible with GuJumpgate's Hotmail import order:

```text
email----password----ID----Token
```

Any run of two or more hyphens works as the separator, so `--`, `---`, and `----` are accepted. The third field is saved as `clientId`, and the fourth field is saved as `refreshToken`.

For many mailboxes exported from GuJumpgate storage, merge them into the current store without deleting existing accounts:

```powershell
node bin\auto-relogin.js mail:import --from path\to\storage-extract-raw.local-only.json --merge
node bin\auto-relogin.js mail:check-all
```

For many mailboxes in the line format above:

```powershell
node bin\auto-relogin.js mail:import-lines --from path\to\hotmail-accounts.txt
node bin\auto-relogin.js mail:check-all
```

## Compatibility

Legacy scripts are still present, but they now point at the unified program:

- `scripts\start-sub2api-fail-monitor.ps1`
- `scripts\stop-sub2api-fail-monitor.ps1`
- `bin\mail.js`

## Current Scope

The unified program detects failed SUB2API accounts only in the configured `SUB2API_GROUP_NAMES`, provides mailbox access/code retrieval, and can locally convert/import captured ChatGPT session JSON. It also has a browser relogin/capture command that launches Chromium with a temporary isolated profile and deletes that profile afterward by default. If ChatGPT email submit does not advance within 10 seconds, it refreshes the login page and retries up to 5 times. Later monitor cycles can try again if all attempts fail.

Deletion rules:

- Duplicate failed SUB2API records with the same email are considered stale and can be removed with `sub2api:cleanup-duplicates --apply`.
- `relogin:import` deletes existing failed SUB2API records for that email before importing the fresh session.
- If mailbox auth is confirmed dead during code retrieval, the flow removes the local mailbox record and matching SUB2API records.
- If ChatGPT shows the account deleted/deactivated identity error, the flow removes the local mailbox record and matching SUB2API records.
