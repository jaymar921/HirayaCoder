'use strict';

/**
 * Redacts credentials from anything on its way to the model.
 *
 * Everything that reaches a prompt passes through here: file contents the agent
 * read, context files attached with `+`, script output fed back as an observation,
 * and memory entries. The local model is not an exfiltration risk by itself, but
 * the memory store is a plain-text file on disk that outlives the session, and
 * script output routinely contains tokens. Keeping secrets out of both is cheap.
 *
 * Two detectors, deliberately weighted differently:
 *
 *  - **Pattern** — high-confidence, provider-specific shapes (`ghp_…`, `AKIA…`,
 *    PEM blocks). Redacted unconditionally.
 *  - **Entropy** — a random-looking string is only redacted when it also sits in
 *    credential *context* (assigned to something named `token`/`secret`/`key`, or
 *    in a URL's userinfo). Unconditional entropy redaction shreds ordinary code —
 *    hashes, minified bundles, and base64 assets all look like secrets.
 *
 * Pure — no I/O, fully unit-testable.
 *
 * @module security/secretsScanner
 */

/**
 * @typedef {object} Finding
 * @property {string} type      Detector name, e.g. 'github-token'.
 * @property {number} index     Offset of the match in the source text.
 * @property {number} length
 * @property {string} preview   Masked sample, safe to log.
 * @property {'pattern' | 'entropy'} detector
 */

/**
 * @typedef {object} ScanResult
 * @property {boolean} found
 * @property {Finding[]} findings
 * @property {string} redacted  The text with every finding replaced.
 */

/**
 * High-confidence credential shapes.
 *
 * Ordering matters: more specific patterns run first so that, for example, an
 * Anthropic key is labelled as such rather than caught by the generic rule.
 *
 * @type {Array<{type: string, pattern: RegExp}>}
 */
const PATTERNS = [
  { type: 'private-key', pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  { type: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { type: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { type: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { type: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { type: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { type: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/g },
  { type: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Credentials embedded in a URL: scheme://user:secret@host
  { type: 'url-credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi },
];

/**
 * Assignments that put a value in credential context, e.g. `API_KEY = "…"`,
 * `"password": "…"`, `--token=…`. The captured group is the value.
 */
const ASSIGNMENT_PATTERN =
  /\b((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token|apikey|bearer))\b["']?\s*[:=]\s*["']?([^\s"',;)}\]]{8,})/gi;

/** Values that are obviously not real secrets — placeholders in docs and samples. */
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]+>|\$\{[^}]+\}|%[A-Z_]+%|your[_-]?\w+|changeme|example|placeholder|redacted|null|undefined|true|false|process\.env\.\w+)$/i;

const ENTROPY_MIN_LENGTH = 16;
const ENTROPY_THRESHOLD = 3.5;

/**
 * Shannon entropy in bits per character.
 *
 * @param {string} value
 * @returns {number}
 */
function shannonEntropy(value) {
  if (!value) return 0;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Does this value look random enough, and varied enough, to be a credential?
 *
 * The character-class requirement is what separates a real token from an English
 * sentence, which can also score above the entropy threshold.
 *
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeSecret(value) {
  if (value.length < ENTROPY_MIN_LENGTH) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (/\s/.test(value)) return false;

  const classes =
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value)) + Number(/[^A-Za-z0-9]/.test(value));
  if (classes < 2) return false;

  return shannonEntropy(value) >= ENTROPY_THRESHOLD;
}

/**
 * Build a loggable preview that reveals the shape of a secret without its value.
 *
 * @param {string} value
 * @returns {string}
 */
function maskPreview(value) {
  const text = String(value);
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}…${'*'.repeat(6)}…${text.slice(-2)} (${text.length} chars)`;
}

/**
 * Scan text and produce both findings and a redacted copy.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.entropy] Enable the context-gated entropy detector. Default true.
 * @returns {ScanResult}
 */
function scan(text, opts = {}) {
  const source = typeof text === 'string' ? text : String(text == null ? '' : text);
  const useEntropy = opts.entropy !== false;

  /** @type {Array<{start: number, end: number, type: string, detector: 'pattern' | 'entropy', value: string}>} */
  const hits = [];

  // `matchAll` clones the regex internally, so the shared module-level patterns
  // never carry `lastIndex` state between calls — and it cannot spin forever on a
  // zero-length match the way a manual `exec` loop can.
  for (const { type, pattern } of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      // For url-credentials only the password group is secret; the host is useful
      // context and should survive redaction.
      const hasGroup = match.length > 1 && match[1] !== undefined;
      const value = hasGroup ? match[1] : match[0];
      const start = hasGroup ? source.indexOf(match[1], match.index) : match.index;
      hits.push({ start, end: start + value.length, type, detector: 'pattern', value });
    }
  }

  if (useEntropy) {
    for (const match of source.matchAll(ASSIGNMENT_PATTERN)) {
      const value = match[2];
      if (!looksLikeSecret(value)) continue;
      const start = source.indexOf(value, match.index);
      if (start === -1) continue;
      hits.push({
        start,
        end: start + value.length,
        type: `credential-assignment:${match[1].toLowerCase()}`,
        detector: 'entropy',
        value,
      });
    }
  }

  if (hits.length === 0) return { found: false, findings: [], redacted: source };

  // Resolve overlaps: sort by start, then keep the longest at each position so a
  // PEM block isn't shredded into fragments by a nested match.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  /** @type {typeof hits} */
  const merged = [];
  for (const hit of hits) {
    const previous = merged[merged.length - 1];
    if (previous && hit.start < previous.end) continue;
    merged.push(hit);
  }

  let redacted = '';
  let cursor = 0;
  /** @type {Finding[]} */
  const findings = [];
  for (const hit of merged) {
    redacted += source.slice(cursor, hit.start);
    redacted += `[REDACTED:${hit.type.toUpperCase()}]`;
    cursor = hit.end;
    findings.push({
      type: hit.type,
      index: hit.start,
      length: hit.end - hit.start,
      preview: maskPreview(hit.value),
      detector: hit.detector,
    });
  }
  redacted += source.slice(cursor);

  return { found: true, findings, redacted };
}

/**
 * Convenience wrapper returning only the redacted text.
 *
 * @param {string} text
 * @param {object} [opts]
 * @returns {string}
 */
function redact(text, opts = {}) {
  return scan(text, opts).redacted;
}

module.exports = {
  scan,
  redact,
  shannonEntropy,
  looksLikeSecret,
  maskPreview,
  PATTERNS,
  ENTROPY_THRESHOLD,
  ENTROPY_MIN_LENGTH,
};
