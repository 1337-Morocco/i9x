// REST API over the REAL filesystem, executed as the SERVICE user.
//
// Auth is app-level (email/password), decoupled from Linux users, and the
// service runs as root — so filesystem operations run with the service's
// identity (full access). `asUser` is kept as a thin wrapper so the route
// handlers read unchanged.

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Run `fn` with the service's identity (the backend already runs as root).
function asUser(_session, fn) {
  return fn();
}

const h = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

function requireAbs(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('path must be absolute');
  return path.normalize(p);
}

const CTYPE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

router.get('/home', (req, res) => res.json({ home: req.session.home, sep: '/' }));

router.get(
  '/list',
  h((req, res) => {
    const dir = requireAbs(req.query.path || req.session.home);
    const result = asUser(req.session, () => {
      const names = fs.readdirSync(dir);
      const entries = names.map((name) => {
        const full = path.join(dir, name);
        try {
          const st = fs.lstatSync(full);
          const isLink = st.isSymbolicLink();
          let type = st.isDirectory() ? 'dir' : 'file';
          if (isLink) {
            try { type = fs.statSync(full).isDirectory() ? 'dir' : 'file'; } catch { type = 'file'; }
          }
          return { name, type, link: isLink, size: st.size, mtime: st.mtimeMs, hidden: name.startsWith('.') };
        } catch {
          return { name, type: 'file', size: 0, mtime: 0, hidden: name.startsWith('.'), unreadable: true };
        }
      });
      return entries;
    });
    result.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    res.json({ path: dir, parent: path.dirname(dir), entries: result });
  })
);

router.get(
  '/raw',
  h((req, res) => {
    const file = requireAbs(req.query.path);
    const { buf, ext } = asUser(req.session, () => {
      const st = fs.statSync(file);
      if (st.isDirectory()) throw new Error('is a directory');
      if (st.size > 25 * 1024 * 1024) throw new Error('file too large to preview');
      return { buf: fs.readFileSync(file), ext: path.extname(file).toLowerCase() };
    });
    res.setHeader('Content-Type', CTYPE[ext] || 'application/octet-stream');
    res.send(buf);
  })
);

router.get(
  '/read',
  h((req, res) => {
    const file = requireAbs(req.query.path);
    const out = asUser(req.session, () => {
      const st = fs.statSync(file);
      if (st.isDirectory()) throw new Error('is a directory');
      if (st.size > 5 * 1024 * 1024) throw new Error('file too large to edit (>5MB)');
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8192).includes(0)) throw new Error('binary file — not editable as text');
      return { content: buf.toString('utf8'), mtime: st.mtimeMs };
    });
    res.json({ path: file, ...out });
  })
);

router.post(
  '/write',
  h((req, res) => {
    const file = requireAbs(req.body.path);
    if (typeof req.body.content !== 'string') throw new Error('content must be a string');
    const mtime = asUser(req.session, () => {
      fs.writeFileSync(file, req.body.content, 'utf8');
      return fs.statSync(file).mtimeMs;
    });
    res.json({ ok: true, path: file, mtime });
  })
);

// Upload: raw file bytes in the body, target path in ?path=. Written as the
// logged-in user. (express.json above ignores non-JSON bodies, so raw runs.)
router.post(
  '/upload',
  express.raw({ type: '*/*', limit: '1024mb' }),
  h((req, res) => {
    const file = requireAbs(req.query.path);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('no file data received');
    asUser(req.session, () => fs.writeFileSync(file, buf));
    res.json({ ok: true, path: file, size: buf.length });
  })
);

router.post(
  '/mkdir',
  h((req, res) => {
    const dir = requireAbs(req.body.path);
    asUser(req.session, () => fs.mkdirSync(dir, { recursive: true }));
    res.json({ ok: true, path: dir });
  })
);

router.post(
  '/touch',
  h((req, res) => {
    const file = requireAbs(req.body.path);
    asUser(req.session, () => {
      if (fs.existsSync(file)) throw new Error('file exists');
      fs.writeFileSync(file, '', { flag: 'wx' });
    });
    res.json({ ok: true, path: file });
  })
);

router.post(
  '/rename',
  h((req, res) => {
    const from = requireAbs(req.body.from);
    const to = requireAbs(req.body.to);
    asUser(req.session, () => fs.renameSync(from, to));
    res.json({ ok: true, from, to });
  })
);

router.post(
  '/delete',
  h((req, res) => {
    const target = requireAbs(req.body.path);
    if (target === '/' || target === req.session.home) throw new Error('refusing to delete a protected path');
    asUser(req.session, () => fs.rmSync(target, { recursive: true, force: true }));
    res.json({ ok: true, path: target });
  })
);

module.exports = { fsRouter: router };
