// One shared `docker ps` snapshot for every service list.
//
// The WordPress / static / Next.js panels each poll their list endpoint every
// few seconds. Asking Docker once per site meant N process spawns per poll (and
// 3N with all three panels open). This takes a single snapshot, caches it
// briefly, and collapses concurrent callers onto one in-flight request.

const { execFile } = require('child_process');

const TTL = 1500; // ms — well under the UI's 5s poll, so lists stay fresh
let cache = null;
let cachedAt = 0;
let inflight = null;

function fetchSnapshot() {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['ps', '--filter', 'status=running', '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}'],
      { timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null); // docker missing or not running
        const names = new Set();
        const projects = new Set();
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const [name, project] = line.split('\t');
          if (name && name.trim()) names.add(name.trim());
          if (project && project.trim()) projects.add(project.trim());
        }
        resolve({ names, projects });
      }
    );
  });
}

// Resolves to { names, projects } — or null when Docker can't be reached, in
// which case callers report a status of 'unknown' rather than a wrong 'stopped'.
async function snapshot() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  if (inflight) return inflight;
  inflight = fetchSnapshot().then((s) => {
    if (s) { cache = s; cachedAt = Date.now(); }
    inflight = null;
    return s;
  });
  return inflight;
}

// Called after start/stop/remove so the next list reflects the change at once.
function invalidate() { cache = null; cachedAt = 0; }

module.exports = { snapshot, invalidate };
