# sub2api-auto-relogin

Automatically watches SUB2API accounts, relogs ChatGPT accounts when their
sessions fail, reads the email login code, captures a fresh ChatGPT session,
and imports it back into SUB2API with the configured group, proxy, and
concurrency settings.

The project also includes a small web UI for managing mailbox records and
viewing monitor logs.

> This repository is a personal automation tool. Read
> [DISCLAIMER.md](./DISCLAIMER.md) before using it.

## What It Does

- Polls SUB2API on an interval and only handles accounts in configured groups.
- Detects failed OpenAI OAuth accounts in SUB2API.
- Opens an isolated Chromium profile for ChatGPT email-code login.
- Reads the latest OpenAI/ChatGPT verification code from the configured mailbox.
- Captures `https://chatgpt.com/api/auth/session`.
- Imports the fresh session into SUB2API.
- Applies the configured SUB2API group, proxy, concurrency, priority, and rate multiplier.
- Provides a web UI on `http://localhost:8083` by default.

## What It Does Not Include

This repository should not include your local runtime data:

- SUB2API admin username or password
- Mailbox passwords, refresh tokens, or client IDs
- ChatGPT session JSON files
- Browser profiles, cookies, screenshots, or debug dumps
- Local logs and monitor state

These files live under `data/` and `.env.local`, both of which are ignored.

## Recommended Docker Install

Docker is the recommended way to run this project. It avoids local Node.js,
Chromium, and Playwright version issues.

Run these commands one by one on Windows:

```powershell
git clone https://github.com/xuanfengdabiti/sub2api-auto-relogin.git
cd sub2api-auto-relogin
copy .env.local.example .env.local
notepad .env.local
docker compose up -d --build
```

Then open:

```text
http://localhost:8083
```

If your SUB2API service runs on the host machine, use this value in
`.env.local` when running through Docker:

```env
SUB2API_URL=http://host.docker.internal:8082/admin/accounts
```

To update later:

```powershell
git pull
docker compose up -d --build
```

## Quick Start

Requirements:

- Docker Desktop, recommended
- A running SUB2API instance
- Mailboxes that can receive ChatGPT login codes
- A proxy configured in SUB2API if your ChatGPT login requires one

Create your local env file:

```powershell
copy .env.local.example .env.local
```

Edit `.env.local` and fill at least:

```env
SUB2API_URL=http://127.0.0.1:8082/admin/accounts
SUB2API_EMAIL=your-sub2api-admin@example.com
SUB2API_PASSWORD=your-sub2api-password
SUB2API_GROUP_NAMES=your-group-name
SUB2API_PROXY_NAME=your-proxy-name
```

Start it with Docker:

```powershell
docker compose up -d --build
```

Open the web UI:

```text
http://localhost:8083
```

## Mailbox Setup

Mailboxes are stored locally in `data/mail/hotmail-accounts.local.json`.

You can add one or more mailbox lines in the web UI, or use the CLI:

```powershell
node bin\auto-relogin.js mail:add --line "user@example.com----PASSWORD"
node bin\auto-relogin.js mail:add --line "user@example.com----PASSWORD----CLIENT_ID----REFRESH_TOKEN"
node bin\auto-relogin.js mail:check --account user@example.com
```

The separator is any run of at least two hyphens, so `--`, `---`, and `----`
are accepted.

Supported mailbox fetch modes:

- Microsoft Graph/Outlook API with `clientId + refreshToken`
- Password IMAP with provider-specific IMAP settings
- Graph first, then IMAP fallback when both token and password are available

For your own mailbox provider, configure:

```env
MAIL_IMAP_HOST=imap.example.com
MAIL_IMAP_PORT=993
MAIL_IMAP_SECURE=1
MAIL_IMAP_LOGIN_METHOD=LOGIN
```

Some mailbox vendors provide Microsoft accounts with custom IMAP gateways.
This project does not require any specific vendor; replace the IMAP settings
with your provider's values. Shanyouxiang-compatible `SHANYOUXIANG_*`
environment variables are still accepted as backwards-compatible aliases.

See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for the full list.

## Commands

```powershell
node bin\auto-relogin.js status
node bin\auto-relogin.js run --once
node bin\auto-relogin.js run
node bin\auto-relogin.js web --port 8083

node bin\auto-relogin.js sub2api:check --json
node bin\auto-relogin.js relogin:capture --account user@example.com --headless
node bin\auto-relogin.js relogin:import --account user@example.com --headless

node bin\auto-relogin.js mail:list
node bin\auto-relogin.js mail:check --account user@example.com
node bin\auto-relogin.js mail:latest-code --account user@example.com
node bin\auto-relogin.js mail:import-lines --from accounts.txt
```

## Safety Notes

- Test with one account first using `relogin:capture`.
- Keep `.env.local` and `data/` private.
- Do not commit exported SUB2API JSON or ChatGPT session files.
- The monitor deletes local mailbox and matching SUB2API records only when the
  mailbox is confirmed invalid or ChatGPT shows the account deleted/deactivated.
- Ordinary login failures, Cloudflare checks, temporary region errors, and
  missing session tokens are treated as retryable.

## Vendored Code

Parts of the mail-code fetching behavior are adapted from the GuJumpgate mail
implementation under `vendor/gujumpgate-v0.1.3-mail`. Its bundled
`package.json` declares MIT. Verify upstream licensing before redistributing a
public fork.
