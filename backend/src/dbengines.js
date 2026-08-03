// Database engine drivers.
//
// Everything engine-specific lives here: the image, the container/volume naming,
// the environment that seeds the first database and user, the readiness probe,
// how to browse data, and how to take a dump. dbroutes.js is engine-agnostic and
// only ever talks to this map, so adding an engine is one entry below.
//
// Naming: PostgreSQL keeps the legacy `pg-` / `pgdata-` prefixes so instances
// created before the multi-engine rewrite keep running untouched.

const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Shared exec helpers — every engine command runs *inside* its container over
// `docker exec`, so no client is needed on the host and the DB port doesn't
// even have to be published.
// ---------------------------------------------------------------------------

function dockerExec(container, argv, { env = {}, stdin, timeout = 30000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '-i'];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(container, ...argv);
    const child = spawn('docker', args);
    const out = [];
    let errOut = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => (errOut += c));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (killed) return reject(new Error('command timed out'));
      if (code !== 0) return reject(new Error(errOut.trim() || `exited with code ${code}`));
      resolve(binary ? buf : buf.toString('utf8'));
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

// Streaming variant used by the dump endpoint: returns the child so the caller
// can pipe stdout straight to an HTTP response.
function dockerExecStream(container, argv, { env = {} } = {}) {
  const args = ['exec', '-i'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(container, ...argv);
  return spawn('docker', args);
}

// MySQL/MariaDB batch output is tab-separated with a header row; NULLs come back
// as a literal \N and control characters are backslash-escaped.
function parseTsv(text) {
  const lines = text.split('\n').filter((l) => l !== '');
  if (!lines.length) return { columns: [], rows: [] };
  const unescape = (s) => (s === '\\N' ? null : s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '0' ? '\0' : c)));
  const columns = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => {
    const cells = l.split('\t');
    const o = {};
    columns.forEach((c, i) => { o[c] = unescape(cells[i] === undefined ? '\\N' : cells[i]); });
    return o;
  });
  return { columns, rows };
}

const jsonLines = (text) => text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { line: l }; } });

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;   // database / user identifiers

const postgres = {
  id: 'postgres',
  label: 'PostgreSQL',
  kind: 'sql',
  versions: ['18', '17', '16', '15', '14', '13'],
  defaultVersion: '16',
  image: (v) => `postgres:${v}`,
  containerPort: 5432,
  portRange: [5432, 5600],
  cprefix: 'pg',                       // legacy names — do not change
  vprefix: 'pgdata',
  dataPath: '/var/lib/postgresql/data',
  fields: { dbName: true, dbUser: true, password: true },
  defaultUser: 'postgres',
  scheme: 'postgresql',
  env: (d) => ({ POSTGRES_USER: d.dbUser, POSTGRES_PASSWORD: d.dbPass, POSTGRES_DB: d.dbName }),
  uri: (d, host) => `postgresql://${d.dbUser}:${d.dbPass}@${host}:${d.port}/${d.dbName}`,
  ready: (d) => ({ argv: ['pg_isready', '-U', d.dbUser, '-d', d.dbName] }),
  browse: 'sql',
  dump: (d) => ({ argv: ['pg_dump', '-U', d.dbUser, '-d', d.dbName], env: { PGPASSWORD: d.dbPass }, ext: 'sql' }),

  async query(d, sql, container) {
    if (/^(select|with|table|values|show|explain)\b/i.test(sql.trim())) {
      const wrapped = `SELECT coalesce(json_agg(t), '[]'::json)::text FROM (\n${sql.replace(/;\s*$/, '')}\n) AS t;`;
      const out = await this.raw(d, wrapped, container, ['-tA']);
      const rows = JSON.parse(out.trim() || '[]');
      return { rows, columns: rows.length ? Object.keys(rows[0]) : [] };
    }
    return { message: (await this.raw(d, sql, container)).trim() || 'OK' };
  },
  raw(d, sql, container, extra = []) {
    return dockerExec(container, ['psql', '-U', d.dbUser, '-d', d.dbName, '-v', 'ON_ERROR_STOP=1', ...extra],
      { env: { PGPASSWORD: d.dbPass }, stdin: sql });
  },
  tablesSql: () => `SELECT schemaname AS schema, relname AS name, n_live_tup AS rows
                    FROM pg_stat_user_tables ORDER BY schemaname, relname`,
  columnsSql: (_d, schema, table) => `SELECT column_name AS name, data_type AS type FROM information_schema.columns
                                      WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`,
  pageSql: (_d, schema, table, limit, offset) => `SELECT * FROM "${schema}"."${table}" LIMIT ${limit} OFFSET ${offset}`,
  countSql: (_d, schema, table) => `SELECT n_live_tup AS rows FROM pg_stat_user_tables WHERE schemaname = '${schema}' AND relname = '${table}'`,
};

