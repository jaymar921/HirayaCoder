'use strict';

/**
 * The commands a request writes out in full, ready to be run rather than retyped.
 *
 * ## Why
 *
 * The benchmark brief opens with the exact command that creates the project:
 *
 *     1. Scaffold a new project with `npm create vite@latest todo-glass-app -- --template react`
 *
 * Every failure to scaffold measured in the 0.9.0 sweep was a failure to reproduce that
 * line. `qwen3.5:0.8b` ran it, ran it again, then invented `--yes`, then passed
 * `.gitignore` as the working directory. None of that is a judgement failure — the
 * command was on the screen, in backticks, and the model was being asked to transcribe
 * it into a JSON field.
 *
 * It is the same argument as `agent/dictation`, one level up: where the user has already
 * supplied the answer, the extension should use it instead of asking a 1B model to
 * remember it.
 *
 * ## What this is not
 *
 * It is not a licence to run things. Nothing here decides that a command *may* run —
 * that is `security/permissionGate` and its allow-list, unchanged, and the commands this
 * finds are exactly the ones that reach the network, so they always confirm. What this
 * removes is the transcription step, not the approval.
 *
 * It is also deliberately narrow: only a command that creates the project directory, and
 * only when that directory does not exist yet. A general "run what the document says"
 * would be a different and much larger claim.
 *
 * @module core/namedCommands
 */

const logger = require('../utils/logger');

/** Commands are read out of inline code spans and fenced blocks, never out of prose. */
const CODE_SPAN = /`([^`\n]{4,300})`/g;

/** A fenced block, whose lines are considered one at a time. */
const FENCED = /```[a-zA-Z0-9+#.-]*[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * Binaries that scaffold a project.
 *
 * Short and specific. A longer list would start matching the build and test commands a
 * brief also spells out, and running those before anything exists is noise at best.
 */
const SCAFFOLD = [
  /^npm\s+(?:create|init)\s+\S/i,
  /^npx\s+(?:create-|degit\b)/i,
  /^(?:yarn|pnpm|bun)\s+(?:create|dlx)\s+\S/i,
  /^(?:mvn|gradle)\s+archetype:generate\b/i,
  /^(?:django-admin|rails|dotnet|cargo)\s+new\b/i,
];

/** Longer than this and it is a script, not a command somebody typed into a shell. */
const MAX_COMMAND_CHARS = 300;

/**
 * Every command-looking string in a request, in the order it was written.
 *
 * @param {string} text
 * @returns {string[]}
 */
function candidates(text) {
  const source = String(text || '');
  /** @type {string[]} */
  const found = [];

  for (const match of source.matchAll(CODE_SPAN)) found.push(match[1]);
  for (const block of source.matchAll(FENCED)) {
    for (const line of block[1].split(/\r?\n/)) {
      const cleaned = line.replace(/^\s*\$\s*/, '').trim();
      if (cleaned) found.push(cleaned);
    }
  }

  return found
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && candidate.length <= MAX_COMMAND_CHARS)
    // One line only. A code span holding a paragraph is documentation, not a command.
    .filter((candidate) => !candidate.includes('\n'));
}

/**
 * The command this request gives for creating `directory`, if it gives one.
 *
 * Requires the command to name the directory, which is what makes the match safe to act
 * on: `npm create vite@latest todo-glass-app -- --template react` is unambiguously about
 * `todo-glass-app`, and a scaffold command that names some other folder is about some
 * other folder.
 *
 * @param {string} text       The user's request.
 * @param {string} directory  The project directory, e.g. `todo-glass-app`.
 * @returns {string}          The command, or '' when the request does not give one.
 */
function scaffoldFor(text, directory) {
  const target = String(directory || '').trim();
  if (!target) return '';

  for (const candidate of candidates(text)) {
    if (!SCAFFOLD.some((pattern) => pattern.test(candidate))) continue;
    // Word-boundary match on the directory, so `todo-glass-app` does not match
    // `todo-glass-app-old` and a bare `.` never matches anything.
    if (!new RegExp(`(?:^|[\\s/"'])${escapeForRegExp(target)}(?:[\\s/"']|$)`).test(candidate)) continue;
    logger.info(`The request names its own scaffold command for ${target}.`);
    return candidate;
  }
  return '';
}

/** @param {string} text */
function escapeForRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { scaffoldFor, candidates, escapeForRegExp, SCAFFOLD, MAX_COMMAND_CHARS };
