'use strict';
// NBA Predict v2.0 : données ESPN (scoreboard) -> Elo + total de points -> prédictions.
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const SEASON_START = '20231024';   // début de la base d'historique : 3 saisons complètes + la saison en cours
const DB_VERSION = 3;              // à changer pour forcer un rechargement complet des données
const LS_KEY = 'nbaPredict.v1';
const PTS = 28;                                                 // Elo : points d'Elo par point de marge
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
async function refresh(manual) {
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
    let oddsMsg = '';
    try { await fetchOdds(manual === true ? 20 * 60e3 : 3 * 3600e3); } catch (e) { oddsMsg = ` · cotes indisponibles (${e.message === 'Failed to fetch' ? 'réseau ou accès bloqué' : e.message})`; }
    render();
    const hh = new Date(db.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    setStatus(`À jour · ${hh}` + (errors.length ? ` · ${errors.length} jour(s) en échec` : '') + oddsMsg, errors.length > 0 || !!oddsMsg);
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
// Réglages de départ de l'Elo ; l'appli les ajuste seule sur tes données (voir tuneElo).
const EBASE = { K: 20, HFA: 100, B2B: 40, R34: 0, REG: 0.25 };
const ECAND = { K: [12, 16, 20, 24, 30], HFA: [60, 80, 100, 120], B2B: [0, 20, 40, 60], R34: [0, 15, 30], REG: [0.1, 0.25, 0.4] };
const HOLD = 400;                                  // matchs les plus récents gardés de côté pour vérifier que le réglage aide vraiment
function fatigue(h, a, day, st, prm) {             // pénalité de repos : match la veille, 3e match en 4 soirs
  const f = (t) => {
    let x = 0; const l = st.last[t];
    if (l && dayDiff(day, l) === 1) x += prm.B2B;
    const hs = st.hist[t];
    if (hs && hs.filter((d) => { const n = dayDiff(day, d); return n >= 1 && n <= 3; }).length >= 2) x += prm.R34;
    return x;
  };
  return f(a) - f(h);
}
const eloDiff = (M, h, a, day) => (M.elo[h] ?? 1500) - (M.elo[a] ?? 1500) + M.prm.HFA + fatigue(h, a, day, M.st, M.prm);
const sigm = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p))));
function runElo(games, prm, keep) {
  const elo = {}, cnt = {}, st = { last: {}, hist: {} }, log = [], pred = {}; let season = null;
  games.forEach((g, i) => {
    const sn = seasonOf(g.t);
    if (season !== null && sn !== season) {
      for (const k in elo) elo[k] = 1505 + (elo[k] - 1505) * (1 - prm.REG);
      st.last = {}; st.hist = {};
    }
    season = sn;
    const eh = elo[g.h] ?? 1500, ea = elo[g.a] ?? 1500, day = dayKey(g.t);
    const diff = eh - ea + prm.HFA + fatigue(g.h, g.a, day, st, prm);
    const p = 1 / (1 + Math.pow(10, -diff / 400));
    const win = g.hs > g.as ? 1 : 0, mov = Math.abs(g.hs - g.as);
    const warm = (cnt[g.h] || 0) >= 15 && (cnt[g.a] || 0) >= 15;
    if (keep) pred[g.id] = { p, m: diff / PTS, cold: !warm };
    if (warm) log.push({ i, t: g.t, p, win });
    const dW = win ? diff : -diff;
    const mult = Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * dW);
    const delta = prm.K * mult * (win - p);
    elo[g.h] = eh + delta; elo[g.a] = ea - delta;
    cnt[g.h] = (cnt[g.h] || 0) + 1; cnt[g.a] = (cnt[g.a] || 0) + 1;
    for (const t of [g.h, g.a]) { st.last[t] = day; (st.hist[t] = st.hist[t] || []).push(day); if (st.hist[t].length > 4) st.hist[t].shift(); }
  });
  return { elo, cnt, st, log, pred };
}
const brierOf = (L) => L.length ? L.reduce((s, x) => s + (x.p - x.win) ** 2, 0) / L.length : NaN;
const accOf = (L) => L.length ? L.filter((x) => (x.p >= 0.5) === (x.win === 1)).length / L.length : NaN;
// Réglage automatique : on essaie quelques valeurs de chaque paramètre et on garde celles qui donnent le meilleur score de Brier.
function tuneElo(games) {
  const prm = { ...EBASE };
  let best = brierOf(runElo(games, prm, false).log);
  for (let pass = 0; pass < 2; pass++) for (const k of Object.keys(ECAND)) for (const v of ECAND[k]) {
    if (v === prm[k]) continue;
    const b = brierOf(runElo(games, { ...prm, [k]: v }, false).log);
    if (b < best - 1e-6) { best = b; prm[k] = v; }
  }
  return prm;
}
// Étalonnage : corrige les pourcentages (trop sûrs ou pas assez) par une régression logistique sur la sortie du modèle.
function plattFit(L) {
  let a = 1, b = 0;
  for (let it = 0; it < 300; it++) {
    let ga = 0, gb = 0;
    for (const x of L) { const z = logit(x.p), e = sigm(a * z + b) - x.win; ga += e * z; gb += e; }
    a -= 0.5 * ga / L.length; b -= 0.5 * gb / L.length;
  }
  return (p) => sigm(a * logit(p) + b);
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
  const cut = games.length > 1200 ? games.length - HOLD : 0;
  let prm = { ...EBASE }, evalPrm = prm, tune = null, calib = null, cal = (p) => p;
  if (cut) {   // 1) on règle sur le passé, 2) on vérifie sur les derniers matchs que le modèle n'a pas vus
    const tuned = tuneElo(games.slice(0, cut));
    const hb = runElo(games, EBASE, false).log.filter((x) => x.i >= cut), ht = runElo(games, tuned, false).log.filter((x) => x.i >= cut);
    const used = brierOf(ht) < brierOf(hb);
    tune = { n: hb.length, bBase: brierOf(hb), bTuned: brierOf(ht), aBase: accOf(hb), aTuned: accOf(ht), used };
    if (used) { evalPrm = tuned; prm = tuneElo(games); }
  }
  const R = runElo(games, prm, true);
  if (cut) {
    const E = runElo(games, evalPrm, false).log;
    const tr = E.filter((x) => x.i < cut), te = E.filter((x) => x.i >= cut);
    const f = plattFit(tr), mapped = te.map((x) => ({ ...x, p: f(x.p) }));
    const used = brierOf(mapped) < brierOf(te);
    calib = { bRaw: brierOf(te), bCal: brierOf(mapped), used };
    if (used) cal = plattFit(R.log);
  }
  const log = R.log.map((x) => ({ ...x, p: cal(x.p) }));
  for (const id in R.pred) R.pred[id].p = cal(R.pred[id].p);
  const totPrm = fitTotals(games);
  const tot = runTotals(games, totPrm.lam, totPrm.k, true);
  return { elo: R.elo, cnt: R.cnt, st: R.st, prm, cal, tune, calib, log, pred: R.pred, tot, totPrm };
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

// ---------- Cotes Betclic (The Odds API, clé gratuite saisie dans l'appli) ----------
const ODDS_URL = 'https://api.the-odds-api.com/v4/sports/basketball_nba/odds/';
const KEY_LS = 'nbaPredict.oddsKey';
const SIG_M = 12, EV_MIN = 0.03, EV_PICK = 0.05, EV_SUSPECT = 0.15;   // écart-type d'une marge NBA ; seuils de valeur
const getKey = () => { try { return localStorage.getItem(KEY_LS) || ''; } catch (e) { return ''; } };
const nick = (n) => String(n).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/).pop();
const Phi = (z) => {                                // loi normale : probabilité cumulée
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - q : q;
};
async function fetchOdds(maxAge) {
  const key = getKey(); if (!key) return;
  if (db.odds && Date.now() - Date.parse(db.odds.at) < maxAge) return;
  const r = await fetch(`${ODDS_URL}?apiKey=${encodeURIComponent(key)}&bookmakers=betclic_fr&markets=h2h,spreads,totals&oddsFormat=decimal&dateFormat=iso`);
  if (!r.ok) throw new Error(r.status === 401 ? 'clé refusée' : r.status === 429 ? 'quota de la clé atteint' : 'HTTP ' + r.status);
  const left = r.headers.get('x-requests-remaining');
  const items = [];
  for (const ev of await r.json()) {
    const bk = (ev.bookmakers || []).find((b) => b.key === 'betclic_fr'); if (!bk) continue;
    const it = { t: ev.commence_time, h: nick(ev.home_team), a: nick(ev.away_team) };
    for (const m of bk.markets || []) {
      const out = m.outcomes || [];
      if (m.key === 'h2h') {
        const o = (n) => (out.find((x) => nick(x.name) === n) || {}).price;
        if (o(it.h) && o(it.a)) it.ml = { h: o(it.h), a: o(it.a) };
      } else if (m.key === 'spreads') {
        const h = out.find((x) => nick(x.name) === it.h), w = out.find((x) => nick(x.name) === it.a);
        if (h && w) it.sp = { pt: h.point, h: h.price, a: w.price };
      } else if (m.key === 'totals') {
        const ov = out.find((x) => x.name === 'Over'), un = out.find((x) => x.name === 'Under');
        if (ov && un) it.tot = { pt: ov.point, o: ov.price, u: un.price };
      }
    }
    items.push(it);
  }
  db.odds = { at: new Date().toISOString(), items, left: left === null ? null : Number(left) };
  save();
}
function findOdds(g) {
  if (!db.odds) return null;
  const h = nick(T(g.h).n), a = nick(T(g.a).n);
  return db.odds.items.find((x) => x.h === h && x.a === a && Math.abs(Date.parse(x.t) - Date.parse(g.t)) < 12 * 3600e3) || null;
}
// Cotes Betclic d'un match + valeur (probabilité du modèle × cote − 1) de chaque pari possible.
function oddsBlock(g, M, ctx) {
  const o = findOdds(g); if (!o) return { html: '', bets: [] };
  const H = T(g.h), A = T(g.a), bets = [], parts = [];
  const sigT = (M.tot.mae || 14) * 1.2533;
  if (o.ml) {
    parts.push(`${esc(A.ab)} <b>${fr(o.ml.a, 2)}</b> · ${esc(H.ab)} <b>${fr(o.ml.h, 2)}</b>`);
    bets.push({ label: `${A.ab} gagne`, p: ctx.pa, odds: o.ml.a }, { label: `${H.ab} gagne`, p: ctx.ph, odds: o.ml.h });
  }
  if (o.sp) {
    const pc = Phi((ctx.margin + o.sp.pt) / SIG_M);
    const f = (ab, pt) => `${ab} ${pt > 0 ? '+' : '-'}${fr(Math.abs(pt))}`;
    parts.push(`Handicap ${esc(f(H.ab, o.sp.pt))} (${fr(o.sp.h, 2)}) / ${esc(f(A.ab, -o.sp.pt))} (${fr(o.sp.a, 2)})`);
    bets.push({ label: f(H.ab, o.sp.pt), p: pc, odds: o.sp.h }, { label: f(A.ab, -o.sp.pt), p: 1 - pc, odds: o.sp.a });
  }
  if (o.tot) {
    const po = 1 - Phi((o.tot.pt - ctx.tot) / sigT);
    parts.push(`Total ${fr(o.tot.pt)} : Over <b>${fr(o.tot.o, 2)}</b> · Under <b>${fr(o.tot.u, 2)}</b>`);
    bets.push({ label: `Over ${fr(o.tot.pt)}`, p: po, odds: o.tot.o }, { label: `Under ${fr(o.tot.pt)}`, p: 1 - po, odds: o.tot.u });
  }
  for (const b of bets) b.ev = b.p * b.odds - 1;
  const good = bets.filter((b) => b.ev >= EV_MIN).sort((x, y) => y.ev - x.ev);
  let html = parts.map((x) => `<div class="line">Betclic · ${x}</div>`).join('');
  if (good.length) html += `<div class="line">Valeur : ${good.slice(0, 2).map((b) => `<b class="pick">${esc(b.label)} @ ${fr(b.odds, 2)} (${signed(b.ev * 100)} %)</b>`).join(' · ')}</div>`;
  return { html, bets };
}