// MySQL and MariaDB differ only in image, versions and env var prefix.
function mysqlFamily({ id, label, versions, defaultVersion, image, envPrefix, dumpBin }) {
  return {
    id, label, kind: 'sql', versions, defaultVersion, image,
    containerPort: 3306,
    portRange: [3306, 3400],
    cprefix: id,
    vprefix: `${id}data`,
    dataPath: '/var/lib/mysql',
    fields: { dbName: true, dbUser: true, password: true },
    defaultUser: 'app',
    scheme: 'mysql',
    env: (d) => {
      const e = { [`${envPrefix}_ROOT_PASSWORD`]: d.dbPass, [`${envPrefix}_DATABASE`]: d.dbName };
      // MYSQL_USER may not be "root" — the root account already exists and is
      // configured by ROOT_PASSWORD above.
      if (d.dbUser && d.dbUser !== 'root') { e[`${envPrefix}_USER`] = d.dbUser; e[`${envPrefix}_PASSWORD`] = d.dbPass; }
      return e;
    },
    uri: (d, host) => `mysql://${d.dbUser}:${d.dbPass}@${host}:${d.port}/${d.dbName}`,
    ready: (d) => ({ argv: ['mysqladmin', 'ping', '-h', '127.0.0.1', '-u', 'root'], env: { MYSQL_PWD: d.dbPass } }),
    browse: 'sql',
    dump: (d) => ({ argv: [dumpBin, '-u', 'root', '--single-transaction', d.dbName], env: { MYSQL_PWD: d.dbPass }, ext: 'sql' }),

    async query(d, sql, container) {
      const out = await dockerExec(container, ['mysql', '-u', 'root', '-B', '-D', d.dbName, '-e', sql], { env: { MYSQL_PWD: d.dbPass } });
      if (!out.trim()) return { message: 'OK' };
      const { columns, rows } = parseTsv(out);
      return { rows, columns };
    },
    tablesSql: (d) => `SELECT table_schema AS 'schema', table_name AS name, IFNULL(table_rows, 0) AS 'rows'
                       FROM information_schema.tables WHERE table_schema = '${d.dbName}' AND table_type = 'BASE TABLE'
                       ORDER BY table_name`,
    columnsSql: (_d, schema, table) => `SELECT column_name AS name, column_type AS type FROM information_schema.columns
                                        WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`,
    pageSql: (_d, schema, table, limit, offset) => `SELECT * FROM \`${schema}\`.\`${table}\` LIMIT ${limit} OFFSET ${offset}`,
    countSql: (_d, schema, table) => `SELECT IFNULL(table_rows, 0) AS 'rows' FROM information_schema.tables
                                      WHERE table_schema = '${schema}' AND table_name = '${table}'`,
  };
}

const mysql = mysqlFamily({
  id: 'mysql', label: 'MySQL', versions: ['8.4', '8.0', '5.7'], defaultVersion: '8.4',
  image: (v) => `mysql:${v}`, envPrefix: 'MYSQL', dumpBin: 'mysqldump',
});

const mariadb = mysqlFamily({
  id: 'mariadb', label: 'MariaDB', versions: ['11.8', '11.4', '10.11', '10.6'], defaultVersion: '11.4',
  image: (v) => `mariadb:${v}`, envPrefix: 'MARIADB', dumpBin: 'mariadb-dump',
});

// Redis and Valkey share the same protocol and CLI.
function redisFamily({ id, label, versions, defaultVersion, image, cli }) {
  return {
    id, label, kind: 'kv', versions, defaultVersion, image,
    containerPort: 6379,
    portRange: [6379, 6479],
    cprefix: id,
    vprefix: `${id}data`,
    dataPath: '/data',
    fields: { dbName: false, dbUser: false, password: true },
    scheme: 'redis',
    env: () => ({}),
    // Password is passed as a server flag; --appendonly keeps writes durable.
    cmd: (d) => ['--appendonly', 'yes', '--requirepass', d.dbPass],
    uri: (d, host) => `redis://default:${d.dbPass}@${host}:${d.port}`,
    ready: (d) => ({ argv: [cli, 'ping'], env: { REDISCLI_AUTH: d.dbPass } }),
    browse: 'console',
    consoleHint: `${cli} — e.g. “INFO keyspace”, “KEYS *”, “GET mykey”`,
    // SAVE writes /data/dump.rdb synchronously; REDISCLI_AUTH keeps the password
    // out of the argv (and therefore out of the process list).
    dump: (d) => ({
      argv: ['sh', '-c', `${cli} save >/dev/null && cat /data/dump.rdb`],
      env: { REDISCLI_AUTH: d.dbPass }, ext: 'rdb', binary: true,
    }),

    async console(d, command, container) {
      const argv = [cli, ...splitArgs(command)];
      return { text: (await dockerExec(container, argv, { env: { REDISCLI_AUTH: d.dbPass } })).trim() || '(no output)' };
    },
  };
}

