// A small 5-field cron implementation.
//
// Standard fields — minute hour day-of-month month day-of-week — supporting *,
// */step, ranges, step-over-range and comma lists, plus the usual @hourly-style
// shorthands. Deliberately dependency-free: i9x ships as a single Node SEA
// binary, so pulling in a cron library would mean bundling one more package for
// something this size.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },   // 0 and 7 are both Sunday
];

const ALIASES = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function normalize(expr) {
  const e = String(expr || '').trim().toLowerCase();
  return ALIASES[e] || e;
}

// Expand one field into the set of values it matches.
function parseField(raw, field, index) {
  const values = new Set();
  for (let part of String(raw).split(',')) {
    part = part.trim();
    if (!part) throw new Error(`empty ${field.name} value`);
    let step = 1;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      step = Number(part.slice(slash + 1));
      part = part.slice(0, slash);
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${field.name}`);
    }
    let lo, hi;
    if (part === '*') { lo = field.min; hi = field.max; }
    else {
      const [a, b] = part.split('-');
      lo = toNumber(a, field, index);
      hi = b === undefined ? (slash === -1 ? lo : field.max) : toNumber(b, field, index);
    }
    if (lo > hi) throw new Error(`inverted range in ${field.name}`);
    for (let v = lo; v <= hi; v += step) values.add(index === 4 && v === 7 ? 0 : v);
  }
  return values;
}

function toNumber(token, field, index) {
  const t = String(token).trim();
  if (index === 3 && MONTHS.includes(t)) return MONTHS.indexOf(t) + 1;
  if (index === 4 && DAYS.includes(t)) return DAYS.indexOf(t);
  const n = Number(t);
  if (!Number.isInteger(n) || n < field.min || n > field.max)
    throw new Error(`${field.name} must be ${field.min}–${field.max}`);
  return n;
}

// Parse an expression into five value sets. Throws with a readable message.
function parse(expr) {
  const parts = normalize(expr).split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error('Expected 5 fields: minute hour day-of-month month day-of-week');
  return parts.map((p, i) => parseField(p, FIELDS[i], i));
}

function validate(expr) {
  try { parse(expr); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Does `date` (local time, second-resolution ignored) fall on this schedule?
// Day-of-month and day-of-week are OR'd when both are restricted, matching
// Vixie cron.
function matches(expr, date) {
  let sets;
  try { sets = parse(expr); } catch { return false; }
  const [min, hour, dom, mon, dow] = sets;
  if (!min.has(date.getMinutes()) || !hour.has(date.getHours()) || !mon.has(date.getMonth() + 1)) return false;
  const domRestricted = normalize(expr).split(/\s+/)[2] !== '*';
  const dowRestricted = normalize(expr).split(/\s+/)[4] !== '*';
  const domHit = dom.has(date.getDate());
  const dowHit = dow.has(date.getDay());
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

// The next firing at or after `from` (exclusive), or null if nothing matches
// within a year. Used to show "next run" in the UI.
function next(expr, from = new Date()) {
  if (!validate(expr).ok) return null;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matches(expr, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Common schedules offered in the UI.
const PRESETS = [
  { label: 'Every minute', expr: '* * * * *' },
  { label: 'Every 5 minutes', expr: '*/5 * * * *' },
  { label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily at 03:00', expr: '0 3 * * *' },
  { label: 'Weekly (Sun 03:00)', expr: '0 3 * * 0' },
  { label: 'Monthly (1st, 03:00)', expr: '0 3 1 * *' },
];

module.exports = { parse, validate, matches, next, PRESETS };
