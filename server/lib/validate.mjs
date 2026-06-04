/**
 * Lightweight input validation. No external schema lib — keep it explicit.
 */
import { appError, Codes } from './errors.mjs';

export function required(obj, keys) {
  const missing = keys.filter((k) => obj[k] === undefined || obj[k] === null || obj[k] === '');
  if (missing.length) {
    throw appError(Codes.BAD_REQUEST, `Missing required field(s): ${missing.join(', ')}`);
  }
}

export function ensureString(value, name, { maxLen = 2_000_000 } = {}) {
  if (typeof value !== 'string') {
    throw appError(Codes.BAD_REQUEST, `${name} must be a string`);
  }
  if (value.length > maxLen) {
    throw appError(Codes.BAD_REQUEST, `${name} exceeds max length (${maxLen})`);
  }
  return value;
}

export function ensureArray(value, name) {
  if (!Array.isArray(value)) {
    throw appError(Codes.BAD_REQUEST, `${name} must be an array`);
  }
  return value;
}

export function ensureObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw appError(Codes.BAD_REQUEST, `${name} must be an object`);
  }
  return value;
}

export function clampInt(value, { min, max, fallback }) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
