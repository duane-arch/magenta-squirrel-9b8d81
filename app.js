'use strict';
// NBA Predict v1 : données ESPN (scoreboard) -> Elo -> prédictions.
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const SEASON_START = '20251021';   // début de la base d'historique
const LS_KEY = 'nbaPredict.v1';
const K = 20, HFA = 100, B2B = 40, PTS = 28;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const parseYmd = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

let db = load();
function load() {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY)); if (v && v.games) return v; } catch (e) {}
  return { games: {}, teams: {}, upcoming: [], updatedAt: null };
}
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (e) {} }

function setStatus(msg, err) { const s = $('#status'); s.textContent = msg; s.className = err ? 'err' : ''; }

// ---------- Récupération des données ----------
// Une requête par jour (dates=YYYYMMDD) : le format le plus fiable de l'API.
async function fetchDay(d) {
  const r = await fetch(`${API}?dates=${d}`);
  if (!r.ok) {
    let body = ''; try { body = (await r.text()).slice(0, 140); } catch (e) {}
    throw new Error(`HTTP ${r.status} sur ${d} ${body}`.trim());
  }
  return (await r.json()).events || [];
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { await fn(items[i++]); }
  }));
}
function parseEvent(ev) {
  const c = ev.competitions && ev.competitions[0]; if (!c) return null;
  const st = ev.season && ev.season.type;
  if (st && st !== 2 && st !== 3) return null;               // ignore pré-saison / hors saison
  const h = c.competitors.find((x) => x.homeAway === 'home');
  const a = c.competitors.find((x) => x.homeAway === 'away');
  if (!h || !a || !h.team || !a.team) return null;
  const type = (ev.status && ev.status.type) || {};
  const o = c.odds && c.odds[0];
  return {
    id: String(ev.id), t: ev.date,
    h: { id: String(h.team.id), ab: h.team.abbreviation, n: h.team.displayName || h.team.name },
    a: { id: String(a.team.id), ab: a.team.abbreviation, n: a.team.displayName || a.team.name },
    hs: Number(h.score), as: Number(a.score),
    done: !!type.completed, live: type.state === 'in',
    odds: o ? { details: o.details || '', ou: o.overUnder || null } : null,
  };
}

function ingest(events, up) {
  for (const ev of events) {
    const g = parseEvent(ev); if (!g) continue;
    db.teams[g.h.id] = { ab: g.h.ab, n: g.h.n }; db.teams[g.a.id] = { ab: g.a.ab, n: g.a.n };
    if (g.done && Number.isFinite(g.hs) && Number.isFinite(g.as)) {
      db.games[g.id] = { t: g.t, h: g.h.id, a: g.a.id, hs: g.hs, as: g.as };
    } else if (!g.done) {
      up[g.id] = { id: g.id, t: g.t, h: g.h.id, a: g.a.id, live: g.live, odds: g.odds };
    }
  }
}

