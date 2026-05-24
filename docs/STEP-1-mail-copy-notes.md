# Mail Module Notes

The mail module was adapted from GuJumpgate's Hotmail/Outlook mail behavior.
Vendored source lives under:

```text
vendor/gujumpgate-v0.1.3-mail
```

Important files:

- `microsoft-email.js`: Microsoft refresh token to access token, then
  Graph/Outlook mail fetch.
- `hotmail-utils.js`: account normalization, latest message selection, and
  verification code parsing.
- `flows/openai/mail-rules.js`: OpenAI/ChatGPT code matching rules.

## Implementation Notes

The Hotmail/Outlook token path does not scrape the web inbox:

1. Each account can store `email`, `clientId`, and `refreshToken`.
2. `microsoft-email.js` exchanges the refresh token for an access token.
3. Mail is fetched from Microsoft Graph first:
   `https://graph.microsoft.com/v1.0/me/mailFolders/{inbox|junkemail}/messages`
4. It can fall back to Outlook API.
5. Latest messages are sorted by received time, then code patterns extract the
   newest OpenAI/ChatGPT verification code.

The password path uses configured IMAP profiles from `.env.local`.

## Local Data

Local mailbox records are stored under:

```text
data/mail/hotmail-accounts.local.json
```

That file contains mailbox credentials and must not be committed.
