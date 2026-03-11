import https from "https";
import {
  getEspnConfig,
  getTodaysGamesWithMovement,
  enrichGameContext,
  type GameContext,
  type TeamRecord,
  type LineMovement,
} from "./espnService";

const BASE_URL = "https://api.the-odds-api.com/v4";

export interface OddsGame {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Bookmaker[];
}

export interface Bookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: Market[];
}

export interface Market {
  key: string;
  last_update: string;
  outcomes: Outcome[];
}

export interface Outcome {
  name: string;
  price: number;
  point?: number;
}

async function fetchJson(url: string): Promise<{ data: any; remainingCredits: string | null }> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve({
            data,
            remainingCredits: res.headers["x-requests-remaining"] as string | null,
          });
        } catch (e) {
          reject(new Error("Failed to parse response: " + body));
        }
      });
    }).on("error", reject);
  });
}

export async function getSports(apiKey: string): Promise<{ key: string; title: string; active: boolean }[]> {
  const { data } = await fetchJson(`${BASE_URL}/sports?apiKey=${apiKey}&all=false`);
  return data;
}

export async function getOdds(
  apiKey: string,
  sportKey: string,
  regions = "us",
  markets = "h2h,spreads,totals",
  oddsFormat = "american"
): Promise<{ games: OddsGame[]; remainingCredits: string | null }> {
  const url = `${BASE_URL}/sports/${sportKey}/odds?apiKey=${apiKey}&regions=${regions}&markets=${markets}&oddsFormat=${oddsFormat}`;
  const { data, remainingCredits } = await fetchJson(url);
  return { games: Array.isArray(data) ? data : [], remainingCredits };
}

export async function getLiveScores(apiKey: string, sportKey: string): Promise<any[]> {
  const url = `${BASE_URL}/sports/${sportKey}/scores?apiKey=${apiKey}&daysFrom=1`;
  const { data } = await fetchJson(url);
  return Array.isArray(data) ? data : [];
}

