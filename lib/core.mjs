// PulseBoard core — pure functions for history, uptime, incidents and badges (unit-tested).
export const RAW_DAYS = 7;
export const DAILY_DAYS = 90;
export const DOWN_AFTER = 2; // consecutive failures before an incident opens (avoids flapping on one blip)

export const day = (t) => new Date(t).toISOString().slice(0, 10);

export function emptyHistory() {
  return { raw: [], daily: {} };
}

/** Add a check result: raw rows are [t, ok(1/0), ms, code]. */
export function record(h, r) {
  h.raw.push([r.t, r.ok ? 1 : 0, Math.round(r.ms ?? 0), r.code ?? 0]);
  const cutoff = r.t - RAW_DAYS * 86400000;
  while (h.raw.length && h.raw[0][0] < cutoff) h.raw.shift();
  const d = day(r.t);
  const agg = (h.daily[d] ||= { n: 0, up: 0, ms: 0 });
  agg.n += 1;
  if (r.ok) {
    agg.up += 1;
    agg.ms += Math.round(r.ms ?? 0);
  }
  const keep = new Set(Array.from({ length: DAILY_DAYS }, (_, i) => day(r.t - i * 86400000)));
  for (const k of Object.keys(h.daily)) if (!keep.has(k)) delete h.daily[k];
  return h;
}

/** Uptime % over a window, from raw rows when possible, otherwise daily aggregates. */
export function uptime(h, windowMs, now = Date.now()) {
  const from = now - windowMs;
  if (windowMs <= RAW_DAYS * 86400000) {
    const rows = h.raw.filter((r) => r[0] >= from);
    if (!rows.length) return null;
    return (rows.reduce((s, r) => s + r[1], 0) / rows.length) * 100;
  }
  const days = Object.entries(h.daily).filter(([d]) => new Date(d + 'T23:59:59Z').getTime() >= from);
  const n = days.reduce((s, [, a]) => s + a.n, 0);
  return n ? (days.reduce((s, [, a]) => s + a.up, 0) / n) * 100 : null;
}

export function avgLatency(h, windowMs, now = Date.now()) {
  const rows = h.raw.filter((r) => r[0] >= now - windowMs && r[1]);
  return rows.length ? rows.reduce((s, r) => s + r[2], 0) / rows.length : null;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

/** 'up' | 'degraded' | 'down' for the latest result. */
export function stateOf(result, monitor) {
  if (!result.ok) return 'down';
  if (monitor.degradedMs && result.ms > monitor.degradedMs) return 'degraded';
  return 'up';
}

/**
 * Update incidents after a check. Opens an incident after DOWN_AFTER consecutive failures
 * and resolves it on the first success. Returns { incidents, events } where events are
 * 'opened' / 'resolved' notifications to send.
 */
export function updateIncidents(incidents, monitor, h, result) {
  const events = [];
  const open = incidents.find((i) => i.monitorId === monitor.id && !i.resolvedAt);
  if (!result.ok) {
    const tail = h.raw.slice(-DOWN_AFTER);
    const consecutive = tail.length === DOWN_AFTER && tail.every((r) => !r[1]);
    if (!open && consecutive) {
      const inc = {
        id: `${monitor.id}-${result.t}`,
        monitorId: monitor.id,
        title: `${monitor.name} is down`,
        cause: result.error || `HTTP ${result.code}`,
        startedAt: tail[0][0],
        resolvedAt: null,
        updates: [{ t: result.t, text: `Detected: ${result.error || 'HTTP ' + result.code}` }],
      };
      incidents.unshift(inc);
      events.push({ type: 'opened', incident: inc, monitor, result });
    } else if (open && open.cause !== (result.error || `HTTP ${result.code}`)) {
      open.cause = result.error || `HTTP ${result.code}`;
      open.updates.push({ t: result.t, text: `Still failing: ${open.cause}` });
    }
  } else if (open) {
    open.resolvedAt = result.t;
    open.updates.push({ t: result.t, text: `Resolved — responding in ${Math.round(result.ms)} ms` });
    events.push({ type: 'resolved', incident: open, monitor, result });
  }
  if (incidents.length > 200) incidents.length = 200;
  return { incidents, events };
}

export function overall(states) {
  if (!states.length) return 'unknown';
  if (states.every((s) => s === 'up')) return 'operational';
  if (states.some((s) => s === 'down')) return states.filter((s) => s === 'down').length > states.length / 2 ? 'major' : 'partial';
  return 'degraded';
}

export function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.round(h / 24)} days`;
}

/** Shields-style SVG badge. */
export function badge(label, message, color) {
  const w = (s) => Math.round(s.length * 6.6 + 12);
  const lw = w(label);
  const mw = w(message);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + mw}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${lw + mw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${lw + mw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + mw / 2}" y="14">${esc(message)}</text></g></svg>`;
}

export function uptimeColor(pct) {
  if (pct == null) return '#9f9f9f';
  if (pct >= 99.9) return '#2ea44f';
  if (pct >= 99) return '#8bc34a';
  if (pct >= 95) return '#dfb317';
  return '#e05d44';
}

export function rss(title, link, incidents, monitors) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const items = incidents.slice(0, 50).map((i) => {
    const m = monitors.find((x) => x.id === i.monitorId);
    const status = i.resolvedAt ? `Resolved after ${fmtDuration(i.resolvedAt - i.startedAt)}` : 'Ongoing';
    return `<item><title>${esc(i.title)} — ${esc(status)}</title><link>${esc(link)}#incident-${esc(i.id)}</link><guid isPermaLink="false">${esc(i.id)}</guid><pubDate>${new Date(i.startedAt).toUTCString()}</pubDate><description>${esc(`${m?.name || i.monitorId}: ${i.cause}. ${status}.`)}</description></item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(title)} — incidents</title><link>${esc(link)}</link><description>Status incidents</description>${items.join('')}</channel></rss>`;
}
