// Renders/parses the Linways active-db include. Variable NAMES are a fixed
// contract consumed by the app's conf files — do not rename them.

// PHP single-quoted literal: only ' and \ are special. $, %, @ pass through.
function phpStr(v) {
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// Old dbconfs embedded the port in the host when non-default (e.g. 127.0.0.1:3378).
export function hostString(host, port) {
  return port && Number(port) !== 3306 ? `${host}:${port}` : String(host);
}

export function renderActiveDb({ dbName, collegeCode, host, port, user, password, server }) {
  // Stamp the source connection id as a PHP comment so `--status` can health-check it.
  const tag = server ? `// setdb server=${server}\n` : '';
  return '<?php\n' + tag
    + `$DB_NAME = $AMS_AUTONOMOUS_DB_NAME = ${phpStr(dbName)};\n`
    + `$COLLEGE_CODE = ${phpStr(collegeCode)};\n`
    + `$AMS_AUTONOMOUS_DB_HOST = $HOST = $DB_HOST = ${phpStr(hostString(host, port))};\n`
    + `$AMS_AUTONOMOUS_DB_USER = $USER = $DB_USER = ${phpStr(user)};\n`
    + `$AMS_AUTONOMOUS_DB_PASSWD = $PASSWD = $DB_PASSWD = ${phpStr(password)};\n`
    + '?>\n';
}

const STR = "'((?:\\\\.|[^'\\\\])*)'"; // single-quoted value, escape-aware
export function parseActiveDb(text) {
  const pick = (re) => { const m = text.match(new RegExp(re, 's')); return m ? m[1] : null; };
  const serverMatch = text.match(/\/\/ setdb server=(\S+)/);
  return {
    dbName: pick(`\\$DB_NAME\\s*=.*?=\\s*${STR}`),
    collegeCode: pick(`\\$COLLEGE_CODE\\s*=\\s*${STR}`),
    host: pick(`\\$HOST\\s*=.*?=\\s*${STR}`),
    server: serverMatch ? serverMatch[1] : null,
  };
}

export function resolveCollegeCode({ override, dbName, map }) {
  if (override) return String(override).toUpperCase();
  const key = String(dbName || '').toUpperCase();
  if (map && map[key]) return map[key];
  // ponytail: substring fallback — longest matching key wins, so SJCC beats SJC on test_sjccv4
  if (map) {
    const hit = Object.keys(map).filter(k => key.includes(k)).sort((a, b) => b.length - a.length)[0];
    if (hit) return map[hit];
  }
  return null;
}
