import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/core.mjs';

const m = { id: 'web', name: 'Web', degradedMs: 500 };
const T0 = Date.parse('2026-11-01T00:00:00Z');

test('record trims raw to 7 days and daily to 90 days', () => {
  const h = C.emptyHistory();
  for (let i = 0; i < 100; i++) C.record(h, { t: T0 + i * 86400000, ok: true, ms: 100, code: 200 });
  assert.equal(Object.keys(h.daily).length, 90);
  assert.ok(h.raw.every((r) => r[0] >= T0 + 99 * 86400000 - 7 * 86400000));
});

test('uptime from raw and daily windows', () => {
  const h = C.emptyHistory();
  for (let i = 0; i < 10; i++) C.record(h, { t: T0 + i * 60000, ok: i !== 3, ms: 120, code: 200 });
  assert.equal(C.uptime(h, 86400000, T0 + 10 * 60000), 90);
  assert.equal(C.uptime(h, 30 * 86400000, T0 + 10 * 60000), 90);
  assert.equal(Math.round(C.avgLatency(h, 86400000, T0 + 10 * 60000)), 120);
});

test('incident opens after 2 consecutive failures and resolves on success', () => {
  const h = C.emptyHistory();
  const inc = [];
  const step = (i, ok) => {
    const r = { t: T0 + i * 300000, ok, ms: ok ? 80 : 10000, code: ok ? 200 : 0, error: ok ? undefined : 'Timeout' };
    C.record(h, r);
    return C.updateIncidents(inc, m, h, r).events;
  };
  assert.deepEqual(step(0, true), []);
  assert.deepEqual(step(1, false), []); // single blip ignored
  const opened = step(2, false);
  assert.equal(opened[0].type, 'opened');
  assert.equal(inc[0].startedAt, T0 + 300000);
  assert.deepEqual(step(3, false), []); // no duplicate alerts
  const resolved = step(4, true);
  assert.equal(resolved[0].type, 'resolved');
  assert.equal(inc[0].resolvedAt, T0 + 4 * 300000);
  assert.equal(C.fmtDuration(inc[0].resolvedAt - inc[0].startedAt), '15 min');
});

test('state + overall classification', () => {
  assert.equal(C.stateOf({ ok: true, ms: 900 }, m), 'degraded');
  assert.equal(C.stateOf({ ok: false }, m), 'down');
  assert.equal(C.overall(['up', 'up']), 'operational');
  assert.equal(C.overall(['up', 'degraded']), 'degraded');
  assert.equal(C.overall(['up', 'up', 'down']), 'partial');
  assert.equal(C.overall(['down', 'down', 'up']), 'major');
});

test('badge and rss escape input', () => {
  const svg = C.badge('a<b', '99.9%', C.uptimeColor(99.95));
  assert.match(svg, /a&lt;b/);
  assert.match(svg, /#2ea44f/);
  const x = C.rss('S&P', 'https://x', [{ id: '1', monitorId: 'web', title: 'Web <down>', cause: 'x', startedAt: T0, resolvedAt: T0 + 60000, updates: [] }], [m]);
  assert.match(x, /S&amp;P/);
  assert.match(x, /Web &lt;down&gt;/);
});

test('percentile', () => {
  assert.equal(C.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(C.percentile([], 95), null);
});
