#!/usr/bin/env node
/**
 * Send one real email, and say exactly what went wrong if it does not arrive.
 *
 *   npm run mail:test                      → sends to MAIL_FROM
 *   npm run mail:test -- you@example.com   → sends to that address
 *
 * WHY THIS EXISTS
 * ---------------
 * `MailService` swallows a send failure on purpose: the password-reset flow must
 * return the same sentence whether or not the address has an account, so the
 * reason can only ever go to the server log. That is right for the flow and
 * useless for setting SMTP up, where you need the failure *now*, in full, with
 * the credential you just typed.
 *
 * SMTP fails in about six ways and every one of them arrives as a terse code —
 * `EAUTH`, `ETIMEDOUT`, `ESOCKET`, `535`, `553`. Each has one likely cause and
 * one fix, and neither is in the message. So this names them.
 *
 * WHY IT DOES NOT IMPORT MailService
 * ----------------------------------
 * That class lives inside Nest's DI and reads config through `ConfigService`.
 * Booting the whole API to test a mail server means a database connection and
 * every module's startup — so a Postgres that is down would read as a mail
 * problem. This reads `.env` and talks to nodemailer directly, which is the
 * same two things `MailService` does and nothing else.
 *
 * It is deliberately NOT wired to the reset flow. A tool that exercised the
 * real endpoint would need an account to exist and would spend a token; this
 * answers "can this machine send email at all", which is the question that
 * blocks everything else.
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const transport = (process.env.MAIL_TRANSPORT ?? '').trim().toLowerCase();
const host = process.env.SMTP_HOST ?? '';
const port = Number(process.env.SMTP_PORT ?? 587);
const secure = (process.env.SMTP_SECURE ?? '').toLowerCase() === 'true';
const user = process.env.SMTP_USER ?? '';
const pass = process.env.SMTP_PASS ?? '';
const from = process.env.MAIL_FROM ?? '';
/**
 * `MAIL_FROM` may carry a display name — `OneCare HMS <admin@example.com>` —
 * which is the RFC 5322 form and what nodemailer expects. Everything below
 * that needs the bare address (the default recipient, and the domain whose DNS
 * gets checked) has to unwrap it, or it ends up looking up the TXT records of
 * `example.com>` and reporting that a perfectly good domain publishes nothing.
 */
