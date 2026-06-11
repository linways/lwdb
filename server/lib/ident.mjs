/** Quote a MySQL identifier (db/table/column name) for safe interpolation. */
export function quoteIdent(name) {
  if (typeof name !== 'string' || !name.length) {
    throw Object.assign(new Error('identifier must be a non-empty string'), { code: 'BAD_REQUEST' });
  }
  return `\`${name.replaceAll('`', '``')}\``;
}
