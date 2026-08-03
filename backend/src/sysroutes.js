// System-monitor API for the Task Manager app. Mounted at /api/sys.
// Reports real CPU / memory / uptime and the top processes on this machine.

const express = require('express');
const os = require('os');
const fs = require('fs');
const { exec, execFile } = require('child_process');

const router = express.Router();

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)
    );
  });

// --- CPU usage (delta between successive calls) ---------------------------
let lastCpu = null;
function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}
function cpuUsagePct() {
  const s = cpuSnapshot();
  if (!lastCpu) {
    lastCpu = s;
    return null;
  }
  const idleD = s.idle - lastCpu.idle;
  const totalD = s.total - lastCpu.total;
  lastCpu = s;
  if (totalD <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - idleD / totalD)));
}

router.get('/stats', (_req, res) => {
  const total = os.totalmem();
  const free = os.freemem();
  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    uptime: os.uptime(),
    cores: os.cpus().length,
    cpuModel: (os.cpus()[0] && os.cpus()[0].model) || 'CPU',
    cpu: cpuUsagePct(),
    load: os.loadavg(),
    mem: { total, free, used: total - free },
  });
});

// Top processes via `ps`. Columns: pid, %cpu, %mem, rss(KB), full command.
router.get('/processes', (_req, res) => {
  exec('ps -eo pid,pcpu,pmem,rss,args --sort=-pcpu', { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(400).json({ error: err.message });
    const lines = stdout.trim().split('\n').slice(1); // drop header
    const procs = lines
      .map((line) => {
        const p = line.trim().split(/\s+/);
        if (p.length < 5) return null;
        const command = p.slice(4).join(' ');
        // Short, friendly name = basename of the executable (first token).
        const first = command.split(' ')[0].replace(/:$/, '');
        let name = first.split('/').pop() || first;
        if (!name || name.startsWith('[')) name = command.replace(/[[\]]/g, '') || 'process';
        return {
          pid: Number(p[0]),
          cpu: Number(p[1]),
          mem: Number(p[2]),
          rss: Number(p[3]) * 1024, // KB -> bytes
          name,
          command,
        };
      })
      .filter(Boolean)
      .slice(0, 30);
    res.json({ processes: procs });
  });
});

// ---------------- Services (systemd) ----------------
const UNIT_RE = /^[a-zA-Z0-9@._:\\-]+\.(service|socket|timer|target|mount)$/;
const ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable']);

router.get('/services', async (_req, res) => {
  try {
    const out = await run('systemctl', ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager']);
    const services = out
      .split('\n')
      .map((line) => {
        const p = line.trim().split(/\s+/);
        if (p.length < 4 || !p[0].endsWith('.service')) return null;
        return { unit: p[0], load: p[1], active: p[2], sub: p[3], description: p.slice(4).join(' ') };
      })
      .filter(Boolean);
    res.json({ services });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/service', async (req, res) => {
  const { unit, action } = req.body || {};
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'invalid action' });
  if (typeof unit !== 'string' || !UNIT_RE.test(unit)) return res.status(400).json({ error: 'invalid unit name' });
  try {
    await run('systemctl', [action, unit]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- Network ----------------
router.get('/net', async (_req, res) => {
  const result = { interfaces: [], connections: [] };
  // Interfaces + addresses.
  try {
    const j = JSON.parse(await run('/usr/sbin/ip', ['-j', 'addr', 'show']));
    // rx/tx byte counters from /proc/net/dev
    const dev = {};
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) continue;
      const f = m[2].trim().split(/\s+/);
      dev[m[1].trim()] = { rx: Number(f[0]), tx: Number(f[8]) };
    }
    result.interfaces = j.map((i) => ({
      name: i.ifname,
      state: i.operstate,
      addrs: (i.addr_info || []).map((a) => ({ local: a.local, family: a.family })),
      rx: dev[i.ifname] ? dev[i.ifname].rx : 0,
      tx: dev[i.ifname] ? dev[i.ifname].tx : 0,
    }));
  } catch { /* ignore */ }
  // Connections.
  try {
    const out = await run('ss', ['-tunpH']);
    result.connections = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const p = line.trim().split(/\s+/);
        const procM = line.match(/users:\(\("([^"]+)"/);
        return { proto: p[0], state: p[1], local: p[4], peer: p[5], proc: procM ? procM[1] : '' };
      })
      .slice(0, 200);
  } catch { /* ignore */ }
  res.json(result);
});

// ---------------- Logs ----------------
const LOG_SOURCES = {
  journal: { cmd: 'journalctl', args: (n) => ['-n', String(n), '--no-pager', '-q'] },
  kernel: { cmd: 'journalctl', args: (n) => ['-k', '-n', String(n), '--no-pager', '-q'] },
  syslog: { file: '/var/log/syslog' },
  auth: { file: '/var/log/auth.log' },
};

router.get('/log', async (req, res) => {
  const src = LOG_SOURCES[req.query.source] || LOG_SOURCES.journal;
  const lines = Math.max(50, Math.min(2000, Number(req.query.lines) || 300));
  try {
    let text;
    if (src.file) text = await run('tail', ['-n', String(lines), src.file]);
    else text = await run(src.cmd, src.args(lines));
    res.json({ text });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = { sysRouter: router };