const fromAddress = (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
const fromDomain = fromAddress.split('@')[1] ?? '';
const to = (process.argv[2] || fromAddress || '').trim();

console.log('\n  Mail configuration, as the API reads it:\n');
console.log(`    MAIL_TRANSPORT  ${transport || '(unset)'}`);
console.log(`    MAIL_FROM       ${from || '(unset)'}`);
console.log(`    SMTP_HOST       ${host || '(unset)'}`);
console.log(`    SMTP_PORT       ${port}`);
console.log(`    SMTP_SECURE     ${secure}`);
console.log(`    SMTP_USER       ${user || '(unset)'}`);
// Length only. A password echoed to a terminal ends up in scrollback and in
// whatever somebody pastes into a chat window asking why it does not work.
console.log(`    SMTP_PASS       ${pass ? `set, ${pass.length} characters` : '(unset)'}`);
console.log('');

if (transport !== 'smtp') {
  console.log(
    `  MAIL_TRANSPORT is "${transport || 'unset'}", so nothing is sent by the API either.\n\n` +
      '    log    — the message, link included, is written to the API console. The flow\n' +
      '             works end to end and no mail leaves the building.\n' +
      '    unset  — nothing is sent and the reset links are hidden on all three\n' +
      '             sign-in screens, because a link that promises an email and\n' +
      '             sends none is worse than no link.\n\n' +
      '  Set MAIL_TRANSPORT=smtp with the SMTP_* block, then run this again.\n',
  );
  process.exit(1);
}

if (!host || !to) {
  console.error(
    `  ${!host ? 'SMTP_HOST is not set.' : 'No recipient.'}\n\n` +
      '    npm run mail:test -- you@example.com\n',
  );
  process.exit(1);
}

/**
 * The six ways this fails, and what each one actually means.
 *
 * Written out because the raw errors are the kind somebody pastes into a search
 * engine — and the answer is nearly always one of these, specific to the
 * provider rather than to the code.
 */
function explain(err) {
  const code = err.code || '';
  const text = String(err.message || '');

  if (code === 'EAUTH' || /535|534|Username and Password not accepted/i.test(text)) {
    return [
      'The server rejected the credentials.',
      '',
      '  On Gmail this is almost always an ordinary account password. Gmail does not',
      '  accept those over SMTP — it needs an **App Password**, which requires',
      '  2-Step Verification on the account and is 16 characters. Generate one at',
      '  Google Account → Security → App passwords, and put it in SMTP_PASS with no',
      '  spaces. SMTP_USER is the full address.',
      '',
      '  On a transactional provider (Resend, SendGrid, Brevo, Postmark), SMTP_USER',
      '  is usually a fixed literal like "apikey" or "resend" rather than your',
      '  address, and SMTP_PASS is the API key. Check their SMTP page — this is the',
      '  single commonest mistake.',
    ].join('\n');
  }

  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || /timed out|greeting never/i.test(text)) {
    return [
      'Nothing answered on that host and port.',
      '',
      `  Either SMTP_HOST is wrong, or outbound port ${port} is blocked. Corporate`,
      '  networks and some ISPs block 25 and 465 outright; 587 is the one most',
      '  often left open. A proxy that blocked api.expo.dev on this machine may',
      '  well block this too.',
      '',
      '  Try SMTP_PORT=587 with SMTP_SECURE=false first — that is STARTTLS, which',
      '  is what most providers expect.',
    ].join('\n');
  }

  if (code === 'ESOCKET' || /wrong version number|SSL routines/i.test(text)) {
    return [
      'TLS was negotiated the wrong way round — SMTP_SECURE does not match the port.',
      '',
      '  SMTP_SECURE=true means implicit TLS and belongs only on port 465.',
      '  On 587 the connection starts plain and upgrades with STARTTLS, which',
      '  nodemailer does by default, so SMTP_SECURE must be false there.',
      '',
      `  You have port ${port} with SMTP_SECURE=${secure}. One of the two is wrong.`,
    ].join('\n');
  }

  if (/553|554|5\.7\.1|not allowed|does not match|From address/i.test(text)) {
    return [
      'The server refused the From address.',
      '',
      '  Most providers only let you send as an address or domain you have verified.',
      '  Gmail rewrites or rejects a From that is not the authenticated account, so',
      `  MAIL_FROM should be exactly SMTP_USER — currently "${fromAddress}" against`,
      `  "${user}".`,
      '',
      '  On a transactional provider, verify the sending domain first.',
    ].join('\n');
  }

  /*
   * These two look alike and mean opposite things, and conflating them sends
   * somebody to check a hostname that is perfectly correct.
   *
   *   ENOTFOUND  the resolver answered, and there is no such name → a typo.
   *   EAI_AGAIN  the resolver did not answer at all → no DNS, no network, or a
   *              proxy in the way. The hostname is very likely fine.
   *
   * Written out because the first version of this function matched
   * `getaddrinfo` for both and reported a typo for an offline machine — the
   * exact class of confidently-wrong diagnostic this script exists to replace.
   */
  if (code === 'EAI_AGAIN' || /EAI_AGAIN/i.test(text)) {
    return [
      'DNS did not answer, so the hostname was never actually looked up.',
      '',
      `  This is almost certainly not a typo in SMTP_HOST — "${host}" may well be`,
      '  correct. The machine has no working resolver, no network, or a proxy is',
      '  intercepting the lookup. The same proxy that blocks api.expo.dev here is',
      '  a candidate.',
      '',
      '  Try `nslookup ' + host + '` from the same machine. If that fails too, the',
      '  problem is the network rather than this configuration.',
    ].join('\n');
  }

  if (code === 'ENOTFOUND' || code === 'EDNS' || /getaddrinfo|ENOTFOUND/i.test(text)) {
    return [
      `The resolver answered and there is no host called "${host}".`,
      '',
      '  That is a typo, or a hostname that only exists inside another network.',
      '  Many providers use `smtp.` rather than `mail.`, and some publish the',
      '  relay under a different domain entirely — check their SMTP page.',
    ].join('\n');
  }

  return 'No specific cause recognised. The server’s own words are above.';
}

