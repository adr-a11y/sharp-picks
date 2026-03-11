import https from "https";

// ── ESPN API helpers ──────────────────────────────────────────────────────
// No API key required. Uses the public ESPN site API.

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports";

async function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    }).on("error", () => resolve(null));
  });
}

// ── Sport config ─────────────────────────────────────────────────────────

export type SportConfig = {
  espnSport: string;
  espnLeague: string;
  season: number;
};

export function getEspnConfig(oddsApiSport: string): SportConfig | null {
  if (oddsApiSport.includes("basketball_nba"))
    return { espnSport: "basketball", espnLeague: "nba", season: 2025 };
  if (oddsApiSport.includes("basketball_ncaab"))
    return { espnSport: "basketball", espnLeague: "mens-college-basketball", season: 2025 };
  if (oddsApiSport.includes("icehockey_nhl"))
    return { espnSport: "hockey", espnLeague: "nhl", season: 2025 };
  if (oddsApiSport.includes("baseball_mlb"))
    return { espnSport: "baseball", espnLeague: "mlb", season: 2025 };
  if (oddsApiSport.includes("americanfootball_nfl"))
    return { espnSport: "football", espnLeague: "nfl", season: 2025 };
  return null;
}

// ── Team ID lookup ────────────────────────────────────────────────────────

// Cache team lists to avoid redundant requests
const teamCache: Record<string, Record<string, string>> = {};

export async function getTeamIdMap(sport: string, league: string): Promise<Record<string, string>> {
  const key = `${sport}/${league}`;
  if (teamCache[key]) return teamCache[key];

  const data = await fetchJson(`${ESPN_BASE}/${sport}/${league}/teams?limit=200`);
  if (!data) return {};

  const teams = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  const map: Record<string, string> = {};

  for (const t of teams) {
    const team = t.team;
    if (!team) continue;
    const id = team.id as string;
    // Index by multiple name variants
    map[team.displayName?.toLowerCase()] = id;
    map[team.shortDisplayName?.toLowerCase()] = id;
    map[team.abbreviation?.toLowerCase()] = id;
    map[team.name?.toLowerCase()] = id;
    map[team.nickname?.toLowerCase()] = id;
    map[team.location?.toLowerCase()] = id;
  }

  teamCache[key] = map;
  return map;
}

export function findTeamId(name: string, idMap: Record<string, string>): string | null {
  const lower = name.toLowerCase();
  // Direct match
  if (idMap[lower]) return idMap[lower];
  // Partial match — check if any key is contained in the name
  for (const [key, id] of Object.entries(idMap)) {
    if (key.length >= 4 && (lower.includes(key) || key.includes(lower))) {
      return id;
    }
  }
  return null;
}

// ── Team season record & splits ───────────────────────────────────────────

export interface TeamRecord {
  overall: string;        // "64-18"
  home: string;           // "34-7"
  away: string;           // "30-11"
  wins: number;
  losses: number;
  homeWins: number;
  homeLosses: number;
  awayWins: number;
  awayLosses: number;
  avgPointsFor: number;
  avgPointsAgainst: number;
  avgMargin: number;
  last5: string[];        // ["W","L","W","W","L"]
  last10: string[];
  currentStreak: string;  // "W3" or "L1"
  // computed from game log
  atsWins: number;
  atsLosses: number;
  atsPushes: number;
  roadAtsWins: number;
  roadAtsLosses: number;
  homeAtsWins: number;
  homeAtsLosses: number;
  avgTotalPoints: number; // avg combined score
}

