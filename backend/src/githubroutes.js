// GitHub connection management — connect a Personal Access Token, report status,
// disconnect, and list repos for the deploy picker. Mounted at /api/github.

const express = require('express');
const github = require('./github');

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({ connected: github.isConnected(), login: github.getLogin() || undefined });
});

router.post('/connect', async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) return res.status(400).json({ error: 'Paste a GitHub personal access token' });
  try {
    const user = await github.verify(token);
    github.setConnection(token, user.login);
    res.json({ connected: true, login: user.login });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/disconnect', (_req, res) => {
  github.clear();
  res.json({ connected: false });
});

router.get('/repos', async (_req, res) => {
  if (!github.isConnected()) return res.status(400).json({ error: 'GitHub is not connected' });
  try { res.json({ repos: await github.listRepos() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { githubRouter: router };
