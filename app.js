'use strict';
// NBA Predict v1.3 : données ESPN (scoreboard) -> Elo -> prédictions.
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const SEASON_START = '20231024';   // début de la base d'historique : 3 saisons (2023-24 à aujourd'hui)
const DB_VERSION = 2;
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
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY));
    if (v && v.games) {
      if (v.v !== DB_VERSION) { v.days = {}; v.v = DB_VERSION; }   // nouvelle version : on recharge les jours pour récupérer les détails
      return v;
    }
  } catch (e) {}
  return { v: DB_VERSION, games: {}, teams: {}, upcoming: [], updatedAt: null };
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
  const lsOf = (x) => (x.linescores || []).map((l) => Number(l.value));
  const lh = lsOf(h), la = lsOf(a);
  const okLs = lh.length >= 4 && la.length >= 4 && lh.concat(la).every(Number.isFinite);
  return {
    id: String(ev.id), t: ev.date,
    h: { id: String(h.team.id), ab: h.team.abbreviation, n: h.team.displayName || h.team.name },
    a: { id: String(a.team.id), ab: a.team.abbreviation, n: a.team.displayName || a.team.name },
    hs: Number(h.score), as: Number(a.score),
    done: !!type.completed, live: type.state === 'in',
    odds: o ? { details: o.details || '', ou: o.overUnder || null } : null,
    po: st === 3, ls: okLs ? { a: la, h: lh } : null,
  };
}

