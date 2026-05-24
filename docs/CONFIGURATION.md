# Configuration

Copy `.env.local.example` to `.env.local` and edit the values for your own
environment.

Never commit `.env.local` or `data/`.

## SUB2API

Required:

```env
SUB2API_URL=http://127.0.0.1:8082/admin/accounts
SUB2API_EMAIL=your-sub2api-admin@example.com
SUB2API_PASSWORD=your-sub2api-password
```

Account selection and import defaults:

```env
SUB2API_POLL_INTERVAL_MINUTES=15
SUB2API_ACCOUNT_PLATFORM=openai
SUB2API_ACCOUNT_TYPE=oauth
SUB2API_GROUP_NAMES=your-group-name
SUB2API_PROXY_NAME=your-proxy-name
SUB2API_ACCOUNT_CONCURRENCY=10
SUB2API_ACCOUNT_PRIORITY=1
SUB2API_ACCOUNT_RATE_MULTIPLIER=1
```

`SUB2API_GROUP_NAMES` limits which failed accounts the monitor will touch. Use
the exact group name from SUB2API. Multiple groups can be comma-separated.

`SUB2API_PROXY_NAME` is resolved from SUB2API's proxy list. Imported sessions
will be bound to that proxy. Browser login also uses this proxy by default.

## Web UI

```env
WEB_PORT=8083
TZ=Asia/Shanghai
```

The web UI starts with the long-running `run` command and is available at:

```text
http://localhost:8083
```

## Browser Relogin

```env
CHATGPT_RELOGIN_HEADLESS=1
CHATGPT_RELOGIN_POST_CODE_MAX_ATTEMPTS=3
CHATGPT_RELOGIN_USE_SUB2API_PROXY=1
```

By default the browser login reuses the SUB2API proxy named by
`SUB2API_PROXY_NAME`. To override it:

```env
CHATGPT_RELOGIN_PROXY=http://127.0.0.1:7890
CHATGPT_RELOGIN_PROXY_USERNAME=
CHATGPT_RELOGIN_PROXY_PASSWORD=
```

To disable proxy usage for browser login:

```env
CHATGPT_RELOGIN_PROXY=none
```

or:

```env
CHATGPT_RELOGIN_USE_SUB2API_PROXY=0
```

## Mailboxes

The project stores mailbox records locally. Supported input formats:

```text
email@example.com----password
email@example.com----password----refreshToken----clientId
email@example.com----password----clientId----refreshToken
```

The parser auto-detects token order in most common cases. Any separator of two
or more hyphens is accepted.

### Microsoft Graph / Outlook API

If an account has both `clientId` and `refreshToken`, the program tries
Microsoft Graph/Outlook mail fetching first.

This mode is useful for Microsoft accounts exported from tools that already
manage OAuth tokens.

### Password IMAP

If an account has a password, the program can use IMAP. This is provider
specific; fill the values your mailbox seller or mail provider gives you:

```env
MAIL_IMAP_HOST=imap.example.com
MAIL_IMAP_PORT=993
MAIL_IMAP_SECURE=1
MAIL_IMAP_LOGIN_METHOD=LOGIN
MAIL_IMAP_REJECT_UNAUTHORIZED=1
```

Optional fallback profile:

```env
MAIL_IMAP_FALLBACK_HOST=imap2.example.com
MAIL_IMAP_FALLBACK_PORT=143
MAIL_IMAP_FALLBACK_SECURE=0
MAIL_IMAP_FALLBACK_LOGIN_METHOD=AUTH=PLAIN
MAIL_IMAP_FALLBACK_REJECT_UNAUTHORIZED=1
```

Multiple profiles can also be provided in one variable:

```env
MAIL_IMAP_PROFILES=imap.example.com:993:1:LOGIN,imap2.example.com:143:0:AUTH=PLAIN
```

To force IMAP instead of trying Graph first:

```env
MAIL_FETCH_TRANSPORT=imap
```

### Shanyouxiang Compatibility

Older local setups used these vendor-specific variable names:

```env
SHANYOUXIANG_IMAP_HOST=
SHANYOUXIANG_IMAP_PORT=
SHANYOUXIANG_IMAP_SECURE=
SHANYOUXIANG_FRESH_IMAP_HOST=
SHANYOUXIANG_FRESH_IMAP_PORT=
SHANYOUXIANG_FRESH_IMAP_SECURE=
```

They are still accepted for compatibility, but public deployments should prefer
the generic `MAIL_IMAP_*` variables.

## Docker

For Docker Desktop:

```powershell
docker compose up -d --build
docker compose logs -f
```

When SUB2API runs on the host machine, Docker can usually reach it through:

```env
SUB2API_URL=http://host.docker.internal:8082/admin/accounts
```

When SUB2API runs in another container, put both services on a shared Docker
network and set `SUB2API_URL` to that service name.

## Local Runtime Files

Important private paths:

```text
data/mail/hotmail-accounts.local.json
data/sessions/
data/browser-profiles/
data/debug-login/
data/sub2api-fail-monitor.log
```

These files may contain secrets or enough information to recover active
sessions. Keep them local.
