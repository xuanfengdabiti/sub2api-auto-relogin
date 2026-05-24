# Sub2API Fail Monitor

This workspace has a local Sub2API fail-account monitor. It is now part of the unified program:

`bin\auto-relogin.js`

Configuration lives in `.env.local` and is intentionally ignored by `.gitignore` because it contains the Sub2API password. Example:

- `SUB2API_URL=http://127.0.0.1:8082/admin/accounts`
- `SUB2API_EMAIL=your-sub2api-admin@example.com`
- `SUB2API_POLL_INTERVAL_MINUTES=15`
- `SUB2API_GROUP_NAMES=your-group-name`

Only accounts in the configured group names are monitored.

Do not hard-code the password into scripts or docs. Read it from `.env.local`.

Useful commands:

```powershell
npm run monitor:sub2api-fail:once
npm run monitor:sub2api-fail:start
npm run monitor:sub2api-fail:stop
npm run status
npm run run:once
```

Shared local state for concurrent Codex windows:

- `data/sub2api-fail-monitor-state.json`
- `data/sub2api-fail-monitor.log`
- `data/sub2api-fail-monitor.lock`

The monitor checks:

`GET /api/v1/admin/accounts?platform=openai&type=oauth&status=error`

It records newly seen, changed, and recovered failed accounts so another Codex window can inspect the same state from disk.
