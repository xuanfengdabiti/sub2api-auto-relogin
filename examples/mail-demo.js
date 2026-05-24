const mail = require('../src');

async function main() {
  const accounts = mail.loadAccounts();
  console.log(`Saved accounts: ${accounts.length}`);

  const check = await mail.checkAccount('', { top: 3 });
  console.log(JSON.stringify({
    checkOk: check.ok,
    email: check.account ? mail.maskEmail(check.account.email) : '',
    messageCount: check.messageCount || 0,
    error: check.error || '',
  }, null, 2));

  const latestCode = await mail.getLatestVerificationCode('', {
    kind: 'login',
    top: 10,
  });
  console.log(JSON.stringify({
    codeOk: latestCode.ok,
    email: latestCode.account ? mail.maskEmail(latestCode.account.email) : '',
    code: latestCode.code || '',
    subject: latestCode.message?.subject || '',
    receivedDateTime: latestCode.message?.receivedDateTime || '',
    error: latestCode.error || '',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
