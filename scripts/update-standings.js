// Weekly job: fetch every regular-season game result, recompute the whole
// season from zero, and write data/results.json + data/standings.json.
//
//   node scripts/update-standings.js                 ESPN, falling back to nflverse
//   node scripts/update-standings.js --source=nflverse   force the fallback (for testing)
//
// Files are only rewritten when their content (ignoring timestamps) changes,
// so a no-op run produces no diff and no commit.

import { readFile, writeFile } from 'node:fs/promises';

const DATA = new URL('../data/', import.meta.url);
const WEEKS = 18;
const GAMES_PER_TEAM = 17;

// nflverse uses different codes for two teams; everything else matches ESPN.
const NFLVERSE_TO_ESPN = { LA: 'LAR', WAS: 'WSH' };

const logoUrl = (abbr) => `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`;

// ---------------------------------------------------------------- fetching

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

async function fromEspn(season) {
  const games = [];
  const teams = new Set();
  for (let week = 1; week <= WEEKS; week++) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;
    const data = await (await fetchWithRetry(url)).json();
    if (!Array.isArray(data.events)) throw new Error(`ESPN week ${week}: no events array`);

    for (const e of data.events) {
      if (e.season?.type !== 2) continue;
      const cs = e.competitions?.[0]?.competitors;
      const home = cs?.find((c) => c.homeAway === 'home');
      const away = cs?.find((c) => c.homeAway === 'away');
      const gameWeek = e.week?.number;
      if (!home?.team?.abbreviation || !away?.team?.abbreviation || typeof gameWeek !== 'number') {
        throw new Error(`ESPN week ${week}: malformed event ${e.id}`);
      }
      teams.add(home.team.abbreviation).add(away.team.abbreviation);
      if (e.status?.type?.completed !== true) continue;

      games.push(toGame({
        week: gameWeek,
        gameId: String(e.id),
        home: home.team.abbreviation,
        away: away.team.abbreviation,
        homeScore: Number(home.score),
        awayScore: Number(away.score),
        homeWon: home.winner === true,
        awayWon: away.winner === true,
      }));
    }
  }
  return { source: 'espn', games, teams };
}

async function fromNflverse(season) {
  const url = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
  const rows = parseCsv(await (await fetchWithRetry(url)).text());
  const [header, ...body] = rows;
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const needed of ['season', 'game_type', 'week', 'home_team', 'away_team', 'home_score', 'away_score', 'espn']) {
    if (!(needed in col)) throw new Error(`nflverse CSV missing column ${needed}`);
  }
  const code = (t) => NFLVERSE_TO_ESPN[t] ?? t;

  const games = [];
  const teams = new Set();
  for (const r of body) {
    if (r[col.season] !== String(season) || r[col.game_type] !== 'REG') continue;
    const home = code(r[col.home_team]);
    const away = code(r[col.away_team]);
    teams.add(home).add(away);
    if (r[col.home_score] === '' || r[col.away_score] === '') continue;

    const homeScore = Number(r[col.home_score]);
    const awayScore = Number(r[col.away_score]);
    games.push(toGame({
      week: Number(r[col.week]),
      gameId: r[col.espn] || r[col.game_id],
      home, away, homeScore, awayScore,
      homeWon: homeScore > awayScore,
      awayWon: awayScore > homeScore,
    }));
  }
  if (teams.size === 0) throw new Error(`nflverse has no ${season} regular-season games`);
  return { source: 'nflverse', games, teams };
}

function toGame({ week, gameId, home, away, homeScore, awayScore, homeWon, awayWon }) {
  if (homeWon && awayWon) throw new Error(`Game ${gameId}: both teams marked winner`);
  const tie = !homeWon && !awayWon;
  if (tie && homeScore !== awayScore) throw new Error(`Game ${gameId}: no winner but score ${awayScore}-${homeScore}`);
  return {
    week, gameId, away, home, awayScore, homeScore,
    winner: tie ? null : homeWon ? home : away,
    loser: tie ? null : homeWon ? away : home,
    tie,
  };
}

// Minimal RFC 4180 parser: handles quoted fields containing commas/quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- scoring

