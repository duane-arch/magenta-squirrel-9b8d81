'use strict';
// NBA Predict v2.0 : données ESPN (scoreboard) -> Elo + total de points -> prédictions.
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const SEASON_START = '20231024';   // début de la base d'historique : 3 saisons complètes + la saison en cours
const DB_VERSION = 3;              // à changer pour forcer un rechargement complet des données
const LS_KEY = 'nbaPredict.v1';
const K = 20, HFA = 100, B2B = 40, PTS = 28;                    // Elo : vainqueur, marge
const HCA = 1.5, LG0 = 113, LG_PRIOR_N = 300, WARM = 15;        // total de points
const OU_EDGE = 5;                                              // écart (pts) à partir duquel le verdict Over/Under est mis en avant

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const parseYmd = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fr = (x, d = 1) => Number(x).toFixed(d).replace('.', ',');
const signed = (x, d = 0) => { const v = Number(x).toFixed(d); return (Number(v) >= 0 ? '+' : '-') + v.replace('-', '').replace('.', ','); };
const T = (id) => db.teams[id] || { ab: '?', n: 'Équipe ' + id };
const dayLabel = (d) => d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });

let db = load();
function load() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY));
    if (v && v.games) {
      if (v.v !== DB_VERSION) { v.days = {}; v.v = DB_VERSION; }   // nouvelle version : on recharge les jours pour récupérer les nouveaux détails
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
      if (g.odds && Number(g.odds.ou) > 100) rec.ou = Number(g.odds.ou);
      db.games[g.id] = rec;
    } else if (!g.done) {
      up[g.id] = { id: g.id, t: g.t, h: g.h.id, a: g.a.id, live: g.live, odds: g.odds };
    }
  }
}
async function refresh() {
  const btn = $('#refresh'); btn.disabled = true; btn.classList.add('busy');
  try {
    setStatus('Mise à jour des données…');
    db.days = db.days || {};
    const today = new Date();
    const days = [];
    for (let d = parseYmd(SEASON_START); d <= addDays(today, 3); d = addDays(d, 1)) {
      const mo = d.getMonth();
      if (mo < 6 || mo > 8) days.push(ymd(d));                // pas de matchs NBA de juillet à septembre
    }
    const recent = ymd(addDays(today, -3));                   // les 3 derniers jours sont toujours rechargés
    const todo = days.filter((d) => d >= recent || !db.days[d]);
    const up = {}; const errors = []; let n = 0;
    await pool(todo, 6, async (d) => {
      try {
        ingest(await fetchDay(d), up);
        if (d < recent) db.days[d] = 1;
      } catch (e) { errors.push(e.message); }
      n++;
      if (n % 60 === 0) save();                               // on garde la progression si la page est fermée
      if (n % 5 === 0 || n === todo.length) setStatus(`Récupération des matchs… (${n}/${todo.length})`);
    });
    if (errors.length && errors.length === todo.length) throw new Error(errors[0]);
    db.upcoming = Object.values(up).sort((x, y) => (x.t < y.t ? -1 : 1));
    db.updatedAt = new Date().toISOString();
    save();
    render();
    const hh = new Date(db.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    setStatus(`À jour · ${hh}` + (errors.length ? ` · ${errors.length} jour(s) en échec` : ''), errors.length > 0);
  } catch (e) {
    save();
    setStatus(`Échec de la mise à jour (${e.message}). Données en cache affichées.`, true);
    render();
  } finally { btn.disabled = false; btn.classList.remove('busy'); }
}

// ---------- Modèle Elo (vainqueur et marge) ----------
const dayKey = (iso) => new Date(Date.parse(iso) - 6 * 3600e3).toISOString().slice(0, 10); // ~heure US
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const seasonOf = (iso) => { const d = new Date(iso); return d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
function fatigue(h, a, day, last) {
  let adj = 0;
  if (last[h] && dayDiff(day, last[h]) === 1) adj -= B2B;
  if (last[a] && dayDiff(day, last[a]) === 1) adj += B2B;
  return adj;
}

// ---------- Modèle du total de points (Over/Under) ----------
// Chaque équipe a une attaque et une défense (écart à la moyenne de la ligue, ajusté de l'adversaire et du terrain),
// moyennées avec une mémoire qui décroît. Les 2 réglages (mémoire, prudence) sont choisis automatiquement
// sur tes propres données : le meilleur est celui qui se trompe le moins sur les totaux déjà joués.
function runTotals(games, lam, shrink, keep) {
  const tm = {}, cnt = {};
  let lgSum = 0, lgN = 0, prior = LG0, season = null, errSum = 0, errN = 0;
  const pred = {}, log = [];
  const rate = (id) => { const x = tm[id] || (tm[id] = { off: 0, def: 0, n: 0 }); return { o: x.off / (x.n + shrink), d: x.def / (x.n + shrink) }; };
  for (const g of games) {
    const sn = seasonOf(g.t);
    if (season !== null && sn !== season) {
      prior = lgN ? lgSum / lgN : prior;                       // moyenne de la saison écoulée
      lgSum = 0; lgN = 0;
      for (const id in tm) { tm[id].off *= 0.5; tm[id].def *= 0.5; tm[id].n *= 0.5; }
    }
    season = sn;
    const lg = (lgSum + prior * LG_PRIOR_N) / (lgN + LG_PRIOR_N);
    const rh = rate(g.h), ra = rate(g.a);
    const ph = lg + rh.o + ra.d + HCA, pa = lg + ra.o + rh.d - HCA;
    const tot = ph + pa, act = g.hs + g.as;
    const warm = (cnt[g.h] || 0) >= WARM && (cnt[g.a] || 0) >= WARM;
    if (warm) { errSum += Math.abs(tot - act); errN++; }
    if (keep) {
      pred[g.id] = { tot, ph, pa, cold: !warm };
      if (warm) log.push({ tot, act, ou: g.ou || null, lg });
    }
    const H = tm[g.h], A = tm[g.a];
    H.off = lam * H.off + (g.hs - lg - HCA - ra.d);
    H.def = lam * H.def + (g.as - lg + HCA - ra.o);
    A.off = lam * A.off + (g.as - lg + HCA - rh.d);
    A.def = lam * A.def + (g.hs - lg - HCA - rh.o);
    H.n = lam * H.n + 1; A.n = lam * A.n + 1;
    lgSum += act; lgN += 2;
    cnt[g.h] = (cnt[g.h] || 0) + 1; cnt[g.a] = (cnt[g.a] || 0) + 1;
  }
  const lgNow = (lgSum + prior * LG_PRIOR_N) / (lgN + LG_PRIOR_N);
  return { mae: errN ? errSum / errN : null, n: errN, rate, lg: lgNow, pred, log };
}
function fitTotals(games) {
  let best = null;
  for (const lam of [0.88, 0.92, 0.95]) for (const k of [2, 4, 8]) {
    const r = runTotals(games, lam, k, false);
    if (r.mae !== null && (!best || r.mae < best.mae)) best = { lam, k, mae: r.mae };
  }
  return best || { lam: 0.92, k: 4, mae: null };
}
function predictTot(M, h, a) {
  const t = M.tot, rh = t.rate(h), ra = t.rate(a);
  const ph = t.lg + rh.o + ra.d + HCA, pa = t.lg + ra.o + rh.d - HCA;
  return { tot: ph + pa, ph, pa };
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
    pred[g.id] = { p, m: diff / PTS, cold: (cnt[g.h] || 0) < 15 || (cnt[g.a] || 0) < 15 };
    if ((cnt[g.h] || 0) >= 15 && (cnt[g.a] || 0) >= 15) log.push({ t: g.t, p, win });
    const dW = win ? diff : -diff;
    const mult = Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * dW);
    const delta = K * mult * (win - p);
    elo[g.h] = eh + delta; elo[g.a] = ea - delta;
    cnt[g.h] = (cnt[g.h] || 0) + 1; cnt[g.a] = (cnt[g.a] || 0) + 1;
    last[g.h] = day; last[g.a] = day;
  }
  const totPrm = fitTotals(games);
  const tot = runTotals(games, totPrm.lam, totPrm.k, true);
  return { elo, cnt, last, log, pred, tot, totPrm };
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
// Ligne ESPN à la façon des parieurs : le favori porte le signe moins.
function lineTxt(s, H, A) {
  if (s === 0) return "match nul (pick'em)";
  return `${s > 0 ? H.ab : A.ab} -${fr(Math.abs(s))} (favori)`;
}
const winTxt = (m, H, A, d = 1) => `${m >= 0 ? H.ab : A.ab} +${fr(Math.abs(m), d)}`;   // « BOS +5,5 » : BOS gagne de 5,5

// ---------- Affichage : onglet À venir ----------
function upCard(g, M) {
  const H = T(g.h), A = T(g.a), day = dayKey(g.t);
  const eh = M.elo[g.h] ?? 1500, ea = M.elo[g.a] ?? 1500;
  const diff = eh - ea + HFA + fatigue(g.h, g.a, day, M.last);
  const ph = 1 / (1 + Math.pow(10, -diff / 400)), pa = 1 - ph, margin = diff / PTS;
  const time = new Date(g.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const spread = g.odds ? parseSpread(g.odds.details, H.ab, A.ab) : null;
  let tag = '', tagCls = '', l2 = 'Pas de cote disponible';
  if (spread !== null) {
    const gap = margin - spread;
    tag = `Écart ${fr(Math.abs(gap))} pts pour ${gap >= 0 ? H.ab : A.ab}`; tagCls = Math.abs(gap) >= 3 ? 'pick' : '';
    l2 = `Ligne ESPN : <b>${esc(lineTxt(spread, H, A))}</b>`;
  }
  const pt = predictTot(M, g.h, g.a), ou = g.odds && Number(g.odds.ou) > 100 ? Number(g.odds.ou) : null;
  let l3 = `Total prévu : <b>${fr(pt.tot)} pts</b>`;
  if (ou) {
    const d = pt.tot - ou;
    l3 += ` · O/U ESPN ${fr(ou)} → <b class="${Math.abs(d) >= OU_EDGE ? 'pick' : ''}">${d >= 0 ? 'Over' : 'Under'} (${signed(d, 1)})</b>`;
  } else l3 += ' · pas de ligne O/U pour l\'instant';
  return `<div class="card">
    <div class="meta"><span>${esc(time)}${g.live ? ' · <span class="live">EN COURS</span>' : ''}</span><span class="${tagCls}">${esc(tag)}</span></div>
    <div class="teams"><span>${esc(A.n)}</span><span class="at">@</span><span>${esc(H.n)}</span></div>
    <div class="bar"><i class="a" style="width:${(pa * 100).toFixed(1)}%"></i><i class="h" style="width:${(ph * 100).toFixed(1)}%"></i></div>
    <div class="probs"><span>${esc(A.ab)} ${(pa * 100).toFixed(0)}%</span><span>${esc(H.ab)} ${(ph * 100).toFixed(0)}%</span></div>
    <div class="line">Marge modèle : <b>${esc(winTxt(margin, H, A))}</b></div>
    <div class="line">${l2}</div>
    <div class="line">${l3}</div></div>`;
}
function renderUp(M) {
  const box = $('#games'), now = Date.now();
  const list = db.upcoming.filter((g) => g.live || Date.parse(g.t) > now - 3 * 3600e3);
  if (!list.length) { box.innerHTML = '<div class="empty">Aucun match à venir trouvé.</div>'; return; }
  let html = '', cur = '';
  for (const g of list) {
    const d = new Date(g.t), key = ymd(d);
    if (key !== cur) { cur = key; html += `<div class="day">${esc(dayLabel(d))}</div>`; }
    html += upCard(g, M);
  }
  box.innerHTML = html;
}

// ---------- Affichage : onglet Modèle ----------
function renderModel(M) {
  const L = M.log, n = L.length;
  const tile = ([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`;
  if (n) {
    const acc = L.filter((x) => (x.p >= 0.5) === (x.win === 1)).length / n;
    const brier = L.reduce((s, x) => s + (x.p - x.win) ** 2, 0) / n;
    const homeRate = L.filter((x) => x.win === 1).length / n;
    const l100 = L.slice(-100), acc100 = l100.filter((x) => (x.p >= 0.5) === (x.win === 1)).length / l100.length;
    $('#stats').innerHTML = [
      [fr(acc * 100) + ' %', `Victoires bien prédites (${n} matchs)`],
      [fr(acc100 * 100) + ' %', '100 derniers matchs'],
      [fr(brier, 3), 'Score de Brier (0,25 = hasard)'],
      [fr(homeRate * 100) + ' %', 'Référence : toujours le domicile'],
    ].map(tile).join('');
  } else $('#stats').innerHTML = '<div class="empty">Pas encore assez de matchs.</div>';

  const TL = M.tot.log, avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  if (TL.length >= 30) {
    const tiles = [
      [fr(avg(TL.map((x) => Math.abs(x.tot - x.act)))) + ' pts', `Erreur moyenne du total prévu (${TL.length} matchs)`],
      [fr(avg(TL.map((x) => Math.abs(2 * x.lg - x.act)))) + ' pts', 'Référence : toujours la moyenne de la ligue'],
    ];
    const W = TL.filter((x) => x.ou);
    if (W.length >= 30) {
      tiles.push([fr(avg(W.map((x) => Math.abs(x.ou - x.act)))) + ' pts', `Erreur de la ligne O/U ESPN (${W.length} matchs)`]);
      tiles.push([fr(avg(W.map((x) => Math.abs(x.tot - x.act)))) + ' pts', 'Modèle sur ces mêmes matchs']);
      const E = W.filter((x) => Math.abs(x.tot - x.ou) >= OU_EDGE && x.act !== x.ou);
      if (E.length >= 20) tiles.push([Math.round(E.filter((x) => (x.tot > x.ou) === (x.act > x.ou)).length / E.length * 100) + ' %',
        `Over/Under bien prédits quand le modèle s'écarte d'au moins ${OU_EDGE} pts de la ligne (${E.length} matchs)`]);
    } else tiles.push(['–', "Pas assez d'anciennes lignes O/U ESPN pour comparer"]);
    $('#totstats').innerHTML = tiles.map(tile).join('');
  } else $('#totstats').innerHTML = '<div class="empty">Pas encore assez de matchs.</div>';

  const teams = Object.keys(M.elo).sort((a, b) => M.elo[b] - M.elo[a]);
  $('#rank').innerHTML = '<tr><th>#</th><th>Équipe</th><th class="n">Elo</th></tr>'
    + teams.map((id, i) => `<tr><td>${i + 1}</td><td>${esc(T(id).n)}</td><td class="n">${Math.round(M.elo[id])}</td></tr>`).join('');
  $('#modelnote').textContent = `Modèle v2.0 : Elo (avantage du terrain, marge, fatigue) pour le vainqueur ; attaque et défense de chaque équipe pour le total (réglage automatique : mémoire ${M.totPrm.lam}, prudence ${M.totPrm.k}). Les cotes des bookmakers sont très efficaces : ces écarts sont un point de départ, pas une garantie. Joue avec une mise que tu peux perdre.`;
}

// ---------- Affichage : onglet Joués ----------
const view = { team: '', opp: '', season: '', shown: 25 };
let lastModel = null;
const seasonLabel = (y) => `${y}-${pad((y + 1) % 100)}`;

function fillFilters() {
  const ids = Object.keys(db.teams).sort((a, b) => db.teams[a].n.localeCompare(db.teams[b].n, 'fr'));
  const teamOpts = (all) => `<option value="">${all}</option>` + ids.map((id) => `<option value="${esc(id)}">${esc(db.teams[id].n)}</option>`).join('');
  const seasons = [...new Set(Object.values(db.games).map((g) => seasonOf(g.t)))].sort((a, b) => b - a);
  $('#fTeam').innerHTML = teamOpts('Équipe');
  $('#fOpp').innerHTML = teamOpts('Adversaire');
  $('#fSeason').innerHTML = '<option value="">Saison</option>' + seasons.map((y) => `<option value="${y}">${seasonLabel(y)}</option>`).join('');
  $('#fTeam').value = view.team; $('#fOpp').value = view.opp; $('#fSeason').value = view.season;
}
function summaryTiles(list, A, B, M) {
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
  const n = Math.max(g.ls.a.length, g.ls.h.length), cols = Array.from({ length: n }, (_, i) => i);
  const head = cols.map((i) => `<th class="n">${i < 4 ? 'Q' + (i + 1) : 'OT' + (i - 3)}</th>`).join('');
  const row = (ab, arr, tot) => `<tr><td>${esc(ab)}</td>${cols.map((i) => `<td class="n">${arr[i] ?? ''}</td>`).join('')}<td class="n"><b>${tot}</b></td></tr>`;
  return `<div class="scroll q"><table><tr><th></th>${head}<th class="n">Total</th></tr>${row(Aw.ab, g.ls.a, g.as)}${row(H.ab, g.ls.h, g.hs)}</table></div>`;
}
function playedRow(g, M) {
  const H = T(g.h), Aw = T(g.a), p = M.pred[g.id], tp = M.tot.pred[g.id], homeWin = g.hs > g.as;
  let right = '', lines = '';
  if (p) {
    const pickHome = p.p >= 0.5, good = pickHome === homeWin, pk = pickHome ? p.p : 1 - p.p;
    right = `<span class="${good ? 'ok' : 'ko'}">${good ? '✓ juste' : '✗ raté'}</span><span>Modèle : ${esc(pickHome ? H.ab : Aw.ab)} ${(pk * 100).toFixed(0)}%</span>`;
    lines += `<div class="line">Marge : modèle ${esc(winTxt(p.m, H, Aw))} · réelle ${esc(winTxt(g.hs - g.as, H, Aw, 0))}${p.cold ? ' · <i>modèle en rodage</i>' : ''}</div>`;
  }
  const act = g.hs + g.as;
  let tl = `Total : réel ${act} pts`;
  if (tp) tl += ` · prévu ${fr(tp.tot)}`;
  if (g.ou) tl += ` · O/U ESPN ${fr(g.ou)} → ${act > g.ou ? 'Over' : act < g.ou ? 'Under' : 'égalité'}`;
  lines += `<div class="line">${esc(tl)}</div>`;
  const sp = g.o ? parseSpread(g.o, H.ab, Aw.ab) : null;
  if (sp !== null) {
    const m = g.hs - g.as;
    lines += `<div class="line">Ligne ESPN : ${esc(lineTxt(sp, H, Aw))} · ${m === sp ? 'égalité' : esc(m > sp ? H.ab : Aw.ab) + ' couvre'}</div>`;
  }
  const wa = homeWin ? '' : 'w', wh = homeWin ? 'w' : '';
  return `<details class="game"><summary>
    <div class="sc"><div class="${wa}" title="${esc(Aw.n)}"><span>${esc(Aw.ab)}</span><span>${g.as}</span></div><div class="${wh}" title="${esc(H.n)}"><span>${esc(H.ab)}</span><span>${g.hs}</span></div></div>
    <div class="sep"></div><div class="rt">${right}</div></summary>
    <div class="det">${lines}${qTable(g, H, Aw)}</div></details>`;
}
function renderPlayed() {
  const M = lastModel; if (!M) return;
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
  $('#h2h').innerHTML = A ? summaryTiles(list, A, B, M).map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('') : '';
  let html = '', cur = '', label = '', grp = [];
  const flush = () => { if (grp.length) html += `<div class="dayh"><span>${esc(label)}</span><span>${grp.length} match${grp.length > 1 ? 's' : ''}</span></div><div class="grp">${grp.join('')}</div>`; grp = []; };
  for (const g of list.slice(0, view.shown)) {
    const d = new Date(g.t), key = ymd(d);
    if (key !== cur) { flush(); cur = key; label = dayLabel(d); }
    grp.push(playedRow(g, M));
  }
  flush();
  $('#played').innerHTML = html;
  $('#more').hidden = list.length <= view.shown;
}

function render() {
  const M = runModel(); lastModel = M;
  renderUp(M); renderModel(M); fillFilters(); renderPlayed();
}

// ---------- Onglets ----------
const TITLES = { played: 'Matchs joués', up: 'Matchs à venir', model: 'Modèle' };
function setTab(t) {
  for (const id of Object.keys(TITLES)) $('#tab-' + id).hidden = id !== t;
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === t;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  $('#heading').textContent = TITLES[t];
  if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
}

// ---------- Démarrage ----------
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
for (const [sel, key] of [['#fTeam', 'team'], ['#fOpp', 'opp'], ['#fSeason', 'season']]) {
  $(sel).addEventListener('change', (e) => { view[key] = e.target.value; view.shown = 25; renderPlayed(); });
}
$('#more').addEventListener('click', () => { view.shown += 25; renderPlayed(); });
$('#refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!db.updatedAt || Date.now() - Date.parse(db.updatedAt) > 15 * 60e3)) refresh();
});
setTab('up');
render();
if (db.updatedAt) setStatus('Données en cache · mise à jour…');
refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