async function refresh() {
  const btn = $('#refresh'); btn.disabled = true;
  try {
    setStatus('Mise à jour des données…');
    db.days = db.days || {};
    const today = new Date();
    const days = [];
    for (let d = parseYmd(SEASON_START); d <= addDays(today, 3); d = addDays(d, 1)) days.push(ymd(d));
    const recent = ymd(addDays(today, -3));                 // les 3 derniers jours sont toujours rechargés
    const todo = days.filter((d) => d >= recent || !db.days[d]);
    const up = {}; const errors = []; let n = 0;
    await pool(todo, 6, async (d) => {
      try {
        ingest(await fetchDay(d), up);
        if (d < recent) db.days[d] = 1;
      } catch (e) { errors.push(e.message); }
      n++;
      if (n % 5 === 0 || n === todo.length) setStatus(`Récupération des matchs… (${n}/${todo.length})`);
    });
    if (errors.length && errors.length === todo.length) throw new Error(errors[0]);
    db.upcoming = Object.values(up).sort((x, y) => (x.t < y.t ? -1 : 1));
    db.updatedAt = new Date().toISOString();
    save();
    render();
    const hh = new Date(db.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    setStatus(`À jour · ${Object.keys(db.games).length} matchs en base · ${hh}` + (errors.length ? ` · ${errors.length} jour(s) en échec` : ''), errors.length > 0);
  } catch (e) {
    save();
    setStatus(`Échec de la mise à jour (${e.message}). Données en cache affichées.`, true);
    render();
  } finally { btn.disabled = false; }
}

// ---------- Modèle Elo ----------
const dayKey = (iso) => new Date(Date.parse(iso) - 6 * 3600e3).toISOString().slice(0, 10); // ~heure US
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const seasonOf = (iso) => { const d = new Date(iso); return d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
function fatigue(h, a, day, last) {
  let adj = 0;
  if (last[h] && dayDiff(day, last[h]) === 1) adj -= B2B;
  if (last[a] && dayDiff(day, last[a]) === 1) adj += B2B;
  return adj;
}
function runModel() {
  const games = Object.values(db.games).sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  const elo = {}, cnt = {}, last = {}, log = []; let season = null;
  for (const g of games) {
    const sn = seasonOf(g.t);
    if (season !== null && sn !== season) {
      for (const k in elo) elo[k] = 1505 + (elo[k] - 1505) * 0.75;
      for (const k in last) delete last[k];
    }
    season = sn;
    const eh = elo[g.h] ?? 1500, ea = elo[g.a] ?? 1500, day = dayKey(g.t);
    const diff = eh - ea + HFA + fatigue(g.h, g.a, day, last);
    const p = 1 / (1 + Math.pow(10, -diff / 400));
    const win = g.hs > g.as ? 1 : 0, mov = Math.abs(g.hs - g.as);
    if ((cnt[g.h] || 0) >= 15 && (cnt[g.a] || 0) >= 15) log.push({ t: g.t, p, win });
    const dW = win ? diff : -diff;
    const mult = Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * dW);
    const delta = K * mult * (win - p);
    elo[g.h] = eh + delta; elo[g.a] = ea - delta;
    cnt[g.h] = (cnt[g.h] || 0) + 1; cnt[g.a] = (cnt[g.a] || 0) + 1;
    last[g.h] = day; last[g.a] = day;
  }
  return { elo, cnt, last, log };
}
function parseSpread(details, hAb, aAb) {           // ex. "BOS -5.5" -> marge attendue du domicile selon la ligne
  if (!details) return null;
  if (/^EVEN$/i.test(details.trim())) return 0;
  const m = details.trim().match(/^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const v = parseFloat(m[2]);
  if (m[1] === hAb) return -v;
  if (m[1] === aAb) return v;
  return null;
}

// ---------- Affichage ----------
function render() {
  const M = runModel();
  const T = (id) => db.teams[id] || { ab: '?', n: 'Équipe ' + id };
  // matchs à venir
  const box = $('#games');
  const now = Date.now();
  const list = db.upcoming.filter((g) => g.live || Date.parse(g.t) > now - 3 * 3600e3);
  if (!list.length) box.innerHTML = '<div class="empty">Aucun match à venir trouvé.</div>';
  else box.innerHTML = list.map((g) => {
    const day = dayKey(g.t);
    const eh = M.elo[g.h] ?? 1500, ea = M.elo[g.a] ?? 1500;
    const diff = eh - ea + HFA + fatigue(g.h, g.a, day, M.last);
    const ph = 1 / (1 + Math.pow(10, -diff / 400)), pa = 1 - ph, margin = diff / PTS;
    const H = T(g.h), A = T(g.a);
    const when = new Date(g.t).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const spread = g.odds ? parseSpread(g.odds.details, H.ab, A.ab) : null;
    let line = `Marge modèle : <b>${esc(H.ab)} ${margin >= 0 ? '+' : ''}${margin.toFixed(1)}</b>`;
    if (spread !== null) {
      const gap = margin - spread;
      const fav = gap >= 0 ? H.ab : A.ab;
      line += ` · Ligne : <b>${esc(H.ab)} ${spread >= 0 ? '+' : ''}${spread.toFixed(1)}</b>`
        + ` · <span class="${Math.abs(gap) >= 3 ? 'pick' : ''}">Écart ${Math.abs(gap).toFixed(1)} pts (${esc(fav)})</span>`;
    } else line += ' · Pas de cote disponible';
    if (g.odds && g.odds.ou) line += ` · O/U ${esc(g.odds.ou)}`;
    return `<div class="card">
      <div class="meta"><span>${esc(when)}</span>${g.live ? '<span class="live">EN COURS</span>' : ''}</div>
      <div class="teams"><span>${esc(A.n)}</span><span class="at">@</span><span>${esc(H.n)}</span></div>
      <div class="bar"><i class="a" style="width:${(pa * 100).toFixed(1)}%"></i><i class="h" style="width:${(ph * 100).toFixed(1)}%"></i></div>
      <div class="probs"><b>${esc(A.ab)} ${(pa * 100).toFixed(0)}%</b><b>${esc(H.ab)} ${(ph * 100).toFixed(0)}%</b></div>
      <div class="line">${line}</div></div>`;
  }).join('');

  // fiabilité
  const L = M.log; const n = L.length;
  if (n) {
    const acc = L.filter((x) => (x.p >= 0.5) === (x.win === 1)).length / n;
    const brier = L.reduce((s, x) => s + (x.p - x.win) ** 2, 0) / n;
    const homeRate = L.filter((x) => x.win === 1).length / n;
    const last100 = L.slice(-100); const acc100 = last100.filter((x) => (x.p >= 0.5) === (x.win === 1)).length / last100.length;
    $('#stats').innerHTML = [
      [(acc * 100).toFixed(1) + ' %', `Victoires bien prédites (${n} matchs)`],
      [(acc100 * 100).toFixed(1) + ' %', '100 derniers matchs'],
      [brier.toFixed(3), 'Score de Brier (0,25 = hasard)'],
      [(homeRate * 100).toFixed(1) + ' %', 'Référence : toujours le domicile'],
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
  } else $('#stats').innerHTML = '<div class="empty">Pas encore assez de matchs.</div>';

  // classement
  const teams = Object.keys(M.elo).sort((a, b) => M.elo[b] - M.elo[a]);
  $('#rank').innerHTML = '<tr><th>#</th><th>Équipe</th><th class="n">Elo</th></tr>'
    + teams.map((id, i) => `<tr><td>${i + 1}</td><td>${esc(T(id).n)}</td><td class="n">${Math.round(M.elo[id])}</td></tr>`).join('');
}

// ---------- Démarrage ----------
$('#refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!db.updatedAt || Date.now() - Date.parse(db.updatedAt) > 15 * 60e3)) refresh();
});
render();
if (db.updatedAt) setStatus('Données en cache · mise à jour…');
refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