function ingest(events, up) {
  for (const ev of events) {
    const g = parseEvent(ev); if (!g) continue;
    db.teams[g.h.id] = { ab: g.h.ab, n: g.h.n }; db.teams[g.a.id] = { ab: g.a.ab, n: g.a.n };
    if (g.done && Number.isFinite(g.hs) && Number.isFinite(g.as)) {
      const rec = { t: g.t, h: g.h.id, a: g.a.id, hs: g.hs, as: g.as };
      if (g.ls) rec.ls = g.ls;
      if (g.po) rec.po = 1;
      if (g.odds && g.odds.details) rec.o = g.odds.details;
      db.games[g.id] = rec;
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
    for (let d = parseYmd(SEASON_START); d <= addDays(today, 3); d = addDays(d, 1)) {
      const mo = d.getMonth();
      if (mo < 6 || mo > 8) days.push(ymd(d));            // pas de matchs NBA de juillet à septembre
    }
    const recent = ymd(addDays(today, -3));                 // les 3 derniers jours sont toujours rechargés
    const todo = days.filter((d) => d >= recent || !db.days[d]);
    const up = {}; const errors = []; let n = 0;
    await pool(todo, 6, async (d) => {
      try {
        ingest(await fetchDay(d), up);
        if (d < recent) db.days[d] = 1;
      } catch (e) { errors.push(e.message); }
      n++;
      if (n % 60 === 0) save();                              // on garde la progression si la page est fermée
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
  const games = Object.entries(db.games).map(([id, g]) => ({ id, ...g })).sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  const elo = {}, cnt = {}, last = {}, log = [], pred = {}; let season = null;
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
    pred[g.id] = { p, m: diff / PTS, warm: (cnt[g.h] || 0) < 15 || (cnt[g.a] || 0) < 15 };
    if ((cnt[g.h] || 0) >= 15 && (cnt[g.a] || 0) >= 15) log.push({ t: g.t, p, win });
    const dW = win ? diff : -diff;
    const mult = Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * dW);
    const delta = K * mult * (win - p);
    elo[g.h] = eh + delta; elo[g.a] = ea - delta;
    cnt[g.h] = (cnt[g.h] || 0) + 1; cnt[g.a] = (cnt[g.a] || 0) + 1;
    last[g.h] = day; last[g.a] = day;
  }
  return { elo, cnt, last, log, pred };
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
  lastModel = M;
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
  fillFilters();
  renderPlayed();
}

// ---------- Matchs joués ----------
const view = { team: '', opp: '', season: '', shown: 25 };
let lastModel = null;
const seasonLabel = (y) => `${y}-${pad((y + 1) % 100)}`;
const signed = (x, d = 0) => (x >= 0 ? '+' : '') + x.toFixed(d);

function fillFilters() {
  const ids = Object.keys(db.teams).sort((a, b) => db.teams[a].n.localeCompare(db.teams[b].n, 'fr'));
  const teamOpts = (all) => `<option value="">${all}</option>` + ids.map((id) => `<option value="${esc(id)}">${esc(db.teams[id].n)}</option>`).join('');
  const seasons = [...new Set(Object.values(db.games).map((g) => seasonOf(g.t)))].sort((a, b) => b - a);
  $('#fTeam').innerHTML = teamOpts('Toutes les équipes');
  $('#fOpp').innerHTML = teamOpts('Tous les adversaires');
  $('#fSeason').innerHTML = '<option value="">Toutes les saisons</option>' + seasons.map((y) => `<option value="${y}">${seasonLabel(y)}</option>`).join('');
  $('#fTeam').value = view.team; $('#fOpp').value = view.opp; $('#fSeason').value = view.season;
}

function summaryTiles(list, A, B, M, T) {
  let w = 0, hw = 0, hl = 0, aw = 0, al = 0, sm = 0, ok = 0, np = 0;
  for (const g of list) {
    const home = g.h === A, my = home ? g.hs : g.as, th = home ? g.as : g.hs;
    if (my > th) { w++; if (home) hw++; else aw++; } else if (home) hl++; else al++;
    sm += my - th;
    const p = M.pred[g.id];
    if (p) { np++; if ((p.p >= 0.5) === (g.hs > g.as)) ok++; }
  }
  const n = list.length, a = T(A).ab, b = B ? T(B).ab : '';
  return [
    [`${w}–${n - w}`, B ? `${a} contre ${b} (${n} matchs)` : `Victoires–défaites de ${a} (${n} matchs)`],
    [`${hw}–${hl} · ${aw}–${al}`, 'Domicile · Extérieur'],
    [signed(sm / n, 1), `Marge moyenne de ${a}`],
    [np ? `${(ok / np * 100).toFixed(0)} %` : '–', 'Victoires bien prédites par le modèle'],
  ];
}

function qTable(g, H, Aw) {
  if (!g.ls) return '<div class="line">Détail par quart-temps indisponible pour ce match.</div>';
  const n = Math.max(g.ls.a.length, g.ls.h.length);
  const cols = Array.from({ length: n }, (_, i) => i);
  const head = cols.map((i) => `<th class="n">${i < 4 ? 'Q' + (i + 1) : 'OT' + (i - 3)}</th>`).join('');
  const row = (ab, arr, tot) => `<tr><td>${esc(ab)}</td>${cols.map((i) => `<td class="n">${arr[i] ?? ''}</td>`).join('')}<td class="n"><b>${tot}</b></td></tr>`;
  return `<div class="scroll q"><table><tr><th></th>${head}<th class="n">Total</th></tr>${row(Aw.ab, g.ls.a, g.as)}${row(H.ab, g.ls.h, g.hs)}</table></div>`;
}

function renderPlayed() {
  const M = lastModel; if (!M) return;
  const T = (id) => db.teams[id] || { ab: '?', n: 'Équipe ' + id };
  let A = view.team, B = view.opp;
  if (!A && B) { A = B; B = ''; }
  if (A === B) B = '';
  let list = Object.entries(db.games).map(([id, g]) => ({ id, ...g }));
  if (view.season) list = list.filter((g) => String(seasonOf(g.t)) === view.season);
  if (A) list = list.filter((g) => g.h === A || g.a === A);
  if (B) list = list.filter((g) => g.h === B || g.a === B);
  list.sort((x, y) => (x.t < y.t ? 1 : x.t > y.t ? -1 : 0));

  if (!list.length) {
    $('#h2h').innerHTML = ''; $('#played').innerHTML = '<div class="empty">Aucun match pour ce filtre.</div>'; $('#more').hidden = true;
    return;
  }
  $('#h2h').innerHTML = A
    ? summaryTiles(list, A, B, M, T).map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')
    : '';

  $('#played').innerHTML = list.slice(0, view.shown).map((g) => {
    const H = T(g.h), Aw = T(g.a), p = M.pred[g.id], homeWin = g.hs > g.as;
    const date = new Date(g.t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    let badge = '', l1 = '', l2 = '';
    if (p) {
      const pickHome = p.p >= 0.5, good = pickHome === homeWin, pk = pickHome ? p.p : 1 - p.p;
      badge = `<span class="${good ? 'ok' : 'ko'}">${good ? '✓' : '✗'} modèle</span>`;
      l1 = `Modèle : <b>${esc(pickHome ? H.ab : Aw.ab)} ${(pk * 100).toFixed(0)}%</b> · marge prévue ${esc(H.ab)} ${signed(p.m, 1)} · réelle ${esc(H.ab)} ${signed(g.hs - g.as)}`
        + (p.warm ? ' · <i>modèle en rodage</i>' : '');
    }
    const sp = g.o ? parseSpread(g.o, H.ab, Aw.ab) : null;
    if (sp !== null) {
      const act = g.hs - g.as;
      l2 = `Ligne ESPN : ${esc(H.ab)} ${signed(sp, 1)} · ` + (act === sp ? 'égalité' : `${esc(act > sp ? H.ab : Aw.ab)} couvre`);
    }
    const wa = homeWin ? '' : 'w', wh = homeWin ? 'w' : '';
    return `<details class="game"><summary>
      <div class="meta"><span>${esc(date)}${g.po ? ' · Playoffs' : ''}</span>${badge}</div>
      <div class="score"><span class="${wa}" title="${esc(Aw.n)}">${esc(Aw.ab)}</span><span class="${wa}">${g.as}</span><span>–</span><span class="${wh}">${g.hs}</span><span class="${wh}" title="${esc(H.n)}">${esc(H.ab)}</span></div>
      ${l1 ? `<div class="line">${l1}</div>` : ''}${l2 ? `<div class="line">${l2}</div>` : ''}
      </summary>${qTable(g, H, Aw)}</details>`;
  }).join('');
  $('#more').hidden = list.length <= view.shown;
}

for (const [sel, key] of [['#fTeam', 'team'], ['#fOpp', 'opp'], ['#fSeason', 'season']]) {
  $(sel).addEventListener('change', (e) => { view[key] = e.target.value; view.shown = 25; renderPlayed(); });
}
$('#more').addEventListener('click', () => { view.shown += 25; renderPlayed(); });

// ---------- Démarrage ----------
$('#refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!db.updatedAt || Date.now() - Date.parse(db.updatedAt) > 15 * 60e3)) refresh();
});
render();
if (db.updatedAt) setStatus('Données en cache · mise à jour…');
refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
