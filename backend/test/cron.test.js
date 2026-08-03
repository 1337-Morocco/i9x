const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('../src/cron');

// The cron parser decides when every scheduled task fires. A silent bug here
// means a backup that never runs, so the edge cases are worth pinning down.

test('parse: rejects anything that is not five fields', () => {
  assert.throws(() => cron.parse('* * * *'), /Expected 5 fields/);
  assert.throws(() => cron.parse('* * * * * *'), /Expected 5 fields/);
  assert.throws(() => cron.parse(''), /Expected 5 fields/);
});

test('parse: expands wildcards to the full range', () => {
  const [minute, hour, dom, month, dow] = cron.parse('* * * * *');
  assert.equal(minute.size, 60);
  assert.equal(hour.size, 24);
  assert.equal(dom.size, 31);
  assert.equal(month.size, 12);
  // Day-of-week spans 0..7, but 7 is normalized to 0 (both mean Sunday), so
  // the set collapses to the seven distinct days.
  assert.equal(dow.size, 7);
  assert.deepEqual([...dow], [0, 1, 2, 3, 4, 5, 6]);
});

test('parse: day-of-week 7 and 0 are the same Sunday', () => {
  assert.deepEqual([...cron.parse('0 0 * * 7')[4]], [0]);
  assert.deepEqual(cron.parse('0 0 * * 7'), cron.parse('0 0 * * 0'));
});

test('parse: steps, ranges and lists', () => {
  assert.deepEqual([...cron.parse('*/15 * * * *')[0]], [0, 15, 30, 45]);
  assert.deepEqual([...cron.parse('0 9-12 * * *')[1]], [9, 10, 11, 12]);
  assert.deepEqual([...cron.parse('0 0 1,15 * *')[2]], [1, 15]);
  assert.deepEqual([...cron.parse('0 10-20/5 * * *')[1]], [10, 15, 20]);
});

test('parse: month and day names are case-insensitive', () => {
  assert.deepEqual([...cron.parse('0 0 * JAN *')[3]], [1]);
  assert.deepEqual([...cron.parse('0 0 * * sun')[4]], [0]);
  assert.deepEqual([...cron.parse('0 0 * * Fri')[4]], [5]);
});

test('parse: rejects out-of-range values', () => {
  assert.throws(() => cron.parse('60 * * * *'));
  assert.throws(() => cron.parse('* 24 * * *'));
  assert.throws(() => cron.parse('* * 32 * *'));
  assert.throws(() => cron.parse('* * * 13 *'));
  assert.throws(() => cron.parse('* * * * 8'));
});

test('validate: reports errors instead of throwing', () => {
  assert.equal(cron.validate('*/5 * * * *').ok, true);
  const bad = cron.validate('nope');
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.error, 'string');
});

test('aliases resolve to their expansion', () => {
  assert.deepEqual(cron.parse('@hourly'), cron.parse('0 * * * *'));
  assert.deepEqual(cron.parse('@daily'), cron.parse('0 0 * * *'));
  assert.deepEqual(cron.parse('@weekly'), cron.parse('0 0 * * 0'));
  assert.deepEqual(cron.parse('@yearly'), cron.parse('0 0 1 1 *'));
});

test('matches: exact minute and hour', () => {
  // 2026-03-04 is a Wednesday.
  const at0930 = new Date(2026, 2, 4, 9, 30);
  assert.equal(cron.matches('30 9 * * *', at0930), true);
  assert.equal(cron.matches('31 9 * * *', at0930), false);
  assert.equal(cron.matches('30 10 * * *', at0930), false);
});

test('matches: day-of-month and day-of-week are OR-ed, per Vixie cron', () => {
  // 2026-03-04 is a Wednesday (day 3), the 4th of the month.
  const wed4th = new Date(2026, 2, 4, 0, 0);
  // Both restricted and neither matches the other: either hit is enough.
  assert.equal(cron.matches('0 0 4 * 1', wed4th), true, 'dom hit alone should fire');
  assert.equal(cron.matches('0 0 9 * 3', wed4th), true, 'dow hit alone should fire');
  assert.equal(cron.matches('0 0 9 * 1', wed4th), false, 'neither hit should not fire');
  // Only one restricted: that one must match.
  assert.equal(cron.matches('0 0 4 * *', wed4th), true);
  assert.equal(cron.matches('0 0 9 * *', wed4th), false);
});

test('matches: an unparseable expression never fires', () => {
  assert.equal(cron.matches('not a schedule', new Date()), false);
});

test('next: returns the following occurrence, exclusive of `from`', () => {
  const from = new Date(2026, 2, 4, 9, 30, 0, 0);
  const n = cron.next('*/15 * * * *', from);
  assert.equal(n.getHours(), 9);
  assert.equal(n.getMinutes(), 45);
  // Exclusive: standing exactly on a firing minute yields the next one.
  const onTheDot = cron.next('30 9 * * *', from);
  assert.equal(onTheDot.getDate(), 5, 'should roll to tomorrow, not return `from`');
});

test('next: crosses a month boundary', () => {
  const from = new Date(2026, 0, 31, 23, 59);
  const n = cron.next('0 0 1 * *', from);
  assert.equal(n.getMonth(), 1, 'February');
  assert.equal(n.getDate(), 1);
});

test('next: null for an invalid expression', () => {
  assert.equal(cron.next('bogus'), null);
});

test('every preset offered in the UI parses', () => {
  for (const p of cron.PRESETS) {
    assert.equal(cron.validate(p.expr).ok, true, `${p.label} (${p.expr}) should be valid`);
    assert.notEqual(cron.next(p.expr, new Date(2026, 2, 4, 9, 30)), null);
  }
});
