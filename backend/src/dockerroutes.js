// Docker management API (mounted at /api/docker). Uses the `docker` CLI.
// The backend runs as root, so it can talk to the Docker daemon.

const express = require('express');
const { execFile } = require('child_process');

const router = express.Router();

// Run a docker command. `long` allows a big timeout for pull/build.
function docker(args, { long = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 32 * 1024 * 1024, timeout: long ? 900000 : 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

// Parse `--format '{{json .}}'` output (one JSON object per line).
function parseJsonLines(out) {
  return out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/;
const PORT = /^\d{1,5}:\d{1,5}$/;

router.get('/status', async (_req, res) => {
  try {
    const v = await docker(['version', '--format', '{{.Server.Version}}']);
    res.json({ installed: true, running: true, version: v.trim() });
  } catch (e) {
    const notFound = /not found|ENOENT/i.test(e.message);
    res.json({ installed: !notFound, running: false, error: e.message });
  }
});

router.get('/containers', async (_req, res) => {
  try { res.json({ containers: parseJsonLines(await docker(['ps', '-a', '--format', '{{json .}}'])) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/images', async (_req, res) => {
  try { res.json({ images: parseJsonLines(await docker(['images', '--format', '{{json .}}'])) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/container', async (req, res) => {
  const { id, action } = req.body || {};
  const map = { start: ['start'], stop: ['stop'], restart: ['restart'], kill: ['kill'], remove: ['rm', '-f'] };
  if (!map[action]) return res.status(400).json({ error: 'invalid action' });
  if (!ID.test(id || '')) return res.status(400).json({ error: 'invalid container id' });
  try { await docker([...map[action], id]); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/image/remove', async (req, res) => {
  const { id } = req.body || {};
  if (!ID.test(id || '')) return res.status(400).json({ error: 'invalid image id' });
  try { await docker(['rmi', '-f', id]); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/pull', async (req, res) => {
  const { image } = req.body || {};
  if (!IMAGE.test(image || '')) return res.status(400).json({ error: 'invalid image name' });
  try { const out = await docker(['pull', image], { long: true }); res.json({ ok: true, output: out }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/run', async (req, res) => {
  const { image, name, ports } = req.body || {};
  if (!IMAGE.test(image || '')) return res.status(400).json({ error: 'invalid image name' });
  const args = ['run', '-d'];
  if (name) { if (!ID.test(name)) return res.status(400).json({ error: 'invalid name' }); args.push('--name', name); }
  if (ports) {
    for (const p of String(ports).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!PORT.test(p)) return res.status(400).json({ error: `invalid port mapping: ${p}` });
      args.push('-p', p);
    }
  }
  args.push(image);
  try { const out = await docker(args, { long: true }); res.json({ ok: true, id: out.trim() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/logs', async (req, res) => {
  const id = req.query.id;
  if (!ID.test(id || '')) return res.status(400).json({ error: 'invalid id' });
  const lines = Math.max(20, Math.min(2000, Number(req.query.lines) || 300));
  try { const out = await docker(['logs', '--tail', String(lines), id]); res.json({ text: out }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/build', async (req, res) => {
  const { path: ctx, tag } = req.body || {};
  if (typeof ctx !== 'string' || !ctx.startsWith('/')) return res.status(400).json({ error: 'context path must be absolute' });
  if (!IMAGE.test(tag || '')) return res.status(400).json({ error: 'invalid image tag' });
  try { const out = await docker(['build', '-t', tag, ctx], { long: true }); res.json({ ok: true, output: out }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { dockerRouter: router };
