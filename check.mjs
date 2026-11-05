#!/usr/bin/env node
// PulseBoard checker — zero dependencies (Node 18+).
//   node check.mjs                 run all monitors once and update ./data
//   node check.mjs --watch 60      run every 60 s
//   node check.mjs --serve 8080    run every 60 s and serve the status page locally
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './lib/core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf('--' + n);
  return i < 0 ? null : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};

const readJSON = async (p, d) => (existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : d);
async function writeJSON(p, v, pretty = false) {
  await mkdir(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await writeFile(tmp, JSON.stringify(v, null, pretty ? 1 : 0));
  await rename(tmp, p);
}

// ------------------------------------------------------------------ probes
async function probeHttp(m) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), m.timeoutMs || 10000);
  try {
    const res = await fetch(m.url, {
      method: m.method || 'GET',
      headers: { 'User-Agent': 'PulseBoard/1.0 (+https://github.com/mnbresearch/pulseboard)', ...(m.headers || {}) },
      body: m.body,
      redirect: m.followRedirects === false ? 'manual' : 'follow',
      signal: ctrl.signal,
    });
    const text = m.keyword || m.notKeyword ? await res.text() : (await res.arrayBuffer(), '');
    const ms = performance.now() - t0;
    const expect = m.expectStatus ? [].concat(m.expectStatus) : null;
    const statusOk = expect ? expect.includes(res.status) : res.status >= 200 && res.status < 400;
    if (!statusOk) return { ok: false, ms, code: res.status, error: `HTTP ${res.status}` };
    if (m.keyword && !text.includes(m.keyword)) return { ok: false, ms, code: res.status, error: `Keyword “${m.keyword}” not found` };
    if (m.notKeyword && text.includes(m.notKeyword)) return { ok: false, ms, code: res.status, error: `Unexpected “${m.notKeyword}” in response` };
    if (m.maxMs && ms > m.maxMs) return { ok: false, ms, code: res.status, error: `Too slow: ${Math.round(ms)} ms > ${m.maxMs} ms` };
    return { ok: true, ms, code: res.status };
  } catch (e) {
    const ms = performance.now() - t0;
    return { ok: false, ms, code: 0, error: e.name === 'AbortError' ? `Timeout after ${m.timeoutMs || 10000} ms` : e.cause?.code || e.message };
  } finally {
    clearTimeout(timer);
  }
}

function probeTcp(m) {
  const [host, port] = [m.host, Number(m.port)];
  const t0 = performance.now();
  return new Promise((resolve) => {
    const sock = tcpConnect({ host, port, timeout: m.timeoutMs || 8000 });
    const done = (r) => {
      sock.destroy();
      resolve({ ms: performance.now() - t0, code: 0, ...r });
    };
    sock.on('connect', () => done({ ok: true }));
    sock.on('timeout', () => done({ ok: false, error: 'TCP timeout' }));
    sock.on('error', (e) => done({ ok: false, error: e.code || e.message }));
  });
}

/** Days until the TLS certificate expires (null if not HTTPS or unreachable). */
function certDays(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve(null);
  }
  if (u.protocol !== 'https:') return Promise.resolve(null);
  return new Promise((resolve) => {
    const s = tlsConnect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, timeout: 8000 }, () => {
      const cert = s.getPeerCertificate();
      s.end();
      resolve(cert?.valid_to ? Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => {
      s.destroy();
      resolve(null);
    });
  });
}

async function probe(m) {
  const run = () => (m.type === 'tcp' ? probeTcp(m) : probeHttp(m));
  let r = await run();
  if (!r.ok && m.retry !== false) {
    await new Promise((s) => setTimeout(s, 2000)); // one quick retry filters transient blips
    const r2 = await run();
    if (r2.ok) r = { ...r2, retried: true };
  }
  return { t: Date.now(), ...r };
}

// ------------------------------------------------------------------ alerts
async function notify(cfg, ev) {
  const page = cfg.url || '';
  const icon = ev.type === 'opened' ? '🔴' : ev.type === 'resolved' ? '🟢' : '🟠';
  const text =
    ev.type === 'opened'
      ? `${icon} ${ev.monitor.name} is DOWN — ${ev.incident.cause}`
      : ev.type === 'resolved'
        ? `${icon} ${ev.monitor.name} is back UP after ${C.fmtDuration(ev.incident.resolvedAt - ev.incident.startedAt)} (${Math.round(ev.result.ms)} ms)`
        : `${icon} ${ev.monitor.name}: TLS certificate expires in ${ev.days} days`;
  const full = page ? `${text}\n${page}` : text;
  const env = process.env;
  const jobs = [];
  const post = (url, body, headers = { 'Content-Type': 'application/json' }) =>
    jobs.push(fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }).catch((e) => console.warn('alert failed', e.message)));
  if (env.DISCORD_WEBHOOK_URL) post(env.DISCORD_WEBHOOK_URL, { content: full });
  if (env.SLACK_WEBHOOK_URL) post(env.SLACK_WEBHOOK_URL, { text: full });
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text: full, disable_web_page_preview: true });
  if (env.NTFY_TOPIC) post(`https://ntfy.sh/${env.NTFY_TOPIC}`, full, { Title: `PulseBoard: ${ev.monitor.name}`, Tags: ev.type === 'opened' ? 'red_circle' : 'green_circle' });
  if (env.ALERT_WEBHOOK_URL) post(env.ALERT_WEBHOOK_URL, { event: ev.type, monitor: ev.monitor.id, name: ev.monitor.name, text, incident: ev.incident, statusPage: page });
  await Promise.all(jobs);
  console.log('  alert:', text, jobs.length ? `(${jobs.length} channel${jobs.length > 1 ? 's' : ''})` : '(no channels configured)');
}

