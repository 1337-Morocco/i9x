// GitHub integration via a Personal Access Token.
//
// The token is stored in the metadata DB (which is chmod 600, owner-only) and
// used to: list the user's repos for the deploy picker, read package.json from
// private repos for framework detection, authenticate git clone/pull of private
// repos (without persisting the token in the checked-out remote), and create the
// push webhook automatically when auto-deploy is enabled.

const db = require('./db');

const TOKEN_KEY = 'github_token';
const LOGIN_KEY = 'github_login';

const getToken = () => db.kv.get(TOKEN_KEY);
const getLogin = () => db.kv.get(LOGIN_KEY);
const isConnected = () => !!getToken();
function setConnection(token, login) { db.kv.set(TOKEN_KEY, token); db.kv.set(LOGIN_KEY, login || ''); }
function clear() { db.kv.del(TOKEN_KEY); db.kv.del(LOGIN_KEY); }

function headers(token) {
  return {
    Authorization: `Bearer ${token || getToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'i9x',
  };
}

async function api(pathOrUrl, opts = {}) {
  if (!isConnected()) throw new Error('GitHub is not connected');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  return fetch(url, { ...opts, headers: { ...headers(), 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
}

const ownerRepo = (url) => {
  const m = String(url).match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
};

// Validate a token and return the authenticated user (used before storing).
async function verify(token) {
  const r = await fetch('https://api.github.com/user', { headers: headers(token), signal: AbortSignal.timeout(10000) });
  if (r.status === 401) throw new Error('Invalid or expired token');
  if (!r.ok) throw new Error(`GitHub error ${r.status}`);
  return r.json();
}

async function listRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const r = await api(`/user/repos?per_page=100&sort=pushed&page=${page}&affiliation=owner,collaborator,organization_member`);
    if (!r.ok) throw new Error(`GitHub error ${r.status}`);
    const batch = await r.json();
    for (const repo of batch) repos.push({
      fullName: repo.full_name, name: repo.name, private: repo.private,
      defaultBranch: repo.default_branch, cloneUrl: repo.clone_url, pushedAt: repo.pushed_at,
    });
    if (batch.length < 100) break;
  }
  return repos;
}

// Read package.json from a (possibly private) repo for framework detection.
async function getPackageJson(fullName, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const r = await api(`/repos/${fullName}/contents/package.json${q}`);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.content) return null;
  try { return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); } catch { return null; }
}

// Create the push webhook (or update the existing one with the same URL). Idempotent.
async function ensureWebhook(fullName, url, secret) {
  const list = await api(`/repos/${fullName}/hooks`);
  if (list.ok) {
    const hooks = await list.json();
    const existing = Array.isArray(hooks) && hooks.find((h) => h.config && h.config.url === url);
    if (existing) {
      await api(`/repos/${fullName}/hooks/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: true, events: ['push'], config: { url, content_type: 'json', secret, insecure_ssl: '0' } }),
      });
      return { id: existing.id, updated: true };
    }
  }
  const r = await api(`/repos/${fullName}/hooks`, {
    method: 'POST',
    body: JSON.stringify({ name: 'web', active: true, events: ['push'], config: { url, content_type: 'json', secret, insecure_ssl: '0' } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`GitHub webhook create failed (${r.status})${t ? ': ' + t.slice(0, 160) : ''}`);
  }
  const j = await r.json();
  return { id: j.id, created: true };
}

// Remove the push webhook matching this URL, if present. Best-effort.
async function removeWebhook(fullName, url) {
  try {
    const list = await api(`/repos/${fullName}/hooks`);
    if (!list.ok) return;
    const hooks = await list.json();
    const existing = Array.isArray(hooks) && hooks.find((h) => h.config && h.config.url === url);
    if (existing) await api(`/repos/${fullName}/hooks/${existing.id}`, { method: 'DELETE' });
  } catch { /* ignore */ }
}

// git -c args that authenticate over HTTPS without writing the token into the
// checked-out repo's remote (unlike embedding it in the URL). Empty if no token.
function gitAuthArgs() {
  const token = getToken();
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

module.exports = {
  getToken, getLogin, isConnected, setConnection, clear, verify,
  listRepos, getPackageJson, ensureWebhook, removeWebhook, gitAuthArgs, ownerRepo,
};