/**
 * Report what the sending domain publishes: SPF, DMARC, and a DKIM selector.
 *
 * WHY THE SCRIPT LOOKS THIS UP RATHER THAN TELLING SOMEBODY TO
 * ------------------------------------------------------------
 * The first version of this printed "check SPF with nslookup — no record at all
 * is the usual answer", which was a guess dressed as advice. The domain it was
 * aimed at *did* have SPF, so the advice sent somebody to confirm something
 * that was already fine and said nothing about what was actually missing.
 *
 * A tool that can answer its own question should. `dns` is in the standard
 * library and these are three lookups.
 *
 * WHY DKIM IS CHECKED BY GUESSING SELECTORS
 * -----------------------------------------
 * DKIM has no discoverable record: the selector is chosen by whoever signs, and
 * is only visible in a signed message's headers. So this probes the handful
 * that cPanel, Plesk and the common providers actually use. A miss therefore
 * means "not found under a common selector" rather than "not signed", and it
 * says so — a tool that reported "no DKIM" for a domain signing under a
 * selector it did not know would be the same confidently-wrong diagnosis this
 * script exists to replace.
 */
async function reportAuthDns(domain) {
  if (!domain) return;
  const dns = require('node:dns').promises;

  const txt = async (name) => {
    try {
      return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
    } catch (err) {
      /*
       * Only two codes mean "the resolver answered and there is no such
       * record": ENODATA and ENOTFOUND. Everything else — EAI_AGAIN,
       * ECONNREFUSED, ETIMEOUT, SERVFAIL — means the lookup did not happen,
       * and returning an empty array for those would print `SPF ✗ no record`
       * for a domain whose SPF is perfectly fine.
       *
       * Written as an allowlist rather than a list of things to rethrow,
       * because the first version was the other way round, missed
       * ECONNREFUSED, and reported a resolver-less machine as a domain with no
       * mail authentication at all. Caught by running it somewhere with no
       * DNS; a machine that resolves normally would never have shown it.
       */
      if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return [];
      throw err;
    }
  };

  console.log(`  What ${domain} publishes for mail authentication:\n`);

  try {
    const spf = (await txt(domain)).filter((r) => /^v=spf1/i.test(r));
    const dmarc = (await txt(`_dmarc.${domain}`)).filter((r) => /^v=DMARC1/i.test(r));

    console.log(spf.length ? `    SPF     ✓ ${spf[0]}` : '    SPF     ✗ no v=spf1 record');
    console.log(
      dmarc.length ? `    DMARC   ✓ ${dmarc[0]}` : '    DMARC   ✗ no _dmarc record',
    );

    /* The selectors cPanel, Plesk and the usual providers sign with. */
    const SELECTORS = ['default', 'dkim', 'mail', 'x', 's1', 's2', 'google', 'k1'];
    let found = null;
    for (const s of SELECTORS) {
      const rec = await txt(`${s}._domainkey.${domain}`);
      if (rec.some((r) => /p=|v=DKIM1/i.test(r))) {
        found = s;
        break;
      }
    }
    console.log(
      found
        ? `    DKIM    ✓ signing key published at ${found}._domainkey`
        : `    DKIM    ? none under the common selectors (${SELECTORS.join(', ')})`,
    );

    console.log('');
    if (!dmarc.length) {
      console.log(
        [
          '  No DMARC record. That is not itself a rejection — with SPF passing,',
          '  most receivers will accept — but it removes the strongest signal you',
          '  could give them, and on a shared-hosting IP whose reputation you do',
          '  not control it is often the difference between the inbox and spam.',
          '  `v=DMARC1; p=none; rua=mailto:you@yourdomain` is the safe first step:',
          '  it asks for reports and changes nothing about how mail is treated.',
          '',
        ].join('\n'),
      );
    }
    if (!found) {
      console.log(
        [
          '  No DKIM found under a common selector, which may simply mean yours is',
          '  named something else — check the mail section of your hosting control',
          '  panel. If it genuinely is not signing, that plus a shared sending IP is',
          '  the usual reason a message is accepted and then quietly filed as spam.',
          '',
        ].join('\n'),
      );
    }
  } catch {
    console.log(
      '    (could not check — this machine has no working DNS resolver)\n',
    );
  }
}