// ------------------------------------------------------------------ main run
export async function runOnce() {
  const cfg = await readJSON(join(ROOT, 'pulseboard.config.json'), null);
  if (!cfg?.monitors?.length) throw new Error('pulseboard.config.json has no monitors');
  await mkdir(join(DATA, 'badges'), { recursive: true });
  const incidents = await readJSON(join(DATA, 'incidents.json'), []);
  const prev = await readJSON(join(DATA, 'status.json'), { monitors: [] });
  const results = await Promise.all(cfg.monitors.map(async (m) => ({ m, r: await probe(m), cert: m.type === 'tcp' || m.checkCert === false ? null : await certDays(m.url) })));
  const out = [];
  const events = [];
  for (const { m, r, cert } of results) {
    const hp = join(DATA, 'history', `${m.id}.json`);
    const h = C.record(await readJSON(hp, C.emptyHistory()), r);
    await writeJSON(hp, h);
    events.push(...C.updateIncidents(incidents, m, h, r).events);
    const before = prev.monitors.find((x) => x.id === m.id);
    const warnDays = m.certWarnDays ?? 14;
    if (cert != null && cert <= warnDays && !(before?.certDays <= warnDays)) events.push({ type: 'ssl', monitor: m, days: cert, result: r });
    const lat = h.raw.filter((x) => x[0] > r.t - 86400000 && x[1]).map((x) => x[2]);
    const state = C.stateOf(r, m) === 'up' && cert != null && cert <= 3 ? 'degraded' : C.stateOf(r, m);
    const u = { d1: C.uptime(h, 86400000, r.t), d7: C.uptime(h, 7 * 86400000, r.t), d30: C.uptime(h, 30 * 86400000, r.t), d90: C.uptime(h, 90 * 86400000, r.t) };
    out.push({
      id: m.id, name: m.name, group: m.group || 'Services', url: m.public === false ? null : m.url || `${m.host}:${m.port}`, type: m.type || 'http',
      state, ok: r.ok, ms: Math.round(r.ms), code: r.code, error: r.error || null, checkedAt: r.t, certDays: cert,
      uptime: u, p50: C.percentile(lat, 50), p95: C.percentile(lat, 95),
    });
    await writeFile(join(DATA, 'badges', `${m.id}.svg`), C.badge(m.name.toLowerCase(), u.d30 == null ? 'n/a' : `${u.d30.toFixed(2)}%`, C.uptimeColor(u.d30)));
    console.log(`${r.ok ? '✓' : '✗'} ${m.name.padEnd(28)} ${String(Math.round(r.ms)).padStart(5)} ms  ${r.code || ''} ${r.error || ''}${cert != null ? `  cert ${cert}d` : ''}`);
  }
  const overall = C.overall(out.map((o) => o.state));
  const status = { title: cfg.title, description: cfg.description, url: cfg.url, generatedAt: Date.now(), overall, monitors: out };
  await writeJSON(join(DATA, 'status.json'), status, true);
  await writeJSON(join(DATA, 'incidents.json'), incidents, true);
  const label = { operational: ['status', 'operational', '#2ea44f'], degraded: ['status', 'degraded', '#dfb317'], partial: ['status', 'partial outage', '#fe7d37'], major: ['status', 'major outage', '#e05d44'] }[overall] || ['status', 'unknown', '#9f9f9f'];
  await writeFile(join(DATA, 'badges', 'overall.svg'), C.badge(...label));
  await writeFile(join(DATA, 'feed.xml'), C.rss(cfg.title, cfg.url || '', incidents, cfg.monitors));
  for (const ev of events) await notify(cfg, ev);
  return status;
}

// ------------------------------------------------------------------ CLI
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.xml': 'application/rss+xml', '.png': 'image/png' };
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check.mjs')) {
  const serve = opt('serve');
  const every = Number(opt('watch') || (serve ? 60 : 0));
  const loop = async () => {
    try {
      const s = await runOnce();
      console.log(`→ ${s.overall} · ${new Date().toISOString()}\n`);
    } catch (e) {
      console.error(e.message);
      if (!every) process.exitCode = 1;
    }
  };
  await loop();
  if (every) setInterval(loop, every * 1000);
  if (serve) {
    const port = serve === true ? 8080 : Number(serve);
    createServer(async (req, res) => {
      let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      if (!f.startsWith(ROOT) || /[/\\]\./.test(p)) return res.writeHead(403).end();
      try {
        res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(await readFile(f));
      } catch {
        res.writeHead(404).end('not found');
      }
    }).listen(port, '127.0.0.1', () => console.log(`PulseBoard → http://127.0.0.1:${port}`));
  }
}