export async function getTeamRecord(
  teamId: string,
  sport: string,
  league: string,
  season: number
): Promise<TeamRecord | null> {
  // Get schedule with scores
  const data = await fetchJson(
    `${ESPN_BASE}/${sport}/${league}/teams/${teamId}/schedule?season=${season}`
  );
  if (!data) return null;

  const events = data.events ?? [];
  const completed = events.filter(
    (e: any) => e.competitions?.[0]?.status?.type?.completed === true
  );

  if (completed.length === 0) return null;

  let wins = 0, losses = 0;
  let homeWins = 0, homeLosses = 0;
  let awayWins = 0, awayLosses = 0;
  let atsWins = 0, atsLosses = 0, atsPushes = 0;
  let roadAtsWins = 0, roadAtsLosses = 0;
  let homeAtsWins = 0, homeAtsLosses = 0;
  const ptsScored: number[] = [];
  const ptsAllowed: number[] = [];
  const totals: number[] = [];
  const streak: string[] = [];

  for (const e of completed) {
    const comp = e.competitions[0];
    const competitors: any[] = comp.competitors ?? [];
    const myTeam = competitors.find((c: any) => c.team?.id === teamId);
    const oppTeam = competitors.find((c: any) => c.team?.id !== teamId);
    if (!myTeam || !oppTeam) continue;

    const myScore = parseFloat(myTeam.score?.displayValue ?? "0");
    const oppScore = parseFloat(oppTeam.score?.displayValue ?? "0");
    const isHome = myTeam.homeAway === "home";
    const won = myTeam.winner === true;

    ptsScored.push(myScore);
    ptsAllowed.push(oppScore);
    totals.push(myScore + oppScore);
    streak.push(won ? "W" : "L");

    if (won) {
      wins++;
      if (isHome) homeWins++; else awayWins++;
    } else {
      losses++;
      if (isHome) homeLosses++; else awayLosses++;
    }

    // Compute ATS from odds if available (pickcenter)
    const odds = comp.odds?.[0];
    if (odds) {
      const spread = odds.spread; // positive = home team is underdog
      if (spread != null && myScore !== oppScore) {
        // spread is from home team perspective (negative = home favored)
        const homeFavoredBy = -spread; // if spread=3.5 then away is favored by 3.5
        // margin from home team perspective
        const homeMargin = myScore - oppScore; // if isHome
        const margin = isHome ? (myScore - oppScore) : (oppScore - myScore);
        // pick was: if my team is favorite, did they cover?
        const myTeamSpread = isHome ? -spread : spread;
        const covered = margin + myTeamSpread > 0;
        const push = margin + myTeamSpread === 0;
        if (push) {
          atsPushes++;
        } else if (covered) {
          atsWins++;
          if (isHome) homeAtsWins++; else roadAtsWins++;
        } else {
          atsLosses++;
          if (isHome) homeAtsLosses++; else roadAtsLosses++;
        }
      }
    }
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  // Current streak
  let streakCount = 1;
  for (let i = streak.length - 2; i >= 0; i--) {
    if (streak[i] === streak[streak.length - 1]) streakCount++;
    else break;
  }

  return {
    overall: `${wins}-${losses}`,
    home: `${homeWins}-${homeLosses}`,
    away: `${awayWins}-${awayLosses}`,
    wins, losses,
    homeWins, homeLosses,
    awayWins, awayLosses,
    avgPointsFor: parseFloat(avg(ptsScored).toFixed(1)),
    avgPointsAgainst: parseFloat(avg(ptsAllowed).toFixed(1)),
    avgMargin: parseFloat((avg(ptsScored) - avg(ptsAllowed)).toFixed(1)),
    last5: streak.slice(-5),
    last10: streak.slice(-10),
    currentStreak: `${streak[streak.length - 1]}${streakCount}`,
    atsWins, atsLosses, atsPushes,
    roadAtsWins, roadAtsLosses,
    homeAtsWins, homeAtsLosses,
    avgTotalPoints: parseFloat(avg(totals).toFixed(1)),
  };
}

// ── Injuries ──────────────────────────────────────────────────────────────

export interface InjuryReport {
  teamName: string;
  injuries: { playerName: string; status: string; position: string }[];
}

export async function getGameInjuries(
  eventId: string,
  sport: string,
  league: string
): Promise<InjuryReport[]> {
  const data = await fetchJson(
    `${ESPN_BASE}/${sport}/${league}/summary?event=${eventId}`
  );
  if (!data) return [];

  const injuries: InjuryReport[] = [];
  for (const teamInj of data.injuries ?? []) {
    const teamName = teamInj.team?.displayName ?? "Unknown";
    const items = (teamInj.injuries ?? []).map((inj: any) => ({
      playerName: inj.athlete?.displayName ?? "Unknown",
      status: inj.status ?? "Unknown",
      position: inj.athlete?.position?.abbreviation ?? "",
    }));
    if (items.length > 0) {
      injuries.push({ teamName, injuries: items });
    }
  }
  return injuries;
}

// ── Team scoring leaders ──────────────────────────────────────────────────

export interface TeamLeader {
  playerName: string;
  stat: string;
  value: number;
  displayValue: string;
}

export interface TeamLeaders {
  points: TeamLeader | null;
  assists: TeamLeader | null;
  rebounds: TeamLeader | null;
  savePct?: TeamLeader | null;   // NHL
  goals?: TeamLeader | null;     // NHL
}

export async function getGameLeaders(
  eventId: string,
  sport: string,
  league: string
): Promise<Record<string, TeamLeaders>> {
  const data = await fetchJson(
    `${ESPN_BASE}/${sport}/${league}/summary?event=${eventId}`
  );
  if (!data) return {};

  const result: Record<string, TeamLeaders> = {};

  for (const teamLeaders of data.leaders ?? []) {
    const teamName = teamLeaders.team?.displayName ?? "Unknown";
    const cats = teamLeaders.leaders ?? [];

    const findLeader = (catName: string): TeamLeader | null => {
      const cat = cats.find((c: any) =>
        c.name?.toLowerCase().includes(catName) ||
        c.displayName?.toLowerCase().includes(catName)
      );
      if (!cat) return null;
      const top = cat.leaders?.[0];
      if (!top) return null;
      return {
        playerName: top.athlete?.displayName ?? "Unknown",
        stat: cat.displayName ?? catName,
        value: parseFloat(top.value ?? "0"),
        displayValue: top.displayValue ?? "",
      };
    };

    result[teamName] = {
      points: findLeader("point") ?? findLeader("scoring"),
      assists: findLeader("assist"),
      rebounds: findLeader("rebound"),
      savePct: findLeader("save"),
      goals: findLeader("goal"),
    };
  }
  return result;
}

// ── Win probability (ESPN Matchup Predictor) ──────────────────────────────

export interface WinProbability {
  homeTeamWinPct: number;
  awayTeamWinPct: number;
}

export async function getWinProbability(
  eventId: string,
  sport: string,
  league: string
): Promise<WinProbability | null> {
  const data = await fetchJson(
    `${ESPN_BASE}/${sport}/${league}/summary?event=${eventId}`
  );
  if (!data?.predictor) return null;

  const pred = data.predictor;
  return {
    homeTeamWinPct: parseFloat(pred.homeTeam?.gameProjection ?? "50") / 100,
    awayTeamWinPct: parseFloat(pred.awayTeam?.gameProjection ?? "50") / 100,
  };
}

// ── Line movement (open vs close from scoreboard) ────────────────────────

export interface LineMovement {
  spreadOpen: string | null;
  spreadClose: string | null;
  mlHomeOpen: string | null;
  mlHomeClose: string | null;
  mlAwayOpen: string | null;
  mlAwayClose: string | null;
  totalOpen: string | null;
  totalClose: string | null;
  overUnder: number | null;
}

export async function getTodaysGamesWithMovement(
  sport: string,
  league: string
): Promise<Map<string, { homeTeam: string; awayTeam: string; espnEventId: string; lineMovement: LineMovement; homeRecord: string; awayRecord: string }>> {
  const data = await fetchJson(`${ESPN_BASE}/${sport}/${league}/scoreboard`);
  const result = new Map<string, any>();
  if (!data) return result;

  for (const event of data.events ?? []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const competitors: any[] = comp.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === "home");
    const away = competitors.find((c: any) => c.homeAway === "away");
    if (!home || !away) continue;

    const homeTeam = home.team?.displayName ?? "";
    const awayTeam = away.team?.displayName ?? "";

    // Records
    const homeRec = home.records?.find((r: any) => r.type === "total")?.summary ?? "";
    const awayRec = away.records?.find((r: any) => r.type === "total")?.summary ?? "";

    // Odds / line movement
    const odds = comp.odds?.[0];
    let lm: LineMovement = {
      spreadOpen: null, spreadClose: null,
      mlHomeOpen: null, mlHomeClose: null,
      mlAwayOpen: null, mlAwayClose: null,
      totalOpen: null, totalClose: null,
      overUnder: null,
    };

    if (odds) {
      const ps = odds.pointSpread;
      const ml = odds.moneyline;
      const tot = odds.total;

      lm = {
        spreadOpen: ps?.away?.open?.line ?? null,
        spreadClose: ps?.away?.close?.line ?? null,
        mlHomeOpen: ml?.home?.open?.odds ?? null,
        mlHomeClose: ml?.home?.close?.odds ?? null,
        mlAwayOpen: ml?.away?.open?.odds ?? null,
        mlAwayClose: ml?.away?.close?.odds ?? null,
        totalOpen: tot?.over?.open?.line ?? null,
        totalClose: tot?.over?.close?.line ?? null,
        overUnder: odds.overUnder ?? null,
      };
    }

    // Key by "awayTeamName|homeTeamName" for matching with Odds API data
    const key = `${awayTeam.toLowerCase()}|${homeTeam.toLowerCase()}`;
    result.set(key, {
      homeTeam,
      awayTeam,
      espnEventId: event.id,
      lineMovement: lm,
      homeRecord: homeRec,
      awayRecord: awayRec,
    });
  }

  return result;
}