(async () => {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    console.error('  nodemailer is not installed. Run `npm install` in backend/.\n');
    process.exit(1);
  }

  const mailer = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    // Fail in seconds rather than hanging. A blocked port otherwise sits there
    // long enough that people assume the script is broken and kill it, which
    // hides the one error that would have told them what was wrong.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });

  /*
   * `verify` first, then send. Two steps because they fail for different
   * reasons: verify covers the connection and the credentials, the send covers
   * the From address and the recipient. Collapsing them means a rejected sender
   * reads as a rejected password.
   */
  try {
    console.log('  Connecting and authenticating…');
    await mailer.verify();
    console.log('  ✓ The server accepted the connection and the credentials.\n');
  } catch (err) {
    console.error(`  ✗ ${err.message}\n`);
    console.error(`  ${explain(err)}\n`);
    process.exit(1);
  }

  try {
    console.log(`  Sending a test message to ${to}…`);
    const info = await mailer.sendMail({
      from,
      to,
      subject: 'OneCare HMS — mail test',
      text: [
        'If you are reading this, the API can send email.',
        '',
        'Password-reset links will now be delivered rather than written to the',
        'server log. Both sign-in screens and the vendor console will show the',
        '"Forgot your password?" link, because GET /health reports mail as',
        'available.',
        '',
        'Sent by `npm run mail:test`. Nothing in the application generated it.',
      ].join('\n'),
    });

    console.log(`  ✓ Accepted by the server. Message id: ${info.messageId}`);

    /*
     * The server's own reply, verbatim, and the recipient lists.
     *
     * The first version of this printed only "accepted" and a message id, and
     * that turned out to be almost useless when a message was taken by the
     * relay and never arrived: there was nothing to quote at whoever runs the
     * mail server. The 250 line usually carries a **queue id**, which is the
     * one string that lets them find this exact message in their logs — and it
     * was being thrown away.
     */
    if (info.response) console.log(`  server said:  ${info.response}`);
    if (info.accepted?.length) console.log(`  accepted:     ${info.accepted.join(', ')}`);
    if (info.rejected?.length) console.log(`  ⚠ rejected:   ${info.rejected.join(', ')}`);
    if (info.envelope) {
      console.log(`  envelope:     from ${info.envelope.from} to ${info.envelope.to.join(', ')}`);
    }

    console.log(
      [
        '',
        '  ACCEPTED IS NOT DELIVERED, and the gap is where reset emails go missing.',
        '',
        '  All the line above means is that your relay took custody. It can still',
        '  bounce afterwards, and the recipient can still file it as spam — neither',
        '  of which this connection can see, because both happen after it closes.',
        '',
      ].join('\n'),
    );

    await reportAuthDns(fromDomain);

    console.log(
      [
        '  If it does not arrive, in this order:',
        '',
        `    1. The ${fromAddress} mailbox, for a bounce. An asynchronous rejection is`,
        '       emailed back to the envelope sender and quotes the receiving',
        '       server’s actual reason — `550 5.7.26 unauthenticated email` and',
        '       the like. The single most useful place to look, and the one people',
        '       skip because the send reported success.',
        '    2. The recipient’s spam folder. If it is there, open it and use',
        '       "Show original" (Gmail) — the header block states SPF, DKIM and',
        '       DMARC as pass or fail, which is the definitive answer rather than',
        '       a guess.',
        '    3. The relay’s own log, using the queue id in the server reply above.',
        '       That string is what lets whoever runs the mail server find this',
        '       exact message.',
        '',
      ].join('\n'),
    );
  } catch (err) {
    console.error(`  ✗ ${err.message}\n`);
    console.error(`  ${explain(err)}\n`);
    process.exit(1);
  }
})();
