const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64 = (str) => {
  const s = unescape(encodeURIComponent(str));
  let o = '';
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
    o += T[a >> 2] + T[((a & 3) << 4) | ((b || 0) >> 4)]
      + (isNaN(b) ? '=' : T[((b & 15) << 2) | ((c || 0) >> 6)]) + (isNaN(c) ? '=' : T[c & 63]);
  }
  return o;
};

// "1h", "1w2d", "1d00:00:00", "01:00:00" -> secondes
export function parseTime(s) {
  if (!s || s === 'unlimited' || s === 'none') return 0;
  const m = s.match(/^(?:(\d+)d)?(\d+):(\d{2}):(\d{2})$/);
  if (m) return (+m[1] || 0) * 86400 + m[2] * 3600 + m[3] * 60 + +m[4];
  let t = 0;
  for (const [, n, u] of s.matchAll(/(\d+)([wdhms])/g)) t += n * { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }[u];
  return t;
}
// style du template : 1h, 24h, 7d
export function fmtDur(s) {
  if (!s) return '';
  if (s <= 86400 && s % 3600 === 0) return `${s / 3600}h`;
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}
export const fmtBytes = (b) => (b >= 1e9 ? `${+(b / 1e9).toFixed(2)} Go` : `${Math.round(b / 1e6)} Mo`);

export class Router {
  constructor({ host, user, pass }) {
    const h = /^https?:\/\//.test(host.trim()) ? host.trim() : `http://${host.trim()}`;
    this.base = `${h.replace(/\/+$/, '')}/rest`;
    this.auth = `Basic ${b64(`${user.trim()}:${pass}`)}`;
  }
  async req(method, path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    let r;
    try {
      r = await fetch(this.base + path, {
        method, signal: ctl.signal,
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Routeur injoignable. Vérifiez l’adresse et que le service www est actif.');
    } finally { clearTimeout(t); }
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!r.ok) throw new Error(r.status === 401 ? 'Identifiants refusés par le routeur.' : j?.detail || j?.message || `Erreur ${r.status}`);
    return j;
  }
  get = (p) => this.req('GET', p);
  put = (p, b) => this.req('PUT', p, b);
  del = (p) => this.req('DELETE', p);

  async settings() {
    const s = await this.get('/user-manager');
    return Array.isArray(s) ? s[0] : s;
  }

  // profils + limitations liées (table profile-limitation)
  async loadPlans() {
    const [pr, li, pl] = await Promise.all([
      this.get('/user-manager/profile'), this.get('/user-manager/limitation'), this.get('/user-manager/profile-limitation'),
    ]);
    const lim = Object.fromEntries(li.map((l) => [l.name, l]));
    return pr.map((p) => {
      const limits = pl.filter((x) => x.profile === p.name).map((x) => {
        const l = lim[x.limitation] || {};
        return {
          name: x.limitation, uptime: parseTime(l['uptime-limit']), transfer: +l['transfer-limit'] || 0,
          rate: l['rate-limit-rx'] ? `${l['rate-limit-rx']}/${l['rate-limit-tx'] || l['rate-limit-rx']}` : '',
          from: x['from-time'] || '00:00:00', till: x['till-time'] || '23:59:59',
        };
      });
      const validity = parseTime(p.validity);
      const up = limits.map((l) => l.uptime).filter(Boolean);
      return { name: p.name, validity, startsWhen: p['starts-when'], limits, duration: up.length ? Math.min(...up) : validity };
    });
  }

  // crée les users puis leur assigne les profils dans l'ordre choisi
  async createBatch(vouchers, order, comment, onProgress) {
    let done = 0, fail = 0, last = '';
    const queue = [...vouchers];
    const worker = async () => {
      for (let v; (v = queue.shift()); ) {
        let id;
        try {
          id = (await this.put('/user-manager/user', { name: v.code, password: v.password, comment }))['.id'];
          for (const p of order) await this.put('/user-manager/user-profile', { user: v.code, profile: p });
        } catch (e) {
          fail++; last = e.message;
          if (id) await this.del(`/user-manager/user/${id}`).catch(() => {});
        }
        onProgress(++done / vouchers.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { ok: vouchers.length - fail, fail, last };
  }

  // users regroupés par commentaire, plus récents d'abord
  async loadBatches() {
    const [us, ups] = await Promise.all([this.get('/user-manager/user'), this.get('/user-manager/user-profile')]);
    const prof = {};
    ups.forEach((x) => (prof[x.user] ||= []).push(x.profile));
    const g = new Map();
    us.forEach((u) => {
      const c = u.comment || '(sans commentaire)';
      if (!g.has(c)) g.set(c, []);
      g.get(c).push({ code: u.name, password: u.password ?? '', profiles: prof[u.name] || [] });
    });
    return [...g].map(([comment, rows]) => ({ comment, rows })).reverse();
  }
}

export function genCodes({ qty, prefix, digits, same, taken }) {
  const max = 10 ** digits, out = [];
  let tries = 0;
  while (out.length < qty) {
    if (++tries > qty * 50 + 1000) throw new Error('Pas assez de chiffres pour ce nombre de tickets uniques.');
    const code = prefix + String(Math.floor(Math.random() * max)).padStart(digits, '0');
    if (taken.has(code)) continue;
    taken.add(code);
    out.push({ code, password: same ? code : String(Math.floor(Math.random() * 1e6)).padStart(6, '0') });
  }
  return out;
}

// template : BOM UTF-8, CRLF, code,password,profile,duration
const q = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function toCsv(rows, plans) {
  const d = Object.fromEntries(plans.map((p) => [p.name, p.duration]));
  const lines = rows.map((r) =>
    [r.code, r.password, r.profiles.join('+'), fmtDur(r.profiles.reduce((s, p) => s + (d[p] || 0), 0))].map(q).join(','));
  return '\uFEFF' + ['code,password,profile,duration', ...lines].join('\r\n') + '\r\n';
}