// ── Compute H2H from both teams' schedules ────────────────────────────────

export interface H2HRecord {
  team1Wins: number;
  team2Wins: number;
  avgTotal: number;
  last5Results: string[]; // "CLE 115-101 ORL" etc
}

export async function getH2H(
  team1Id: string,
  team2Id: string,
  sport: string,
  league: string,
  season: number
): Promise<H2HRecord | null> {
  const data = await fetchJson(
    `${ESPN_BASE}/${sport}/${league}/teams/${team1Id}/schedule?season=${season}`
  );
  if (!data) return null;

  const events = data.events ?? [];
  const completed = events.filter(
    (e: any) => e.competitions?.[0]?.status?.type?.completed === true
  );

  const h2hGames: any[] = [];
  for (const e of completed) {
    const comp = e.competitions[0];
    const opponents = comp.competitors ?? [];
    const hasTeam2 = opponents.some((c: any) => c.team?.id === team2Id);
    if (hasTeam2) h2hGames.push(e);
  }

  if (h2hGames.length === 0) return null;

  let team1Wins = 0, team2Wins = 0;
  const totals: number[] = [];
  const results: string[] = [];

  for (const e of h2hGames) {
    const comp = e.competitions[0];
    const t1 = comp.competitors.find((c: any) => c.team?.id === team1Id);
    const t2 = comp.competitors.find((c: any) => c.team?.id === team2Id);
    if (!t1 || !t2) continue;

    const s1 = parseFloat(t1.score?.displayValue ?? "0");
    const s2 = parseFloat(t2.score?.displayValue ?? "0");
    totals.push(s1 + s2);

    if (t1.winner) {
      team1Wins++;
      results.push(`${t1.team.abbreviation} ${s1}-${s2} ${t2.team.abbreviation}`);
    } else {
      team2Wins++;
      results.push(`${t2.team.abbreviation} ${s2}-${s1} ${t1.team.abbreviation}`);
    }
  }

  return {
    team1Wins,
    team2Wins,
    avgTotal: totals.length ? parseFloat((totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(1)) : 0,
    last5Results: results.slice(-5),
  };
}

// ── Full game context (single call that enriches a matchup) ───────────────

export interface GameContext {
  homeTeamName: string;
  awayTeamName: string;
  espnEventId: string;
  homeRecord: TeamRecord | null;
  awayRecord: TeamRecord | null;
  homeLeaders: TeamLeaders | null;
  awayLeaders: TeamLeaders | null;
  homeInjuries: { playerName: string; status: string; position: string }[];
  awayInjuries: { playerName: string; status: string; position: string }[];
  h2h: H2HRecord | null;
  lineMovement: LineMovement | null;
  winProbability: WinProbability | null;
  homeRecordStr: string;
  awayRecordStr: string;
}

export async function enrichGameContext(
  homeTeam: string,
  awayTeam: string,
  oddsApiSport: string,
  todaysGames: Map<string, any>
): Promise<GameContext | null> {
  const cfg = getEspnConfig(oddsApiSport);
  if (!cfg) return null;

  const { espnSport, espnLeague, season } = cfg;

  // Find this game in ESPN scoreboard
  const key = `${awayTeam.toLowerCase()}|${homeTeam.toLowerCase()}`;
  // Try flexible matching
  let gameInfo: any = null;
  for (const [k, v] of todaysGames.entries()) {
    const [away, home] = k.split("|");
    if (
      homeTeam.toLowerCase().includes(home) ||
      home.includes(homeTeam.toLowerCase().split(" ").pop()!) ||
      awayTeam.toLowerCase().includes(away) ||
      away.includes(awayTeam.toLowerCase().split(" ").pop()!)
    ) {
      gameInfo = v;
      break;
    }
  }
  if (!gameInfo) {
    // exact key fallback
    gameInfo = todaysGames.get(key);
  }

  // Get team IDs
  const idMap = await getTeamIdMap(espnSport, espnLeague);
  const homeId = findTeamId(homeTeam, idMap);
  const awayId = findTeamId(awayTeam, idMap);

  // Fetch in parallel
  const [homeRecord, awayRecord, h2h, injuries, leaders, winProb] = await Promise.all([
    homeId ? getTeamRecord(homeId, espnSport, espnLeague, season) : Promise.resolve(null),
    awayId ? getTeamRecord(awayId, espnSport, espnLeague, season) : Promise.resolve(null),
    homeId && awayId ? getH2H(homeId, awayId, espnSport, espnLeague, season) : Promise.resolve(null),
    gameInfo?.espnEventId ? getGameInjuries(gameInfo.espnEventId, espnSport, espnLeague) : Promise.resolve([]),
    gameInfo?.espnEventId ? getGameLeaders(gameInfo.espnEventId, espnSport, espnLeague) : Promise.resolve({}),
    gameInfo?.espnEventId ? getWinProbability(gameInfo.espnEventId, espnSport, espnLeague) : Promise.resolve(null),
  ]);

  const homeInj = injuries.find((i: InjuryReport) => i.teamName === (gameInfo?.homeTeam ?? homeTeam))?.injuries ?? [];
  const awayInj = injuries.find((i: InjuryReport) => i.teamName === (gameInfo?.awayTeam ?? awayTeam))?.injuries ?? [];

  return {
    homeTeamName: gameInfo?.homeTeam ?? homeTeam,
    awayTeamName: gameInfo?.awayTeam ?? awayTeam,
    espnEventId: gameInfo?.espnEventId ?? "",
    homeRecord,
    awayRecord,
    homeLeaders: leaders[gameInfo?.homeTeam ?? homeTeam] ?? null,
    awayLeaders: leaders[gameInfo?.awayTeam ?? awayTeam] ?? null,
    homeInjuries: homeInj,
    awayInjuries: awayInj,
    h2h,
    lineMovement: gameInfo?.lineMovement ?? null,
    winProbability: winProb,
    homeRecordStr: gameInfo?.homeRecord ?? homeRecord?.overall ?? "",
    awayRecordStr: gameInfo?.awayRecord ?? awayRecord?.overall ?? "",
  };
}
