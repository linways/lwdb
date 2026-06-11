/**
 * Typed error codes used throughout the app.
 * - HTTP layer maps code → status.
 * - CLI prints message and exits non-zero.
 */
export const Codes = {
  BAD_REQUEST: 'BAD_REQUEST',
  EMPTY_SQL: 'EMPTY_SQL',
  MULTI_STMT: 'MULTI_STMT',
  MISSING_PARAM: 'MISSING_PARAM',
  READONLY_BLOCKED: 'READONLY_BLOCKED',
  AGENT_WRITES_DISABLED: 'AGENT_WRITES_DISABLED',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  UNKNOWN_SERVER: 'UNKNOWN_SERVER',
  NOT_FOUND: 'NOT_FOUND',
  BAD_BACKUP: 'BAD_BACKUP',
  BAD_VERSION: 'BAD_VERSION',
  TIMEOUT: 'TIMEOUT',
  CONFLICT: 'CONFLICT',
  POOL_LIMIT: 'POOL_LIMIT',
  INVALID_CONFIG: 'INVALID_CONFIG',
  DB_ERROR: 'DB_ERROR',
};

export function appError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

export function statusForCode(code) {
  switch (code) {
    case Codes.READONLY_BLOCKED:
    case Codes.AGENT_WRITES_DISABLED:
    case Codes.CONFIRM_REQUIRED: return 403;
    case Codes.UNAUTHORIZED: return 401;
    case Codes.UNKNOWN_SERVER:
    case Codes.NOT_FOUND: return 404;
    case Codes.BAD_REQUEST:
    case Codes.EMPTY_SQL:
    case Codes.MULTI_STMT:
    case Codes.MISSING_PARAM:
    case Codes.BAD_BACKUP:
    case Codes.BAD_VERSION:
    case Codes.INVALID_CONFIG: return 400;
    case Codes.TIMEOUT: return 504;
    case Codes.CONFLICT: return 409;
    case Codes.POOL_LIMIT: return 503;
    default: return 500;
  }
}
