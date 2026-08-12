'use strict';

const assert = require('assert');

const { scan, redact, shannonEntropy, looksLikeSecret } = require('../../app/security/secretsScanner');

describe('secretsScanner pattern detection', () => {
  it('redacts provider-specific token shapes', () => {
    /** @type {Array<{type: string, secret: string, context: (s: string) => string}>} */
    const cases = [
      { type: 'github-token', secret: `ghp_${'a'.repeat(36)}`, context: (s) => `const t = "${s}";` },
      { type: 'github-pat', secret: `github_pat_${'B'.repeat(30)}`, context: (s) => `token: ${s}` },
      { type: 'aws-access-key-id', secret: 'AKIAIOSFODNN7EXAMPLE', context: (s) => `AWS_ACCESS_KEY_ID=${s}` },
      { type: 'google-api-key', secret: `AIza${'b'.repeat(35)}`, context: (s) => `key=${s}` },
      { type: 'slack-token', secret: 'xoxb-123456789012-abcdefghijkl', context: (s) => `SLACK=${s}` },
      { type: 'stripe-key', secret: `sk_live_${'c'.repeat(24)}`, context: (s) => `stripe(${JSON.stringify(s)})` },
      { type: 'npm-token', secret: `npm_${'d'.repeat(36)}`, context: (s) => `//registry/:_authToken=${s}` },
      { type: 'anthropic-key', secret: `sk-ant-${'e'.repeat(40)}`, context: (s) => `ANTHROPIC_API_KEY=${s}` },
    ];

    for (const { type, secret, context } of cases) {
      const text = context(secret);
      const result = scan(text);
      assert.strictEqual(result.found, true, `${type} not detected in: ${text}`);
      assert.ok(
        result.findings.some((f) => f.type === type),
        `expected type ${type}, got ${result.findings.map((f) => f.type).join(',')}`
      );
      assert.ok(!result.redacted.includes(secret), `${type}: raw value survived redaction`);
      assert.ok(result.redacted.includes(`[REDACTED:${type.toUpperCase()}]`), `${type}: marker missing`);
    }
  });

  it('redacts an entire PEM private key block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAvV8k3jJ8Xh0Fq2Lm9Nn4Pp5Qq6Rr7Ss8Tt9Uu0Vv1Ww2Xx3Yy4',
      'ZzAaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz0123456789',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const result = scan(`const key = \`${pem}\`;`);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.findings[0].type, 'private-key');
    assert.ok(!result.redacted.includes('MIIEowIBAAKCAQEA'), 'key body survived');
    // One finding, not one per line — the whole block is a single match.
    assert.strictEqual(result.findings.length, 1);
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = scan(`Authorization: Bearer ${jwt}`);
    assert.strictEqual(result.found, true);
    assert.ok(result.findings.some((f) => f.type === 'jwt'));
  });

  it('redacts only the password from a connection string, keeping the host', () => {
    // The host is useful context for the model; the password is not.
    const result = scan('DATABASE_URL=postgres://admin:sup3rS3cretPassw0rd@db.internal:5432/app');
    assert.strictEqual(result.found, true);
    assert.ok(!result.redacted.includes('sup3rS3cretPassw0rd'));
    assert.ok(result.redacted.includes('db.internal'), 'host should survive');
  });

  it('finds several distinct secrets in one file', () => {
    const text = `AWS_KEY=AKIAIOSFODNN7EXAMPLE\nGH=ghp_${'z'.repeat(36)}\n`;
    const result = scan(text);
    assert.strictEqual(result.findings.length, 2);
  });
});