const redis = redisFamily({ id: 'redis', label: 'Redis', versions: ['8', '7', '6'], defaultVersion: '8', image: (v) => `redis:${v}-alpine`, cli: 'redis-cli' });
const valkey = redisFamily({ id: 'valkey', label: 'Valkey', versions: ['8', '7.2'], defaultVersion: '8', image: (v) => `valkey/valkey:${v}-alpine`, cli: 'valkey-cli' });

const mongodb = {
  id: 'mongodb',
  label: 'MongoDB',
  kind: 'document',
  versions: ['8', '7', '6'],
  defaultVersion: '8',
  image: (v) => `mongo:${v}`,
  containerPort: 27017,
  portRange: [27017, 27100],
  cprefix: 'mongo',
  vprefix: 'mongodata',
  dataPath: '/data/db',
  fields: { dbName: true, dbUser: true, password: true },
  defaultUser: 'root',
  scheme: 'mongodb',
  env: (d) => ({ MONGO_INITDB_ROOT_USERNAME: d.dbUser, MONGO_INITDB_ROOT_PASSWORD: d.dbPass, MONGO_INITDB_DATABASE: d.dbName }),
  uri: (d, host) => `mongodb://${d.dbUser}:${d.dbPass}@${host}:${d.port}/${d.dbName}?authSource=admin`,
  ready: (d) => ({ argv: ['mongosh', '--quiet', '-u', d.dbUser, '-p', d.dbPass, '--authenticationDatabase', 'admin', '--eval', 'db.adminCommand("ping")'] }),
  browse: 'console',
  consoleHint: 'mongosh — e.g. “db.getCollectionNames()”, “db.users.find().limit(5)”',
  dump: (d) => ({ argv: ['mongodump', '--archive', '-u', d.dbUser, '-p', d.dbPass, '--authenticationDatabase', 'admin', '--db', d.dbName], env: {}, ext: 'archive', binary: true }),

  async console(d, command, container) {
    const argv = ['mongosh', '--quiet', '-u', d.dbUser, '-p', d.dbPass, '--authenticationDatabase', 'admin', d.dbName, '--eval', command];
    return { text: (await dockerExec(container, argv)).trim() || '(no output)' };
  },
};

const clickhouse = {
  id: 'clickhouse',
  label: 'ClickHouse',
  kind: 'sql',
  versions: ['25.3', '24.8', '24.3'],
  defaultVersion: '25.3',
  image: (v) => `clickhouse/clickhouse-server:${v}`,
  containerPort: 8123,
  portRange: [8123, 8200],
  cprefix: 'clickhouse',
  vprefix: 'clickhousedata',
  dataPath: '/var/lib/clickhouse',
  fields: { dbName: true, dbUser: true, password: true },
  defaultUser: 'default',
  scheme: 'http',
  env: (d) => ({ CLICKHOUSE_USER: d.dbUser, CLICKHOUSE_PASSWORD: d.dbPass, CLICKHOUSE_DB: d.dbName, CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' }),
  // The server needs a raised nofile limit or it refuses to start on some hosts.
  extraRunArgs: () => ['--ulimit', 'nofile=262144:262144'],
  uri: (d, host) => `http://${d.dbUser}:${d.dbPass}@${host}:${d.port}/?database=${d.dbName}`,
  ready: (d) => ({ argv: ['clickhouse-client', '--user', d.dbUser, '--password', d.dbPass, '-q', 'SELECT 1'] }),
  browse: 'sql',
  dump: null,   // no single-command logical dump — use a per-table SELECT instead

  async query(d, sql, container) {
    const stmt = sql.replace(/;\s*$/, '');
    const isSelect = /^(select|with|show|describe|desc|exists)\b/i.test(stmt.trim());
    const argv = ['clickhouse-client', '--user', d.dbUser, '--password', d.dbPass, '--database', d.dbName,
      ...(isSelect ? ['--format', 'JSONEachRow'] : []), '-q', stmt];
    const out = await dockerExec(container, argv);
    if (!isSelect) return { message: out.trim() || 'OK' };
    const rows = jsonLines(out);
    return { rows, columns: rows.length ? Object.keys(rows[0]) : [] };
  },
  tablesSql: (d) => `SELECT database AS schema, name, total_rows AS rows FROM system.tables
                     WHERE database = '${d.dbName}' ORDER BY name`,
  columnsSql: (_d, schema, table) => `SELECT name, type FROM system.columns
                                      WHERE database = '${schema}' AND table = '${table}' ORDER BY position`,
  pageSql: (_d, schema, table, limit, offset) => `SELECT * FROM "${schema}"."${table}" LIMIT ${limit} OFFSET ${offset}`,
  countSql: (_d, schema, table) => `SELECT total_rows AS rows FROM system.tables WHERE database = '${schema}' AND name = '${table}'`,
};

const ENGINES = { postgres, mysql, mariadb, redis, valkey, mongodb, clickhouse };

// Split a console command into argv, honouring simple quoting. Good enough for
// redis-cli one-liners, and it never involves a shell.
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s)))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ---------------------------------------------------------------------------
// Engine-agnostic surface used by dbroutes
// ---------------------------------------------------------------------------