// ---------- Affichage : onglet À venir ----------
function upCard(g, M, picks) {
  const H = T(g.h), A = T(g.a), day = dayKey(g.t);
  const diff = eloDiff(M, g.h, g.a, day);
  const ph = M.cal(1 / (1 + Math.pow(10, -diff / 400))), pa = 1 - ph, margin = diff / PTS;
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
  const bt = oddsBlock(g, M, { ph, pa, margin, tot: pt.tot });
  if (picks) for (const b of bt.bets) picks.push({ ...b, g, time });
  return `<div class="card">
    <div class="meta"><span>${esc(time)}${g.live ? ' · <span class="live">EN COURS</span>' : ''}</span><span class="${tagCls}">${esc(tag)}</span></div>
    <div class="teams"><span>${esc(A.n)}</span><span class="at">@</span><span>${esc(H.n)}</span></div>
    <div class="bar"><i class="a" style="width:${(pa * 100).toFixed(1)}%"></i><i class="h" style="width:${(ph * 100).toFixed(1)}%"></i></div>
    <div class="probs"><span>${esc(A.ab)} ${(pa * 100).toFixed(0)}%</span><span>${esc(H.ab)} ${(ph * 100).toFixed(0)}%</span></div>
    <div class="line">Marge modèle : <b>${esc(winTxt(margin, H, A))}</b></div>
    <div class="line">${l2}</div>
    <div class="line">${l3}</div>${bt.html}</div>`;
}
function renderUp(M) {
  const box = $('#games'), now = Date.now();
  const list = db.upcoming.filter((g) => g.live || Date.parse(g.t) > now - 3 * 3600e3);
  if (!list.length) { box.innerHTML = '<div class="empty">Aucun match à venir trouvé.</div>'; return; }
  let html = '', cur = '';
  const picks = [];
  for (const g of list) {
    const d = new Date(g.t), key = ymd(d);
    if (key !== cur) { cur = key; html += `<div class="day">${esc(dayLabel(d))}</div>`; }
    html += upCard(g, M, picks);
  }
  box.innerHTML = html;
  const top = picks.filter((b) => b.ev >= EV_PICK).sort((x, y) => y.ev - x.ev).slice(0, 5);
  $('#picks').innerHTML = top.length
    ? `<h2>Paris à valeur (Betclic)</h2><div class="grp picks">` + top.map((b) => `<div class="pk"><div><b>${esc(b.label)}</b> @ ${fr(b.odds, 2)}<span>${esc(T(b.g.a).ab)} @ ${esc(T(b.g.h).ab)} · ${esc(b.time)}</span></div><div class="${b.ev >= EV_SUSPECT ? 'ko' : 'ok'}">${signed(b.ev * 100)} %${b.ev >= EV_SUSPECT ? '<span>à vérifier</span>' : ''}</div></div>`).join('') + `</div><p class="note">Valeur = probabilité du modèle × cote − 1. Un écart très grand vient souvent d'une info que le modèle n'a pas (blessure, repos) : vérifie avant de miser.</p>`
    : (getKey() ? '' : '<div class="note">Ajoute ta clé gratuite dans l\'onglet Modèle pour voir les cotes Betclic et les paris à valeur.</div>');
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

  const tl = [];
  if (M.tune) {
    tl.push([fr(M.tune.bTuned, 3) + ' contre ' + fr(M.tune.bBase, 3), `Score de Brier avec le réglage auto, contre le réglage de départ, sur les ${M.tune.n} derniers matchs (plus bas = mieux)`]);
    tl.push([fr(M.tune.aTuned * 100) + ' % contre ' + fr(M.tune.aBase * 100) + ' %', M.tune.used ? 'Victoires bien prédites, même test : le réglage auto est gardé' : 'Victoires bien prédites, même test : le réglage auto ne fait pas mieux, on garde celui de départ']);
  }
  if (M.calib) tl.push([fr(M.calib.bCal, 3) + ' contre ' + fr(M.calib.bRaw, 3), M.calib.used ? 'Brier avec et sans étalonnage des pourcentages : étalonnage gardé' : 'Brier avec et sans étalonnage : ça n\'aide pas, on ne l\'applique pas']);
  $('#tune').innerHTML = tl.length ? tl.map(tile).join('') : '<div class="empty">Pas encore assez de matchs pour régler le modèle.</div>';
  const bins = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]];
  const rows = bins.map(([lo, hi]) => {
    const B = L.filter((x) => Math.max(x.p, 1 - x.p) >= lo && Math.max(x.p, 1 - x.p) < hi);
    if (!B.length) return '';
    const pa = B.reduce((s, x) => s + Math.max(x.p, 1 - x.p), 0) / B.length, ok = accOf(B);
    return `<tr><td>${Math.round(lo * 100)}–${hi > 1 ? 100 : Math.round(hi * 100)} %</td><td class="n">${B.length}</td><td class="n">${fr(pa * 100, 0)} %</td><td class="n">${fr(ok * 100, 0)} %</td></tr>`;
  }).join('');
  $('#calib').innerHTML = rows ? '<tr><th>Confiance</th><th class="n">Matchs</th><th class="n">Annoncé</th><th class="n">Réel</th></tr>' + rows : '';
  const teams = Object.keys(M.elo).sort((a, b) => M.elo[b] - M.elo[a]);
  $('#rank').innerHTML = '<tr><th>#</th><th>Équipe</th><th class="n">Elo</th></tr>'
    + teams.map((id, i) => `<tr><td>${i + 1}</td><td>${esc(T(id).n)}</td><td class="n">${Math.round(M.elo[id])}</td></tr>`).join('');
  $('#oddsKey').value = getKey();
  $('#oddsInfo').textContent = !getKey() ? 'Pas de clé : les cotes Betclic ne sont pas chargées.'
    : db.odds ? `Cotes chargées à ${new Date(db.odds.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${db.odds.items.length} matchs${db.odds.left !== null && db.odds.left !== undefined ? ' · ' + db.odds.left + ' crédits restants ce mois-ci' : ''}`
    : 'Clé enregistrée, cotes pas encore chargées.';
  $('#modelnote').textContent = `Modèle v2.2 : Elo pour le vainqueur (réglage auto : K ${M.prm.K}, terrain ${M.prm.HFA}, match la veille -${M.prm.B2B}, 3e match en 4 soirs -${M.prm.R34}, régression de saison ${Math.round(M.prm.REG * 100)} %) ; attaque et défense de chaque équipe pour le total (réglage automatique : mémoire ${M.totPrm.lam}, prudence ${M.totPrm.k}). Les cotes des bookmakers sont très efficaces : ces écarts sont un point de départ, pas une garantie. Joue avec une mise que tu peux perdre.`;
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
$('#refresh').addEventListener('click', () => refresh(true));
$('#saveKey').addEventListener('click', () => {
  const v = $('#oddsKey').value.trim();
  try { if (v) localStorage.setItem(KEY_LS, v); else localStorage.removeItem(KEY_LS); } catch (e) {}
  db.odds = null; save(); refresh(true);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!db.updatedAt || Date.now() - Date.parse(db.updatedAt) > 15 * 60e3)) refresh();
});
setTab('up');
render();
if (db.updatedAt) setStatus('Données en cache · mise à jour…');
refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
