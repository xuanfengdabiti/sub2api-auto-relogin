# Mail module

This workspace has a standalone Hotmail/Outlook mail module adapted from the GuJumpgate behavior. The primary CLI entry is the unified program:

`bin\auto-relogin.js`

## What Works Now

- Save Hotmail/Outlook account information locally.
- Import existing GuJumpgate `chrome.storage.local` account data.
- Check whether an account mailbox is readable.
- Fetch the newest INBOX/Junk mail through Microsoft Graph/Outlook.
- Fall back to configured password IMAP when Graph/token mail fetch fails.
- Extract the newest OpenAI/ChatGPT verification code.
- Update account status and refreshed `refreshToken` in the local store when Microsoft returns a new one.

## Local Files

- Account store: `data/mail/hotmail-accounts.local.json`
- GuJumpgate settings copy: `data/mail/gujumpgate-settings.local.json`
- CLI: `bin/auto-relogin.js`
- Public module entry: `src/index.js`
- Client module: `src/mail-client.js`
- Store module: `src/account-store.js`
- Demo: `examples/mail-demo.js`

The `.local.json` files contain secrets. Keep them local.

## Commands

Run from the project root.

```powershell
npm run mail:import
npm run mail:list
npm run mail:check
npm run mail:check-all
npm run mail:latest-code
npm run mail:demo
```

Or call the CLI directly:

```powershell
node bin\mail.js check --account user@example.com --top 5
node bin\mail.js latest-code --account user@example.com --kind login --top 10
```

The legacy `bin\mail.js` command forwards to the unified CLI.

Add or update one account:

```powershell
node bin\mail.js add --email user@example.com --client-id CLIENT_ID --refresh-token REFRESH_TOKEN --password PASSWORD
```

Import line formats accepted by the web UI and CLI:

```text
user@example.com----password
user@example.com----password----refreshToken----clientId
user@example.com----password----clientId----refreshToken
```

The first format uses configured IMAP only. The token formats are auto-detected, so both `refreshToken/clientId` and `clientId/refreshToken` orders are supported.

## Use As A Module

```js
const mail = require('./src');

await mail.importFromGuJumpgateStorage();

const accounts = mail.loadAccounts();
const check = await mail.checkAccount(accounts[0].id);
const latestCode = await mail.getLatestVerificationCode(accounts[0].id, {
  kind: 'login',
  top: 10,
});
```

Useful exported functions:

- `importFromGuJumpgateStorage()`
- `loadAccounts()`
- `upsertAccount(account)`
- `checkAccount(accountIdOrEmail, options)`
- `getLatestVerificationCode(accountIdOrEmail, options)`
- `fetchMailboxMessages(accountIdOrEmail, options)`

## How It Matches GuJumpgate

GuJumpgate's Hotmail path uses `email + clientId + refreshToken`.

The refresh token is exchanged for an access token, then mail is fetched from:

- `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages`
- `https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages`

The module falls back using the same copied Microsoft helper behavior available in `vendor\gujumpgate-v0.1.3-mail\microsoft-email.js`.

The module can also read through password IMAP. Use the generic variables in `.env.local`:

- `MAIL_IMAP_HOST`
- `MAIL_IMAP_PORT`
- `MAIL_IMAP_SECURE`
- `MAIL_IMAP_LOGIN_METHOD`
- `MAIL_IMAP_FALLBACK_HOST`
- `MAIL_IMAP_FALLBACK_PORT`
- `MAIL_IMAP_FALLBACK_SECURE`

Graph remains the first choice when valid token credentials exist. If Graph fails, or if the account only has `email + password`, the module tries the configured IMAP profiles in order to read the latest mailbox messages. Shanyouxiang-specific environment variable names are still accepted as backwards-compatible aliases.

Verification code extraction uses the copied Hotmail utilities and OpenAI mail rules.

## Next Integration Point

The next step is to connect this module to SUB2API account health checks:

1. Detect an invalid SUB2API account.
2. Start OpenAI login/relogin.
3. Use `getLatestVerificationCode()` from `src\mail-client.js`.
4. Export the fresh session JSON.
5. Update/import that JSON into SUB2API.
