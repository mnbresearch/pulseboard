// PulseBoard status page — static, reads ./data written by check.mjs (GitHub Actions or local).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v) => (v == null ? '—' : v >= 99.995 ? '100%' : v.toFixed(2) + '%');
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const dur = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`;
};
const day = (t) => new Date(t).toISOString().slice(0, 10);
const BANNER = { operational: 'All systems operational', degraded: 'Degraded performance', partial: 'Partial outage', major: 'Major outage', unknown: 'Status unknown' };
const LABEL = { up: 'Operational', degraded: 'Degraded', down: 'Down' };
const get = (p) => fetch(`${p}?t=${Math.floor(Date.now() / 30000)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(p + ' ' + r.status))));

function bars(h) {
  const out = [];
  for (let i = 89; i >= 0; i--) {
    const d = day(Date.now() - i * 86400000);
    const a = h?.daily?.[d];
    let cls = '';
    let tip = `${d} · no data`;
    if (a?.n) {
      const u = (a.up / a.n) * 100;
      cls = u >= 99.9 ? 'u' : u >= 99 ? 'm' : u >= 95 ? 'd' : 'x';
      tip = `${d} · ${pct(u)} up · ${a.n} checks${a.up ? ` · avg ${Math.round(a.ms / a.up)} ms` : ''}`;
    }
    out.push(`<span class="${cls}" data-tip="${esc(tip)}"></span>`);
  }
  return `<div class="bars">${out.join('')}</div><div class="axis"><span>90 days ago</span><span>today</span></div>`;
}

function spark(h) {
  const rows = (h?.raw || []).filter((r) => r[0] > Date.now() - 86400000);
  if (rows.length < 2) return '';
  const W = 600;
  const H = 44;
  const t0 = rows[0][0];
  const t1 = rows.at(-1)[0];
  const max = Math.max(...rows.filter((r) => r[1]).map((r) => r[2]), 100);
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (ms) => H - 4 - (ms / max) * (H - 10);
  const line = rows.filter((r) => r[1]).map((r, i) => `${i ? 'L' : 'M'}${x(r[0]).toFixed(1)},${y(r[2]).toFixed(1)}`).join('');
  const fails = rows.filter((r) => !r[1]).map((r) => `<rect x="${x(r[0]) - 1.5}" y="0" width="3" height="${H}" fill="var(--down)" opacity=".6"/>`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Response time, last 24 hours">${fails}<path d="${line}" fill="none" stroke="var(--up)" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg><div class="axis"><span>response time · 24 h · peak ${Math.round(max)} ms</span><span>now</span></div>`;
}

function incidentHtml(i, monitors) {
  const m = monitors.find((x) => x.id === i.monitorId);
  const length = (i.resolvedAt || Date.now()) - i.startedAt;
  return `<div class="inc ${i.resolvedAt ? 'resolved' : ''}" id="incident-${esc(i.id)}">
    <h4>${esc(i.title)}</h4>
    <div class="muted">${new Date(i.startedAt).toLocaleString()} · ${i.resolvedAt ? `resolved after ${dur(length)}` : `ongoing for ${dur(length)}`} · ${esc(m?.name || i.monitorId)}</div>
    <ul>${i.updates.map((u) => `<li>${new Date(u.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${esc(u.text)}</li>`).join('')}</ul></div>`;
}

async function load() {
  let status;
  let incidents = [];
  try {
    [status, incidents] = await Promise.all([get('data/status.json'), get('data/incidents.json').catch(() => [])]);
  } catch {
    $('#banner').textContent = 'No data yet — the first check runs a few minutes after the repository is set up.';
    return;
  }
  document.title = `${status.title} — ${BANNER[status.overall]}`;
  $('#title').textContent = status.title;
  $('#desc').textContent = status.description || '';
  const down = status.monitors.filter((m) => m.state !== 'up');
  const b = $('#banner');
  b.className = 'banner ' + status.overall;
  b.innerHTML = `<span>${BANNER[status.overall]}</span><small>${down.length ? down.map((m) => esc(m.name)).join(', ') + ' affected · ' : ''}checked ${ago(status.generatedAt)}</small>`;

  const histories = Object.fromEntries(await Promise.all(status.monitors.map(async (m) => [m.id, await get(`data/history/${m.id}.json`).catch(() => null)])));
  const groups = [...new Set(status.monitors.map((m) => m.group))];
  $('#groups').innerHTML = groups
    .map((g) => `<div class="group"><h3>${esc(g)}</h3>${status.monitors.filter((m) => m.group === g).map((m) => `
      <div class="mon">
        <div class="top"><span class="name">${m.url ? `<a href="${esc(m.url.startsWith('http') ? m.url : '#')}" target="_blank" rel="noopener">${esc(m.name)}</a>` : esc(m.name)}</span>
          <span class="pill ${m.state}"><i></i>${LABEL[m.state]}</span>
          <span class="right"><span title="30-day uptime">${pct(m.uptime.d30)}</span><span title="Last response time">${m.ok ? m.ms + ' ms' : '—'}</span></span></div>
        ${bars(histories[m.id])}
        <div class="stats"><span>24h <b>${pct(m.uptime.d1)}</b></span><span>7d <b>${pct(m.uptime.d7)}</b></span><span>90d <b>${pct(m.uptime.d90)}</b></span>${m.p95 != null ? `<span>p50 <b>${Math.round(m.p50)} ms</b></span><span>p95 <b>${Math.round(m.p95)} ms</b></span>` : ''}${m.certDays != null ? `<span>TLS <b style="color:${m.certDays <= 14 ? 'var(--down)' : 'inherit'}">${m.certDays} days</b></span>` : ''}</div>
        ${spark(histories[m.id])}
        ${m.error ? `<div class="err">Last error: ${esc(m.error)}</div>` : ''}
      </div>`).join('')}</div>`)
    .join('');

  const open = incidents.filter((i) => !i.resolvedAt);
  $('#incidentsNow').innerHTML = open.length ? `<h2>Active incidents</h2><div class="incidents">${open.map((i) => incidentHtml(i, status.monitors)).join('')}</div>` : '';
  const past = incidents.filter((i) => i.resolvedAt && i.startedAt > Date.now() - 30 * 86400000);
  $('#history').innerHTML = past.length ? past.map((i) => incidentHtml(i, status.monitors)).join('') : '<p class="muted">No incidents in the last 30 days.</p>';
  $('#updated').textContent = `Last updated ${new Date(status.generatedAt).toLocaleString()}`;

  const base = location.href.replace(/[#?].*$/, '').replace(/index\.html$/, '');
  $('#embedBody').innerHTML = [['overall', 'Overall status'], ...status.monitors.map((m) => [m.id, m.name])]
    .map(([id, name]) => `<p><img src="data/badges/${id}.svg" alt="${esc(name)}"> <span class="muted">${esc(name)}</span></p><pre>![${esc(name)}](${esc(base)}data/badges/${id}.svg)</pre>`)
    .join('');
}

// Tooltips for the 90-day bars.
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.appendChild(tip);
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) return (tip.hidden = true);
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  const r = t.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left - tip.offsetWidth / 2)) + 'px';
  tip.style.top = r.top - 34 + 'px';
});
$('#embedBtn').addEventListener('click', (e) => {
  e.preventDefault();
  $('#embed').showModal();
});

load();
setInterval(load, 60000);