function computeStandings(rosters, games) {
  const throughWeek = games.reduce((m, g) => Math.max(m, g.week), 0);

  const played = {};
  const wins = {};
  for (const g of games) {
    played[g.home] = (played[g.home] ?? 0) + 1;
    played[g.away] = (played[g.away] ?? 0) + 1;
    if (g.winner) wins[g.winner] = (wins[g.winner] ?? 0) + 1;
  }

  const rows = rosters.drafters.map((d) => {
    const abbrs = new Set(d.teams.map((t) => t.abbr));
    const byWeek = Array(throughWeek).fill(0);
    for (const g of games) if (g.winner && abbrs.has(g.winner)) byWeek[g.week - 1]++;
    const total = byWeek.reduce((a, b) => a + b, 0);
    const remaining = d.teams.reduce((n, t) => n + GAMES_PER_TEAM - (played[t.abbr] ?? 0), 0);
    return {
      name: d.name,
      total,
      maxPossible: total + remaining,
      byWeek,
      teams: d.teams.map((t) => ({ abbr: t.abbr, label: t.label, wins: wins[t.abbr] ?? 0, logo: logoUrl(t.abbr) })),
    };
  });

  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  // Competition ranking: 7, 7, 6 -> 1, 1, 3.
  const countAt = {};
  for (const r of rows) countAt[r.total] = (countAt[r.total] ?? 0) + 1;
  const standings = rows.map((r, i) => {
    const rank = i > 0 && rows[i - 1].total === r.total ? null : i + 1;
    return { rank, ...r };
  });
  for (let i = 0; i < standings.length; i++) standings[i].rank ??= standings[i - 1].rank;

  let moneyNote = null;
  for (const s of standings) {
    const size = countAt[s.total];
    s.tied = size > 1;
    s.inTheMoney = s.rank <= 2;
  }
  // Tie groups touching the money line (at most one note applies; take the first).
  for (const rank of [1, 2]) {
    const group = standings.filter((s) => s.rank === rank);
    if (group.length < 2 || moneyNote) continue;
    const names = group.map((s) => s.name).join(', ');
    if (rank === 1 && group.length === 2) moneyNote = `${names} are tied for 1st. Who takes 1st vs 2nd is unresolved.`;
    else if (rank === 1) moneyNote = `${group.length}-way tie for 1st (${names}). Both money spots are unresolved.`;
    else moneyNote = `${group.length}-way tie for 2nd (${names}). The 2nd-place money spot is unresolved.`;
  }

  // Key order for readable JSON.
  return {
    throughWeek,
    moneyNote,
    standings: standings.map(({ rank, name, total, maxPossible, inTheMoney, tied, byWeek, teams }) =>
      ({ rank, name, total, maxPossible, inTheMoney, tied, byWeek, teams })),
  };
}

// ---------------------------------------------------------------- output

// Objects/arrays holding only primitives go on one line; everything else nests.
function pretty(v, ind = '') {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const isArr = Array.isArray(v);
  const entries = isArr ? v.map((x) => [null, x]) : Object.entries(v);
  if (entries.length === 0) return isArr ? '[]' : '{}';
  const fmt = ([k, x], p) => (k === null ? '' : `${JSON.stringify(k)}: `) + p(x);
  if (entries.every(([, x]) => x === null || typeof x !== 'object')) {
    const inner = entries.map((e) => fmt(e, JSON.stringify)).join(', ');
    return isArr ? `[${inner}]` : `{ ${inner} }`;
  }
  const next = ind + '  ';
  const inner = entries.map((e) => next + fmt(e, (x) => pretty(x, next))).join(',\n');
  return isArr ? `[\n${inner}\n${ind}]` : `{\n${inner}\n${ind}}`;
}

// Write only if the content (minus the timestamp field) differs from what's on disk.
async function writeIfChanged(file, obj, timestampKey) {
  const url = new URL(file, DATA);
  const strip = (o) => JSON.stringify({ ...o, [timestampKey]: undefined });
  try {
    const existing = JSON.parse(await readFile(url, 'utf8'));
    if (strip(existing) === strip(obj)) return false;
  } catch { /* missing or unreadable: write it */ }
  await writeFile(url, pretty(obj) + '\n');
  return true;
}

// ---------------------------------------------------------------- main

async function main() {
  const rosters = JSON.parse(await readFile(new URL('rosters.json', DATA), 'utf8'));
  const season = rosters.season;
  const forced = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1];

  let fetched;
  if (forced === 'nflverse') {
    fetched = await fromNflverse(season);
  } else {
    try {
      fetched = await fromEspn(season);
    } catch (err) {
      console.warn(`ESPN failed (${err.message}); falling back to nflverse`);
      fetched = await fromNflverse(season);
    }
  }

  const missing = rosters.drafters.flatMap((d) => d.teams.map((t) => t.abbr)).filter((a) => !fetched.teams.has(a));
  if (missing.length) throw new Error(`Roster teams not found in ${fetched.source} data: ${missing.join(', ')}`);

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const games = fetched.games.sort((a, b) => a.week - b.week || a.gameId.localeCompare(b.gameId));
  const { throughWeek, moneyNote, standings } = computeStandings(rosters, games);

  const results = { season, fetchedAt: now, source: fetched.source, lastCompletedWeek: throughWeek, games };
  const out = { season, updatedAt: now, throughWeek, moneyNote, standings };

  const r = await writeIfChanged('results.json', results, 'fetchedAt');
  const s = await writeIfChanged('standings.json', out, 'updatedAt');

  console.log(`Source: ${fetched.source}. ${games.length} completed games through Week ${throughWeek}.`);
  console.log(r || s ? 'Data changed; files written.' : 'No change.');
  for (const x of standings) console.log(`  ${String(x.rank).padStart(2)}${x.inTheMoney ? ' $' : '  '} ${x.name.padEnd(7)} ${x.total}`);
  if (moneyNote) console.log(`  Note: ${moneyNote}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
