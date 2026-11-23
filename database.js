const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Set it to the Supabase PostgreSQL connection string.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  // Express handles several dashboard API requests concurrently. A single
  // connection can leave session-store requests waiting until they time out.
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

function replaceMysqlIf(sql) {
  let result = sql;
  let start = result.toUpperCase().indexOf('IF(');
  while (start !== -1) {
    let depth = 1;
    let quote = null;
    let commas = [];
    let end = start + 3;
    for (; end < result.length && depth; end += 1) {
      const char = result[end];
      if (quote) {
        if (char === quote && result[end - 1] !== '\\') quote = null;
      } else if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (char === ',' && depth === 1) commas.push(end);
    }
    if (depth || commas.length !== 2) break;
    const open = start + 2;
    const condition = result.slice(open + 1, commas[0]).trim();
    let yes = result.slice(commas[0] + 1, commas[1]).trim();
    let no = result.slice(commas[1] + 1, end - 1).trim();
    if (yes === '1' && no === '0' && /is_(?:active|enabled|archived|published)/i.test(result.slice(Math.max(0, start - 60), start))) {
      yes = 'true'; no = 'false';
    }
    result = `${result.slice(0, start)}CASE WHEN ${condition} THEN ${yes} ELSE ${no} END${result.slice(end)}`;
    start = result.toUpperCase().indexOf('IF(', start + 8);
  }
  return result;
}

function translate(sql, params = []) {
  let text = replaceMysqlIf(sql)
    .replace(/INSERT\s+IGNORE\s+INTO/i, 'INSERT INTO')
    .replace(/DATE_SUB\(NOW\(\),\s*INTERVAL\s+1\s+YEAR\)/gi, "NOW() - INTERVAL '1 year'")
    .replace(/CURDATE\(\)/gi, 'CURRENT_DATE')
    .replace(/\bis_(active|enabled|archived|published)\s*=\s*0\b/gi, 'is_$1 = false')
    .replace(/\bis_(active|enabled|archived|published)\s*=\s*1\b/gi, 'is_$1 = true');

  text = text
    .replace(/GET_LOCK\('barangay_dashboard_first_admin',\s*5\)/gi, "pg_try_advisory_xact_lock(hashtext('barangay_dashboard_first_admin'))")
    .replace(/SUM\(last_status\s*=\s*'online'\)/gi, "COUNT(*) FILTER (WHERE last_status = 'online')")
    .replace(/SUM\(status\s*=\s*'Active'\s+AND\s+archived_at\s+IS\s+NULL\)/gi, "COUNT(*) FILTER (WHERE status = 'Pending' AND archived_at IS NULL)")
    .replace(/SUM\(DATE\(occurred_at\)\s*=\s*CURRENT_DATE\s+AND\s+archived_at\s+IS\s+NULL\)/gi, 'COUNT(*) FILTER (WHERE occurred_at::date = CURRENT_DATE AND archived_at IS NULL)')
    .replace(/\bIF\((\$\d+)\s+IS\s+NULL,\s*last_checked_at,\s*NOW\(\)\)/gi, 'CASE WHEN $1 IS NULL THEN last_checked_at ELSE NOW() END');
  text = text
    .replace(/(is_active\)\s+VALUES\s*\([^;]*,\s*'approved',\s*)1(\))/i, '$1true$2')
    .replace(/(is_active\)\s+VALUES\s*\([^;]*,\s*'pending',\s*)0(\))/i, '$1false$2')
    .replace(/(is_enabled,\s*created_by\)\s+VALUES\s*\([^;]*,\s*)1(,\s*\$\d+\))/i, '$1true$2');

  text = text.replace(/\bAS\s+([A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)/g, 'AS "$1"');
  let index = 0;
  text = text.replace(/\?/g, () => `$${++index}`);

  if (/INSERT\s+IGNORE/i.test(sql)) text += ' ON CONFLICT DO NOTHING';
  if (/^\s*INSERT\b/i.test(text) && !/\bRETURNING\b/i.test(text)) text += ' RETURNING id';

  // Boolean values supplied by the existing MySQL API are 0/1.
  const values = params.map((value) => value);
  text = text.replace(/COALESCE\(\$(\d+),\s*(is_(?:active|enabled|archived|published))\)/gi,
    (_match, n, column) => `COALESCE(CASE WHEN $${n}::int = 0 THEN false ELSE true END, ${column})`);
  return { text, values };
}

async function execute(sql, params = []) {
  const translated = translate(sql, params);
  const result = await pool.query(translated.text, translated.values);
  if (/^\s*(SELECT|WITH)\b/i.test(sql)) return [result.rows, result.fields];
  return [{
    insertId: result.rows?.[0]?.id ?? 0,
    affectedRows: result.rowCount || 0
  }, result.fields];
}

async function getConnection() {
  const client = await pool.connect();
  return {
    query: async (sql, params = []) => {
      const translated = translate(sql, params);
      const result = await client.query(translated.text, translated.values);
      return [/^\s*(SELECT|WITH)\b/i.test(sql) ? result.rows : {
        insertId: result.rows?.[0]?.id ?? 0,
        affectedRows: result.rowCount || 0
      }, result.fields];
    },
    execute: async (sql, params = []) => {
      const translated = translate(sql, params);
      const result = await client.query(translated.text, translated.values);
      return [{ insertId: result.rows?.[0]?.id ?? 0, affectedRows: result.rowCount || 0 }, result.fields];
    },
    beginTransaction: () => client.query('BEGIN'),
    commit: () => client.query('COMMIT'),
    rollback: () => client.query('ROLLBACK'),
    release: () => client.release()
  };
}

module.exports = {
  query: execute,
  execute,
  end: () => pool.end(),
  getConnection,
  pool
};
