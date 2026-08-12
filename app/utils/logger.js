'use strict';

/**
 * Local-only logger backed by a VS Code output channel.
 *
 * Deliberately has no transport, no buffering to a remote sink, and no crash
 * reporter — per the no-telemetry requirement, log output never leaves the machine
 * and exists purely for the developer reading the Output panel.
 *
 * @module utils/logger
 */

/** @typedef {'error' | 'warn' | 'info' | 'debug'} LogLevel */

/**
 * Level ordering. A Map rather than an object because the level comes from user
 * settings, and an object lookup would resolve `'constructor'` to a prototype
 * member instead of failing cleanly.
 *
 * @type {Map<string, number>}
 */
const LEVELS = new Map([
  ['error', 0],
  ['warn', 1],
  ['info', 2],
  ['debug', 3],
]);

/** @type {import('vscode').OutputChannel | null} */
let channel = null;

/** @type {LogLevel} */
let currentLevel = 'info';

/**
 * Bind the logger to an output channel. Called once from `activate()`.
 *
 * @param {import('vscode').OutputChannel} outputChannel
 */
function attach(outputChannel) {
  channel = outputChannel;
}

/**
 * @param {LogLevel} level
 */
function setLevel(level) {
  if (LEVELS.has(level)) currentLevel = level;
}

/** @returns {LogLevel} */
function getLevel() {
  return currentLevel;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.message}\n${value.stack || ''}`.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * @param {LogLevel} level
 * @param {unknown[]} parts
 */
function write(level, parts) {
  const threshold = LEVELS.get(currentLevel);
  const severity = LEVELS.get(level);
  if (severity === undefined || threshold === undefined || severity > threshold) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${level.toUpperCase()}] ${parts.map(stringify).join(' ')}`;
  if (channel) channel.appendLine(line);
  else if (level === 'error') console.error(line);
}

module.exports = {
  attach,
  setLevel,
  getLevel,
  /** @param {...unknown} parts */
  error: (...parts) => write('error', parts),
  /** @param {...unknown} parts */
  warn: (...parts) => write('warn', parts),
  /** @param {...unknown} parts */
  info: (...parts) => write('info', parts),
  /** @param {...unknown} parts */
  debug: (...parts) => write('debug', parts),
};