describe('secretsScanner entropy detection', () => {
  it('redacts a high-entropy value in credential context', () => {
    const result = scan('const apiKey = "Zk3Lm9Qw7Rt2Yx5Bn8Cv4Df6Gh1Jk0P";');
    assert.strictEqual(result.found, true);
    assert.ok(result.findings.some((f) => f.detector === 'entropy'));
    assert.ok(!result.redacted.includes('Zk3Lm9Qw7Rt2Yx5Bn8Cv4Df6Gh1Jk0P'));
  });

  it('catches several credential-context spellings', () => {
    for (const text of [
      'password: "Xj9Km2Pq7Vt4Nw8Br5Hs3Ld6"',
      'CLIENT_SECRET=Xj9Km2Pq7Vt4Nw8Br5Hs3Ld6',
      '--auth-token=Xj9Km2Pq7Vt4Nw8Br5Hs3Ld6',
      '"access_token": "Xj9Km2Pq7Vt4Nw8Br5Hs3Ld6"',
    ]) {
      assert.strictEqual(scan(text).found, true, text);
    }
  });

  it('leaves ordinary code alone', () => {
    // The failure mode that makes a scanner useless: shredding the file the agent
    // is trying to reason about.
    const code = [
      'function calculateTotalPrice(items, taxRate) {',
      '  const subtotal = items.reduce((sum, item) => sum + item.price, 0);',
      '  return subtotal * (1 + taxRate);',
      '}',
      'const config = { retries: 3, timeoutMs: 30000, endpoint: "http://127.0.0.1:11434" };',
      'import { createHash } from "crypto";',
    ].join('\n');
    const result = scan(code);
    assert.strictEqual(result.found, false, `false positives: ${JSON.stringify(result.findings)}`);
    assert.strictEqual(result.redacted, code);
  });

  it('does not redact a long hash outside credential context', () => {
    const text = 'digest: baf6a787fdffd633537aa2eb51cfd54cb93ff08e28040095462bb63daf552878';
    assert.strictEqual(scan(text).found, false);
  });

  it('ignores obvious placeholders', () => {
    for (const text of [
      'API_KEY=your_api_key_here',
      'password = "changeme"',
      'token: <YOUR_TOKEN>',
      'secret = process.env.MY_SECRET',
      'apiKey: "xxxxxxxxxxxxxxxx"',
    ]) {
      assert.strictEqual(scan(text).found, false, text);
    }
  });

  it('ignores a short value even in credential context', () => {
    assert.strictEqual(scan('password = "hunter2"').found, false);
  });

  it('can be disabled, leaving only high-confidence patterns', () => {
    const text = 'const apiKey = "Zk3Lm9Qw7Rt2Yx5Bn8Cv4Df6Gh1Jk0P";';
    assert.strictEqual(scan(text, { entropy: false }).found, false);
    // Pattern detection still fires with entropy off.
    assert.strictEqual(scan(`k=ghp_${'a'.repeat(36)}`, { entropy: false }).found, true);
  });
});

describe('secretsScanner helpers', () => {
  it('scores entropy sensibly', () => {
    assert.ok(shannonEntropy('aaaaaaaaaaaaaaaa') < 1);
    assert.ok(shannonEntropy('Zk3Lm9Qw7Rt2Yx5Bn8Cv4Df6Gh1Jk0P') > 3.5);
  });

  it('requires character variety, not just entropy', () => {
    // An all-lowercase word can clear the entropy bar; a real token has mixed classes.
    assert.strictEqual(looksLikeSecret('abcdefghijklmnopqrst'), false);
    assert.strictEqual(looksLikeSecret('Zk3Lm9Qw7Rt2Yx5Bn8Cv'), true);
  });

  it('never reveals the value in a finding preview', () => {
    const secret = `ghp_${'q'.repeat(36)}`;
    const result = scan(`token=${secret}`);
    assert.ok(!result.findings[0].preview.includes(secret));
    assert.match(result.findings[0].preview, /chars\)$/);
  });

  it('handles empty and non-string input without throwing', () => {
    assert.strictEqual(scan('').found, false);
    assert.strictEqual(scan(/** @type {any} */ (null)).redacted, '');
    assert.strictEqual(scan(/** @type {any} */ (undefined)).redacted, '');
  });

  it('redact() returns text directly', () => {
    assert.strictEqual(redact('nothing here'), 'nothing here');
    assert.ok(redact('AKIAIOSFODNN7EXAMPLE').includes('[REDACTED:AWS-ACCESS-KEY-ID]'));
  });
});