export function americanOddsToImpliedProb(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function impliedProbToAmerican(prob: number): number {
  if (prob <= 0 || prob >= 1) return 0;
  if (prob >= 0.5) return -Math.round((prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

function devig(odds1: number, odds2: number): { fair1: number; fair2: number; vig: number } {
  const p1 = americanOddsToImpliedProb(odds1);
  const p2 = americanOddsToImpliedProb(odds2);
  const total = p1 + p2;
  return { fair1: p1 / total, fair2: p2 / total, vig: total - 1 };
}

function bestOddsFor(bookmakers: Bookmaker[], marketKey: string, sideName: string): { odds: number; book: string } | null {
  let best: { odds: number; book: string } | null = null;
  for (const bk of bookmakers) {
    const market = bk.markets.find((m) => m.key === marketKey);
    if (!market) continue;
    const outcome = market.outcomes.find((o) => o.name === sideName);
    if (!outcome) continue;
    if (!best || outcome.price > best.odds) best = { odds: outcome.price, book: bk.title };
  }
  return best;
}

function aggregateOdds(bookmakers: Bookmaker[], marketKey: string, sideName: string): number[] {
  const odds: number[] = [];
  for (const bk of bookmakers) {
    const market = bk.markets.find((m) => m.key === marketKey);
    if (!market) continue;
    const outcome = market.outcomes.find((o) => o.name === sideName);
    if (outcome) odds.push(outcome.price);
  }
  return odds;
}

function consensusSpreadPoint(bookmakers: Bookmaker[], teamName: string): { point: number; odds: number[] } | null {
  const entries: { point: number; odds: number }[] = [];
  for (const bk of bookmakers) {
    const market = bk.markets.find((m) => m.key === "spreads");
    if (!market) continue;
    const outcome = market.outcomes.find((o) => o.name === teamName);
    if (outcome && outcome.point !== undefined) entries.push({ point: outcome.point, odds: outcome.price });
  }
  if (entries.length === 0) return null;
  const pointCounts: Record<number, { count: number; odds: number[] }> = {};
  for (const e of entries) {
    if (!pointCounts[e.point]) pointCounts[e.point] = { count: 0, odds: [] };
    pointCounts[e.point].count++;
    pointCounts[e.point].odds.push(e.odds);
  }
  const sorted = Object.entries(pointCounts).sort((a, b) => b[1].count - a[1].count);
  const best = sorted[0];
  return { point: parseFloat(best[0]), odds: best[1].odds };
}

function consensusTotal(bookmakers: Bookmaker[]): { line: number; overOdds: number[]; underOdds: number[] } | null {
  const overs: { line: number; odds: number }[] = [];
  const unders: { line: number; odds: number }[] = [];
  for (const bk of bookmakers) {
    const market = bk.markets.find((m) => m.key === "totals");
    if (!market) continue;
    const over = market.outcomes.find((o) => o.name === "Over");
    const under = market.outcomes.find((o) => o.name === "Under");
    if (over?.point !== undefined) overs.push({ line: over.point, odds: over.price });
    if (under?.point !== undefined) unders.push({ line: under.point, odds: under.price });
  }
  if (overs.length === 0) return null;
  const lineCounts: Record<number, number> = {};
  for (const o of overs) lineCounts[o.line] = (lineCounts[o.line] || 0) + 1;
  const consensusLine = parseFloat(Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0][0]);
  return {
    line: consensusLine,
    overOdds: overs.filter((o) => o.line === consensusLine).map((o) => o.odds),
    underOdds: unders.filter((u) => u.line === consensusLine).map((u) => u.odds),
  };
}

function assignUnits(confidence: number): number {
  if (confidence >= 82) return 3;
  if (confidence >= 75) return 2;
  if (confidence >= 68) return 1.5;
  if (confidence >= 60) return 1;
  return 0.5;
}

// ── Real trend generation from ESPN data ──────────────────────────────────

function buildRealTrends(
  type: "moneyline" | "spread" | "total",
  side: string,
  game: OddsGame,
  ctx: GameContext | null,
  data: {
    edge: number;
    vig: number;
    bookCount: number;
    odds: number;
    point?: number;
    totalLine?: number;
    fairProb?: number;
    impliedProb?: number;
  }
): string[] {
  const trends: string[] = [];
  const isHome = side === game.home_team;
  const myRecord: TeamRecord | null = isHome ? ctx?.homeRecord ?? null : ctx?.awayRecord ?? null;
  const oppRecord: TeamRecord | null = isHome ? ctx?.awayRecord ?? null : ctx?.homeRecord ?? null;
  const lm = ctx?.lineMovement ?? null;

  // ── Line movement trend (always real) ─────────────────────
  if (lm) {
    if (type === "spread" && lm.spreadOpen && lm.spreadClose && lm.spreadOpen !== lm.spreadClose) {
      trends.push(`Line moved from ${lm.spreadOpen} open → ${lm.spreadClose} close (${parseFloat(lm.spreadClose) < parseFloat(lm.spreadOpen) ? "sharp money on favorite" : "sharp money on dog"})`);
    } else if (type === "moneyline") {
      const openOdds = isHome ? lm.mlHomeOpen : lm.mlAwayOpen;
      const closeOdds = isHome ? lm.mlHomeClose : lm.mlAwayClose;
      if (openOdds && closeOdds && openOdds !== closeOdds) {
        const moved = parseFloat(closeOdds) - parseFloat(openOdds);
        const dir = moved < 0 ? "steam toward this side" : "steam away from this side";
        trends.push(`ML moved from ${openOdds} open → ${closeOdds} close (${dir})`);
      }
    } else if (type === "total" && lm.totalOpen && lm.totalClose && lm.totalOpen !== lm.totalClose) {
      const diff = parseFloat(lm.totalClose.replace("o","").replace("u","")) - parseFloat(lm.totalOpen.replace("o","").replace("u",""));
      trends.push(`Total moved from ${lm.totalOpen.replace("o","").replace("u","")} open → ${lm.totalClose.replace("o","").replace("u","")} close (${diff > 0 ? "sharp over action" : "sharp under action"})`);
    }
  }

  // ── Win/Loss record trends (real) ─────────────────────────
  if (myRecord) {
    if (type === "spread" || type === "moneyline") {
      // Overall record
      trends.push(`${side} season record: ${myRecord.overall} (${isHome ? "Home" : "Away"}: ${isHome ? myRecord.home : myRecord.away})`);
      // Recent form
      const l5Wins = myRecord.last5.filter((x) => x === "W").length;
      trends.push(`Recent form: ${myRecord.last5.join("-")} (${l5Wins}/5 wins), current streak: ${myRecord.currentStreak}`);
      // Scoring
      trends.push(`Scoring avg: ${myRecord.avgPointsFor} PPG scored, ${myRecord.avgPointsAgainst} PPG allowed (${myRecord.avgMargin > 0 ? "+" : ""}${myRecord.avgMargin} avg margin)`);
    }

    if (type === "total") {
      // Scoring trends are relevant for totals
      if (myRecord && oppRecord) {
        const combinedAvg = (myRecord.avgPointsFor + oppRecord.avgPointsFor) / 2 + (myRecord.avgPointsAgainst + oppRecord.avgPointsAgainst) / 2;
        trends.push(`Combined scoring avg suggests ~${combinedAvg.toFixed(1)} total pts (${side === "Over" ? "supports Over" : "supports Under"} ${data.totalLine})`);
      }
    }
  }

  // ── H2H trend (real) ──────────────────────────────────────
  if (ctx?.h2h && ctx.h2h.last5Results.length > 0) {
    const h2h = ctx.h2h;
    const myName = side.split(" ").pop() ?? side;
    const mySideWins = isHome ? h2h.team1Wins : h2h.team2Wins;
    const totalH2H = h2h.team1Wins + h2h.team2Wins;
    if (type === "total") {
      trends.push(`H2H avg total: ${h2h.avgTotal} pts (${h2h.avgTotal > (data.totalLine ?? 0) ? "Over" : "Under"} the current ${data.totalLine} line)`);
    } else {
      if (totalH2H > 0) {
        trends.push(`H2H this season: ${mySideWins}-${totalH2H - mySideWins} for ${side.split(" ").slice(-1)[0]} — recent: ${h2h.last5Results.slice(-3).join(", ")}`);
      }
    }
  }

  // ── Injury trends (real) ──────────────────────────────────
  if (type !== "total") {
    const myInjuries = isHome ? ctx?.homeInjuries ?? [] : ctx?.awayInjuries ?? [];
    const oppInjuries = isHome ? ctx?.awayInjuries ?? [] : ctx?.homeInjuries ?? [];
    const myOut = myInjuries.filter((i) => i.status === "Out" || i.status === "Doubtful");
    const oppOut = oppInjuries.filter((i) => i.status === "Out" || i.status === "Doubtful");

    if (oppOut.length > 0 && trends.length < 4) {
      const key = oppOut.slice(0, 2).map((i) => `${i.playerName} (${i.position})`).join(", ");
      trends.push(`Opponent missing key players: ${key} — Out/Doubtful`);
    } else if (myOut.length === 0 && oppOut.length === 0 && trends.length < 4) {
      trends.push(`No significant injuries reported for either team`);
    }
  }

  // ── Scoring leaders (real) ────────────────────────────────
  if (type !== "total" && trends.length < 4) {
    const myLeaders = isHome ? ctx?.homeLeaders : ctx?.awayLeaders;
    if (myLeaders?.points) {
      trends.push(`${side.split(" ").pop()} scoring leader: ${myLeaders.points.playerName} (${myLeaders.points.displayValue} PPG)`);
    }
  }

  // ── Model edge (always real) ───────────────────────────────
  if (trends.length < 4) {
    const edgePct = (data.edge * 100).toFixed(1);
    const fairOdds = data.fairProb ? impliedProbToAmerican(data.fairProb) : null;
    trends.push(`Model no-vig edge: +${edgePct}% over implied (fair odds ${fairOdds !== null ? (fairOdds > 0 ? "+" : "") + fairOdds : "N/A"} vs posted ${data.odds > 0 ? "+" : ""}${data.odds})`);
  }

  return trends.slice(0, 4);
}

function buildRealReasoning(
  type: "moneyline" | "spread" | "total",
  side: string,
  game: OddsGame,
  ctx: GameContext | null,
  data: {
    edge: number;
    vig: number;
    bookCount: number;
    odds: number;
    point?: number;
    totalLine?: number;
    fairProb?: number;
    impliedProb?: number;
    bestBook?: string;
  }
): string {
  const isHome = side === game.home_team;
  const myRecord = isHome ? ctx?.homeRecord : ctx?.awayRecord;
  const oppRecord = isHome ? ctx?.awayRecord : ctx?.homeRecord;
  const myInjuries = (isHome ? ctx?.homeInjuries : ctx?.awayInjuries) ?? [];
  const oppInjuries = (isHome ? ctx?.awayInjuries : ctx?.homeInjuries) ?? [];
  const myLeaders = isHome ? ctx?.homeLeaders : ctx?.awayLeaders;
  const lm = ctx?.lineMovement;
  const h2h = ctx?.h2h;
  const winProb = ctx?.winProbability;

  const edgePct = (data.edge * 100).toFixed(1);
  const fairOdds = data.fairProb ? impliedProbToAmerican(data.fairProb) : null;
  const fairPct = ((data.fairProb ?? 0) * 100).toFixed(1);
  const impliedPct = ((data.impliedProb ?? 0) * 100).toFixed(1);
  const vigPct = (data.vig * 100).toFixed(1);

  const parts: string[] = [];

  // Record context
  if (myRecord) {
    const recStr = `${side} is ${myRecord.overall} overall (${isHome ? "Home" : "Road"}: ${isHome ? myRecord.home : myRecord.away})`;
    const formStr = `Last 5: ${myRecord.last5.join("")}, current streak: ${myRecord.currentStreak}`;
    parts.push(`${recStr}. ${formStr}.`);
  }

  // Scoring / opponent record
  if (myRecord && oppRecord) {
    parts.push(`${side} averages ${myRecord.avgPointsFor} PPG (${myRecord.avgPointsAgainst} allowed, ${myRecord.avgMargin > 0 ? "+" : ""}${myRecord.avgMargin} margin). Opponent is ${oppRecord.overall}, averaging ${oppRecord.avgPointsFor} PPG.`);
  }

  // Win probability from ESPN predictor
  if (winProb) {
    const myWinPct = isHome ? winProb.homeTeamWinPct : winProb.awayTeamWinPct;
    parts.push(`ESPN Matchup Predictor gives ${side} a ${(myWinPct * 100).toFixed(1)}% win probability.`);
  }

  // Line movement
  if (lm) {
    if (type === "spread" && lm.spreadOpen && lm.spreadClose && lm.spreadOpen !== lm.spreadClose) {
      parts.push(`Spread moved from ${lm.spreadOpen} open to ${lm.spreadClose} close — sharp line movement indicator.`);
    } else if (type === "moneyline") {
      const openOdds = isHome ? lm.mlHomeOpen : lm.mlAwayOpen;
      const closeOdds = isHome ? lm.mlHomeClose : lm.mlAwayClose;
      if (openOdds && closeOdds && openOdds !== closeOdds) {
        parts.push(`ML moved from ${openOdds} open to ${closeOdds} close.`);
      }
    } else if (type === "total" && lm.totalOpen && lm.totalClose) {
      parts.push(`Total moved from ${lm.totalOpen.replace(/[ou]/gi,"")} open to ${lm.totalClose.replace(/[ou]/gi,"")} close.`);
    }
  }

  // Injuries
  const oppOut = oppInjuries.filter((i) => i.status === "Out" || i.status === "Doubtful");
  if (oppOut.length > 0 && type !== "total") {
    parts.push(`Key opponent injuries: ${oppOut.slice(0,3).map(i => `${i.playerName} (${i.status})`).join(", ")}.`);
  }

  // Scoring leaders
  if (myLeaders?.points && type !== "total") {
    parts.push(`${side.split(" ").pop()}'s top scorer: ${myLeaders.points.playerName} at ${myLeaders.points.displayValue} PPG.`);
  }

  // H2H
  if (h2h && h2h.last5Results.length > 0) {
    if (type === "total") {
      parts.push(`H2H avg total this season: ${h2h.avgTotal} pts — ${h2h.avgTotal > (data.totalLine ?? 0) ? "above" : "below"} the current ${data.totalLine} line.`);
    } else {
      parts.push(`Season series: ${h2h.last5Results.slice(-3).join(" | ")}.`);
    }
  }

  // Model edge
  parts.push(`No-vig model: fair probability ${fairPct}% vs market implied ${impliedPct}% — +${edgePct}% edge. Market vig: ${vigPct}%. Best price: ${data.odds > 0 ? "+" : ""}${data.odds} at ${data.bestBook ?? "DraftKings"} (${data.bookCount} books analyzed).`);

  return parts.join(" ");
}

// ── Main analysis engine (async — enriches with ESPN data) ───────────────

export async function analyzePicksWithEspn(
  games: OddsGame[],
  sport: string
): Promise<AnalyzedPick[]> {
  const results: AnalyzedPick[] = [];
  const seen = new Set<string>();

  // Fetch today's ESPN game data (line movement + records) in one call per sport
  const cfg = getEspnConfig(sport);
  let todaysGames = new Map<string, any>();
  if (cfg) {
    try {
      todaysGames = await getTodaysGamesWithMovement(cfg.espnSport, cfg.espnLeague);
    } catch {
      // ESPN fetch failed — continue without enrichment
    }
  }

  for (const game of games) {
    const { bookmakers, home_team, away_team } = game;
    if (!bookmakers || bookmakers.length === 0) continue;

    const bookCount = bookmakers.length;

    // Enrich with ESPN context (parallel per game)
    let ctx: GameContext | null = null;
    try {
      ctx = await enrichGameContext(home_team, away_team, sport, todaysGames);
    } catch {
      ctx = null;
    }

    // ── MONEYLINES ────────────────────────────────────────────
    const teams = [home_team, away_team];
    for (const team of teams) {
      const opponent = team === home_team ? away_team : home_team;
      const teamOdds = aggregateOdds(bookmakers, "h2h", team);
      const oppOdds = aggregateOdds(bookmakers, "h2h", opponent);
      if (teamOdds.length < 2 || oppOdds.length < 2) continue;

      const avgTeam = teamOdds.reduce((a, b) => a + b, 0) / teamOdds.length;
      const avgOpp = oppOdds.reduce((a, b) => a + b, 0) / oppOdds.length;
      const { fair1: fairTeam, vig } = devig(avgTeam, avgOpp);
      const impliedTeam = americanOddsToImpliedProb(avgTeam);
      const edge = fairTeam - impliedTeam;

      if (edge < 0.015) continue;

      const bestOdds = bestOddsFor(bookmakers, "h2h", team);
      if (!bestOdds) continue;

      const key = `${game.id}-h2h-${team}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Boost confidence if ESPN win prob aligns
      let espnBoost = 0;
      if (ctx?.winProbability) {
        const isHome = team === home_team;
        const espnWinPct = isHome ? ctx.winProbability.homeTeamWinPct : ctx.winProbability.awayTeamWinPct;
        if (espnWinPct > fairTeam + 0.03) espnBoost = 4; // ESPN predictor agrees + more
        else if (espnWinPct > fairTeam) espnBoost = 2;
      }

      const confidence = Math.min(92, Math.max(52, Math.round(
        55 + edge * 280 + (bookCount >= 5 ? 4 : 0) + (vig < 0.04 ? 3 : 0) + espnBoost
      )));
      const units = assignUnits(confidence);
      const tData = { edge, vig, bookCount, odds: bestOdds.odds, fairProb: fairTeam, impliedProb: impliedTeam, bestBook: bestOdds.book };

      results.push({
        sport, league: game.sport_title,
        homeTeam: home_team, awayTeam: away_team,
        commenceTime: game.commence_time,
        betType: "moneyline", betSide: team,
        odds: bestOdds.odds, spread: null, totalLine: null,
        bookmaker: bestOdds.book, units, confidence,
        reasoning: buildRealReasoning("moneyline", team, game, ctx, tData),
        trends: buildRealTrends("moneyline", team, game, ctx, tData),
        isLive: false, eventId: game.id,
      });
    }

    // ── SPREADS ───────────────────────────────────────────────
    for (const team of teams) {
      const opponent = team === home_team ? away_team : home_team;
      const spreadData = consensusSpreadPoint(bookmakers, team);
      if (!spreadData || spreadData.odds.length < 2) continue;

      const avgOdds = spreadData.odds.reduce((a, b) => a + b, 0) / spreadData.odds.length;
      const oppSpreadData = consensusSpreadPoint(bookmakers, opponent);
      const avgOppOdds = oppSpreadData
        ? oppSpreadData.odds.reduce((a, b) => a + b, 0) / oppSpreadData.odds.length
        : -avgOdds;

      const { fair1: fairTeam, vig } = devig(avgOdds, avgOppOdds);
      const impliedTeam = americanOddsToImpliedProb(avgOdds);
      const edge = fairTeam - impliedTeam;

      const hasValue = (vig < 0.045 && avgOdds >= -120) || edge > 0.01;
      if (!hasValue) continue;

      const bestOdds = bestOddsFor(bookmakers, "spreads", team);
      if (!bestOdds) continue;

      const key = `${game.id}-spread-${team}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const confidence = Math.min(90, Math.max(52, Math.round(
        55 + edge * 200
        + (vig < 0.04 ? 5 : vig < 0.045 ? 3 : 0)
        + (bookCount >= 5 ? 4 : bookCount >= 3 ? 2 : 0)
        + (Math.abs(avgOdds) <= 112 ? 3 : 0)
      )));
      const units = assignUnits(confidence);
      const tData = { edge, vig, bookCount, odds: bestOdds.odds, point: spreadData.point, fairProb: fairTeam, impliedProb: impliedTeam, bestBook: bestOdds.book };

      results.push({
        sport, league: game.sport_title,
        homeTeam: home_team, awayTeam: away_team,
        commenceTime: game.commence_time,
        betType: "spread", betSide: team,
        odds: bestOdds.odds, spread: spreadData.point, totalLine: null,
        bookmaker: bestOdds.book, units, confidence,
        reasoning: buildRealReasoning("spread", team, game, ctx, tData),
        trends: buildRealTrends("spread", team, game, ctx, tData),
        isLive: false, eventId: game.id,
      });
    }

    // ── TOTALS ────────────────────────────────────────────────
    const totalData = consensusTotal(bookmakers);
    if (totalData && totalData.overOdds.length >= 2 && totalData.underOdds.length >= 2) {
      const avgOver = totalData.overOdds.reduce((a, b) => a + b, 0) / totalData.overOdds.length;
      const avgUnder = totalData.underOdds.reduce((a, b) => a + b, 0) / totalData.underOdds.length;
      const { fair1: fairOver, fair2: fairUnder, vig } = devig(avgOver, avgUnder);
      const impliedOver = americanOddsToImpliedProb(avgOver);
      const impliedUnder = americanOddsToImpliedProb(avgUnder);
      const overEdge = fairOver - impliedOver;
      const underEdge = fairUnder - impliedUnder;

      const pickSide = overEdge >= underEdge ? "Over" : "Under";
      const pickEdge = pickSide === "Over" ? overEdge : underEdge;
      const pickFairProb = pickSide === "Over" ? fairOver : fairUnder;
      const pickImpliedProb = pickSide === "Over" ? impliedOver : impliedUnder;

      if (pickEdge < 0.005 && vig >= 0.05) continue;

      const bestOdds = bestOddsFor(bookmakers, "totals", pickSide);
      if (!bestOdds) continue;

      const key = `${game.id}-total`;
      if (seen.has(key)) continue;
      seen.add(key);

      // ESPN H2H avg total can boost/reduce confidence on totals
      let espnTotalBoost = 0;
      if (ctx?.h2h?.avgTotal) {
        const h2hTotal = ctx.h2h.avgTotal;
        if (pickSide === "Under" && h2hTotal < totalData.line - 3) espnTotalBoost = 5;
        else if (pickSide === "Over" && h2hTotal > totalData.line + 3) espnTotalBoost = 5;
        else if (pickSide === "Under" && h2hTotal < totalData.line) espnTotalBoost = 2;
        else if (pickSide === "Over" && h2hTotal > totalData.line) espnTotalBoost = 2;
      }

      const confidence = Math.min(90, Math.max(52, Math.round(
        52 + pickEdge * 250
        + (vig < 0.03 ? 8 : vig < 0.04 ? 5 : vig < 0.05 ? 2 : 0)
        + (bookCount >= 5 ? 3 : 0)
        + espnTotalBoost
      )));
      const units = assignUnits(confidence);
      const tData = { edge: pickEdge, vig, bookCount, odds: bestOdds.odds, totalLine: totalData.line, fairProb: pickFairProb, impliedProb: pickImpliedProb, bestBook: bestOdds.book };

      results.push({
        sport, league: game.sport_title,
        homeTeam: home_team, awayTeam: away_team,
        commenceTime: game.commence_time,
        betType: "total", betSide: pickSide,
        odds: bestOdds.odds, spread: null, totalLine: totalData.line,
        bookmaker: bestOdds.book, units, confidence,
        reasoning: buildRealReasoning("total", pickSide, game, ctx, tData),
        trends: buildRealTrends("total", pickSide, game, ctx, tData),
        isLive: false, eventId: game.id,
      });
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence).slice(0, 20);
}

// Keep sync version for backward compat (used nowhere now but keeps build clean)
export function analyzePicks(games: OddsGame[], sport: string): AnalyzedPick[] {
  return [];
}

export interface AnalyzedPick {
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  betType: string;
  betSide: string;
  odds: number;
  spread: number | null;
  totalLine: number | null;
  bookmaker: string;
  units: number;
  confidence: number;
  reasoning: string;
  isLive: boolean;
  eventId: string;
  trends?: string[];
}

// Demo picks — shown ONLY when no API key is configured
export function generateDemoPicks(): AnalyzedPick[] {
  const now = new Date();
  const makeTimeET = (hourET: number, min = 0) => {
    const d = new Date(now);
    d.setUTCHours(hourET + 4, min, 0, 0);
    return d.toISOString();
  };
  return [
    {
      sport: "basketball_nba", league: "NBA",
      homeTeam: "Orlando Magic", awayTeam: "Cleveland Cavaliers",
      commenceTime: makeTimeET(19, 30),
      betType: "spread", betSide: "Cleveland Cavaliers",
      odds: -110, spread: -3.5, totalLine: null,
      bookmaker: "DraftKings", units: 2, confidence: 75,
      reasoning: "DEMO MODE — No API key configured. Add your Odds API key in Settings and click Refresh Picks to generate real picks with live lines and ESPN analysis.",
      isLive: false, eventId: "demo-cle-orl",
      trends: [
        "DEMO: Real picks require Odds API key",
        "Add key in Settings → click Refresh Picks",
        "Real picks use ESPN team records, injuries & leaders",
        "Live lines pulled from 20+ bookmakers via The Odds API",
      ],
    },
  ];
}