const get = (id) => ENGINES[id] || null;
const cname = (d) => `${get(d.engine).cprefix}-${d.name}`;
const volume = (d) => `${get(d.engine).vprefix}-${d.name}`;

// What the UI needs to render the "New database" form.
function catalog() {
  return Object.values(ENGINES).map((e) => ({
    id: e.id, label: e.label, kind: e.kind, versions: e.versions, defaultVersion: e.defaultVersion,
    fields: e.fields, defaultUser: e.defaultUser || '', browse: e.browse,
    consoleHint: e.consoleHint || '', canDump: !!e.dump, defaultPort: e.portRange[0],
  }));
}

// Full `docker run` argv for an instance.
function runArgs(d) {
  const e = get(d.engine);
  const args = [
    'run', '-d', '--name', cname(d), '--restart', 'unless-stopped',
    '-p', `${d.port}:${e.containerPort}`,
    '-v', `${volume(d)}:${e.dataPath}`,
  ];
  for (const [k, v] of Object.entries(e.env(d))) args.push('-e', `${k}=${v}`);
  if (e.extraRunArgs) args.push(...e.extraRunArgs(d));
  args.push(e.image(d.version));
  if (e.cmd) args.push(...e.cmd(d));
  return args;
}

// Is the server accepting connections yet? Used to hold an instance in
// "provisioning" until it can actually be used, instead of the moment the
// container is created.
async function isReady(d) {
  const e = get(d.engine);
  const probe = e.ready(d);
  try {
    await dockerExec(cname(d), probe.argv, { env: probe.env || {}, timeout: 10000 });
    return true;
  } catch { return false; }
}

const uri = (d, host) => get(d.engine).uri(d, host);

// Browsing. SQL engines get tables + paged rows; key/value and document engines
// get a console instead (their shape doesn't fit a table grid).
async function tables(d) {
  const e = get(d.engine);
  if (e.browse !== 'sql') return [];
  const r = await e.query(d, e.tablesSql(d), cname(d));
  return (r.rows || []).map((t) => ({ schema: String(t.schema), name: String(t.name), rows: Number(t.rows || 0) }));
}

async function tableData(d, schema, table, limit, offset) {
  const e = get(d.engine);
  if (e.browse !== 'sql') throw new Error(`${e.label} has no table browser`);
  if (!IDENT_RE.test(schema) || !IDENT_RE.test(table)) throw new Error('invalid table');
  const columns = (await e.query(d, e.columnsSql(d, schema, table), cname(d))).rows || [];
  const rows = (await e.query(d, e.pageSql(d, schema, table, limit, offset), cname(d))).rows || [];
  const est = (await e.query(d, e.countSql(d, schema, table), cname(d))).rows || [];
  return {
    columns: columns.map((c) => ({ name: String(c.name), type: String(c.type) })),
    rows,
    total: est[0] ? Number(est[0].rows) : null,
  };
}

function query(d, sql) {
  const e = get(d.engine);
  if (e.browse === 'sql') return e.query(d, sql, cname(d));
  if (e.console) return e.console(d, sql, cname(d));
  throw new Error(`${e.label} does not support queries`);
}

// Dump spec + a live child process streaming the dump on stdout.
function dumpSpec(d) {
  const e = get(d.engine);
  return e.dump ? e.dump(d) : null;
}
function dumpStream(d) {
  const spec = dumpSpec(d);
  if (!spec) throw new Error(`${get(d.engine).label} dumps are not supported`);
  return { child: dockerExecStream(cname(d), spec.argv, { env: spec.env || {} }), spec };
}

module.exports = {
  ENGINES, get, catalog, cname, volume, runArgs, isReady, uri, tables, tableData, query,
  dumpSpec, dumpStream, dockerExec, IDENT_RE,
};
