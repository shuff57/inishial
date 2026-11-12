// The SMTP transport behind every outbound mail (functions/_lib/smtp.js), run
// against the fake Gmail server in helpers.mjs. The endpoint tests cover that a
// mail goes out; these cover what is on the wire and every way it can be refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendViaSmtp } from '../functions/_lib/smtp.js';
import { mailEnv, MAIL_FROM, MAIL_REPLY_TO, SMTP_PASSWORD } from './helpers.mjs';

const MSG = { to: 'family@example.com', subject: 'Your access code', text: 'Code: ABCD2345', html: '<p>Code: ABCD2345</p>', replyTo: MAIL_REPLY_TO };

test('opens a STARTTLS connection to Gmail on 587 and sends as the account that signs in', async () => {
  const { env, sent, calls } = mailEnv();
  const out = await sendViaSmtp(env, MSG);
  assert.match(out.messageId, /^<[0-9a-f-]+@inishial\.pages\.dev>$/);
  assert.equal(calls[0].hostname, 'smtp.gmail.com');
  assert.equal(calls[0].port, 587);
  assert.equal(calls[0].secureTransport, 'starttls');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, MAIL_FROM, 'the From address is the Gmail account, as Gmail would rewrite it anyway');
  assert.equal(sent[0].mailFrom, MAIL_FROM, 'and so is the envelope sender');
  assert.equal(sent[0].replyTo, MAIL_REPLY_TO);
  assert.equal(sent[0].rcptTo, 'family@example.com');
  assert.equal(sent[0].subject, 'Your access code');
  assert.match(sent[0].body, /Code: ABCD2345/);
});

test('the app password works with or without the spaces Google displays', async () => {
  const { env, sent } = mailEnv({ SMTP_PASSWORD: SMTP_PASSWORD.replace(/\s/g, '') });
  await sendViaSmtp(env, MSG);
  assert.equal(sent.length, 1);
});

test('a student name with accents and a non-ASCII subject survive intact', async () => {
  const { env, sent } = mailEnv();
  await sendViaSmtp(env, { ...MSG, subject: 'Código para José Álvarez', text: 'Hola José Álvarez — código ABCD2345', html: '<p>José Álvarez</p>' });
  assert.equal(sent[0].subject, 'Código para José Álvarez');
  assert.match(sent[0].body, /José Álvarez — código ABCD2345/);
  assert.match(sent[0].headers.subject, /^=\?UTF-8\?B\?/, 'the header itself is RFC 2047 encoded, not raw UTF-8');
});

test('a body line that is just a dot, or fakes a MIME boundary, cannot end the message early', async () => {
  const { env, sent } = mailEnv();
  const nasty = 'line one\r\n.\r\n--inishial_fake\r\nBcc: attacker@evil.test\r\n.\r\nlast line';
  await sendViaSmtp(env, { ...MSG, text: nasty, html: '' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /last line/, 'everything after the dot line is still in the body');
  assert.equal(sent[0].headers.bcc, undefined, 'and an injected Bcc line did not become a header');
  assert.equal(sent[0].rcptTo, 'family@example.com');
});

test('CR/LF in the subject cannot add headers', async () => {
  const { env, sent } = mailEnv();
  await sendViaSmtp(env, { ...MSG, subject: 'Hello\r\nBcc: attacker@evil.test' });
  assert.equal(sent[0].headers.bcc, undefined);
  assert.match(sent[0].subject, /^Hello\s+Bcc: attacker@evil\.test$/, 'it is flattened onto the subject line, harmlessly');
});

test('a recipient that is not a bare address is refused before anything is sent', async () => {
  for (const to of ['a@b.test, c@d.test', 'x@y.test>\r\nRCPT TO:<z@z.test', 'Name <a@b.test>', '"a b"@c.test', 'no-at-sign']) {
    const { env, sent, calls } = mailEnv();
    await assert.rejects(sendViaSmtp(env, { ...MSG, to }), (e) => e.code === 'E_SMTP_BAD_RECIPIENT', to);
    assert.equal(sent.length, 0);
    assert.equal(calls.length, 0, 'no connection was even opened');
  }
});

test('a Reply-To that is not a bare address is refused', async () => {
  const { env, sent } = mailEnv();
  await assert.rejects(sendViaSmtp(env, { ...MSG, replyTo: 'a@b.test\r\nBcc: z@z.test' }), (e) => e.code === 'E_SMTP_BAD_REPLY_TO');
  assert.equal(sent.length, 0);
});

test('no credentials fails honestly instead of connecting', async () => {
  const { env, calls } = mailEnv({ SMTP_PASSWORD: '' });
  await assert.rejects(sendViaSmtp(env, MSG), (e) => e.code === 'E_NO_CREDS');
  assert.equal(calls.length, 0);
});

test('a refused sign-in is reported as an auth failure, and the password is never echoed', async () => {
  const { env, sent } = mailEnv({}, { reject: { auth: true } });
  await assert.rejects(sendViaSmtp(env, MSG), (e) => {
    assert.equal(e.code, 'E_SMTP_AUTH');
    assert.ok(!e.message.includes(SMTP_PASSWORD.replace(/\s/g, '')), 'the app password must not appear in the error');
    return true;
  });
  assert.equal(sent.length, 0);
});

test('each refusal after sign-in maps to its own code', async () => {
  const cases = [['mailFrom', 'E_SMTP_MAIL_FROM'], ['rcpt', 'E_SMTP_RCPT'], ['data', 'E_SMTP_REJECTED']];
  for (const [step, code] of cases) {
    const { env, sent } = mailEnv({}, { reject: { [step]: true } });
    await assert.rejects(sendViaSmtp(env, MSG), (e) => e.code === code, step);
    assert.equal(sent.length, 0, `nothing is recorded as sent when ${step} is refused`);
  }
});

test('a connection that cannot be opened is reported, not thrown raw', async () => {
  const { env } = mailEnv({ SMTP_CONNECT: () => { throw new Error('connection refused'); } });
  await assert.rejects(sendViaSmtp(env, MSG), (e) => e.code === 'E_SMTP_CONNECT');
});

test('a mail module failure surfaces as { ok: false } and never throws (what the endpoints rely on)', async () => {
  const { sendPasswordReset } = await import('../functions/_lib/mail.js');
  const { env } = mailEnv({}, { reject: { auth: true } });
  const out = await sendPasswordReset(env, 'teacher@school.test', 'tok123', 30);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'E_SMTP_AUTH');
});
