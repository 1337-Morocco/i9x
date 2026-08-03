// The single in-process clock.
//
// Everything periodic in i9x hangs off this: scheduled tasks, the Docker
// cleanup schedule and the disk guard. It ticks on the minute (checked every
// 20s so a busy event loop can't skip one) and never fires the same minute
// twice, which is what keeps a job from running again after a restart inside
// the same minute.

const { tickTasks } = require('./taskroutes');
const { tickMaintenance, checkDisk } = require('./maintenanceroutes');

const TICK_MS = 20 * 1000;
const DISK_EVERY_MS = 5 * 60 * 1000;

let timer = null;
let lastMinute = '';
let lastDiskCheck = 0;

const minuteKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;

function tick() {
  const now = new Date();
  const key = minuteKey(now);
  if (key !== lastMinute) {
    lastMinute = key;
    try { tickTasks(now); } catch (e) { console.error('[scheduler] tasks:', e.message); }
    try { tickMaintenance(now); } catch (e) { console.error('[scheduler] maintenance:', e.message); }
  }
  if (Date.now() - lastDiskCheck >= DISK_EVERY_MS) {
    lastDiskCheck = Date.now();
    checkDisk().catch((e) => console.error('[scheduler] disk guard:', e.message));
  }
}

function start() {
  if (timer) return;
  lastMinute = minuteKey(new Date());   // don't fire for the minute we booted in
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  checkDisk().catch(() => { /* first probe is best-effort */ });
  lastDiskCheck = Date.now();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop };
