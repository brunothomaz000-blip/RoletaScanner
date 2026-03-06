const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { ethers } = require("ethers");

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CHAIN_ID = Number(process.env.CHAIN_ID || 42161);
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS || "").trim();

const DAYS_BACK = Number(process.env.DAYS_BACK || 7); // para 3 meses: DAYS_BACK=90 no .env
const RESUME = Number(process.env.RESUME || 1);

const HIST_CHUNK_BLOCKS = Number(process.env.HIST_CHUNK_BLOCKS || 4000);
const HIST_RETRY_DELAY_MS = Number(process.env.HIST_RETRY_DELAY_MS || 3000);

const RPC_URL = (process.env.RPC_URL || "").trim();
const LIVE_STEP_BLOCKS = Number(process.env.LIVE_STEP_BLOCKS || 2500);
const POLL_MS = Number(process.env.POLL_MS || 2000);
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 20000);

const BLOCKS_PER_DAY = Number(process.env.BLOCKS_PER_DAY || 345600);
const LIVE_MAX_LAG_BLOCKS = Number(process.env.LIVE_MAX_LAG_BLOCKS || 40000000);

const TOP_N = Number(process.env.TOP_N || 25);
const FULL_ADDRESS = String(process.env.FULL_ADDRESS || "1") === "1";

const EVA_DECIMALS = Number(process.env.EVA_DECIMALS || 18);
const EVA_SYMBOL = process.env.EVA_SYMBOL || "EVA";

// =====================
// Files (persist)
// =====================
const STATE_FILE = path.join(process.cwd(), "state.json");
const STATS_FILE = path.join(process.cwd(), "stats.json");

// =====================
// ABI
// =====================
const ROULETTE_EVENTS_ABI = [
  "event SpinStarted(uint256 indexed requestId, address indexed player, uint256 wager, uint256 netStake, uint256 multiplierHundredths, uint256 maxPayout, uint256 jackpotContribution, uint32 configIndex, bool participatingInJackpot)",
  "event SpinResolved(uint256 indexed requestId, address indexed player, uint8 outcome, uint256 payout, uint8 spinsConsumed, uint256 jackpotPayout)",
  "function evaToken() view returns (address)",
];

const ERC20_MIN_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// =====================
// Helpers
// =====================
function die(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function fmtAddr(a) {
  if (!a) return "-";
  if (FULL_ADDRESS) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function fmtMult(hundredths) {
  const n = Number(hundredths);
  const x = n / 100;
  const s = x.toFixed(2).replace(/\.00$/, "").replace(/(\.\d*[1-9])0$/, "$1");
  return s + "x";
}
function fmtUnits(raw, decimals, symbol) {
  try {
    const s = ethers.formatUnits(raw, decimals);
    const [i, d] = s.split(".");
    const pretty = d ? `${i}.${d.slice(0, 6)}`.replace(/\.$/, "") : i;
    return `${pretty} ${symbol}`;
  } catch {
    return `${String(raw)} ${symbol}`;
  }
}
function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonSafe(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function multKeyToNumber(multKey) {
  return safeNum(String(multKey).toLowerCase().replace("x", "").trim(), NaN);
}
function theoreticalWinChance(multKey) {
  const m = multKeyToNumber(multKey);
  if (!Number.isFinite(m) || m <= 0) return null;
  return 1 / m;
}
function expectedLossBeforeWin(multKey) {
  const p = theoreticalWinChance(multKey);
  if (!p || p <= 0) return null;
  return (1 / p) - 1;
}
function varianceScore(multKey, loss) {
  const expLoss = expectedLossBeforeWin(multKey);
  if (!Number.isFinite(expLoss) || expLoss <= 0) return null;
  return loss / expLoss;
}
function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return "-";
  return `${(p * 100).toFixed(2)}%`;
}
function fmtScore(score) {
  if (score == null || !Number.isFinite(score)) return "-";
  return `${score.toFixed(2)}x`;
}
function varianceStatus(score) {
  if (score == null || !Number.isFinite(score)) return "sem base";
  if (score < 0.8) return "abaixo do esperado";
  if (score < 1.2) return "normal";
  if (score < 1.6) return "atrasado";
  if (score < 2.2) return "muito atrasado";
  return "extremo";
}
function normalizeMultInput(query) {
  const raw = String(query || "").trim().toLowerCase().replace(",", ".");
  if (!raw) return "";
  return raw.includes("x") ? raw : raw + "x";
}

// =====================
// Telegram
// =====================
if (!TELEGRAM_BOT_TOKEN) die("Faltou TELEGRAM_BOT_TOKEN no .env");
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function allowedChat(chatId) {
  if (!TELEGRAM_ALLOWED_CHAT_IDS.length) return true;
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId));
}
function send(chatId, text) {
  return bot.sendMessage(chatId, text, { disable_web_page_preview: true }).catch(() => {});
}
bot.on("polling_error", (err) => console.log("⚠️ polling_error:", err?.message || err));

// =====================
// Scanner state
// =====================
const stats = new Map();
const startMap = new Map();

let tokenInfo = { decimals: EVA_DECIMALS, symbol: EVA_SYMBOL, evaAddr: null };

const runtime = {
  startedLogs: 0,
  resolvedLogs: 0,
  matched: 0,
  phase: "init",
  histFrom: null,
  histTo: null,
  liveNext: null,
  latestRpc: null,
  latestEs: null,
  lastErr: null,
};

let persisted = readJsonSafe(STATE_FILE, {
  nextBlock: null,
  lastHistTo: null,
});

if (RESUME === 0) {
  persisted.nextBlock = null;
  persisted.lastHistTo = null;
}

function getStat(multKey) {
  if (!stats.has(multKey)) {
    stats.set(multKey, {
      loss: 0,
      wins: 0,
      spins: 0,
      lastSpinBlock: 0,
      lastWinBlock: null,
      lastWinner: null,
      lastWagerRaw: 0n,
      lastPayoutRaw: 0n,
      lastJackpotRaw: 0n,
    });
  }
  return stats.get(multKey);
}

function statsToPlainObject() {
  const obj = {};
  for (const [k, v] of stats.entries()) {
    obj[k] = {
      ...v,
      lastWagerRaw: v.lastWagerRaw.toString(),
      lastPayoutRaw: v.lastPayoutRaw.toString(),
      lastJackpotRaw: v.lastJackpotRaw.toString(),
    };
  }
  return obj;
}

function loadStatsFromDisk() {
  const obj = readJsonSafe(STATS_FILE, null);
  if (!obj) return;
  for (const [k, v] of Object.entries(obj)) {
    stats.set(k, {
      loss: Number(v.loss || 0),
      wins: Number(v.wins || 0),
      spins: Number(v.spins || 0),
      lastSpinBlock: Number(v.lastSpinBlock || 0),
      lastWinBlock: v.lastWinBlock == null ? null : Number(v.lastWinBlock),
      lastWinner: v.lastWinner || null,
      lastWagerRaw: BigInt(v.lastWagerRaw || "0"),
      lastPayoutRaw: BigInt(v.lastPayoutRaw || "0"),
      lastJackpotRaw: BigInt(v.lastJackpotRaw || "0"),
    });
  }
}

function persistAll() {
  writeJsonSafe(STATE_FILE, persisted);
  writeJsonSafe(STATS_FILE, statsToPlainObject());
}

if (RESUME) loadStatsFromDisk();

// =====================
// Provider + iface
// =====================
if (!RPC_URL) die("Faltou RPC_URL no .env");
if (!CONTRACT_ADDRESS) die("Faltou CONTRACT_ADDRESS no .env");

const provider = new ethers.JsonRpcProvider(
  RPC_URL,
  CHAIN_ID,
  { staticNetwork: true, timeout: RPC_TIMEOUT_MS }
);

const iface = new ethers.Interface(ROULETTE_EVENTS_ABI);
const topicStarted = iface.getEvent("SpinStarted").topicHash;
const topicResolved = iface.getEvent("SpinResolved").topicHash;

async function loadEvaTokenInfo() {
  try {
    const c = new ethers.Contract(CONTRACT_ADDRESS, ROULETTE_EVENTS_ABI, provider);
    const evaAddr = await c.evaToken().catch(() => null);
    if (!evaAddr || evaAddr === ethers.ZeroAddress) return;

    const erc = new ethers.Contract(evaAddr, ERC20_MIN_ABI, provider);
    const [decimals, symbol] = await Promise.all([
      erc.decimals().catch(() => EVA_DECIMALS),
      erc.symbol().catch(() => EVA_SYMBOL),
    ]);

    tokenInfo = { decimals: Number(decimals), symbol: String(symbol || EVA_SYMBOL), evaAddr };
  } catch {}
}

// =====================
// Core processing
// =====================
function pruneStartMap(max = 200000) {
  while (startMap.size > max) {
    const firstKey = startMap.keys().next().value;
    startMap.delete(firstKey);
  }
}

function onSpinStarted(logObj) {
  const parsed = iface.parseLog(logObj);
  const requestId = BigInt(parsed.args.requestId).toString();
  const multHundredths = BigInt(parsed.args.multiplierHundredths);
  const wagerRaw = BigInt(parsed.args.wager);
  const player = parsed.args.player;

  startMap.set(requestId, {
    multHundredths,
    wagerRaw,
    player,
    blockNumber: Number(logObj.blockNumber),
  });
  pruneStartMap(200000);
  runtime.startedLogs += 1;
}

function onSpinResolved(logObj) {
  const parsed = iface.parseLog(logObj);
  const requestId = BigInt(parsed.args.requestId).toString();
  const payoutRaw = BigInt(parsed.args.payout);
  const jackpotRaw = BigInt(parsed.args.jackpotPayout);
  const player = parsed.args.player;

  runtime.resolvedLogs += 1;

  const st = startMap.get(requestId);
  if (!st) return;

  const multKey = fmtMult(st.multHundredths);
  const s = getStat(multKey);

  const block = Number(logObj.blockNumber);
  s.spins += 1;
  s.lastSpinBlock = Math.max(s.lastSpinBlock || 0, block);

  const isWin = (payoutRaw > 0n) || (jackpotRaw > 0n);

  if (isWin) {
    s.wins += 1;
    s.loss = 0;
    s.lastWinBlock = block;
    s.lastWinner = player || st.player || null;
    s.lastWagerRaw = st.wagerRaw || 0n;
    s.lastPayoutRaw = payoutRaw;
    s.lastJackpotRaw = jackpotRaw;
  } else {
    s.loss += 1;
  }

  runtime.matched += 1;
}

function rowsByLoss(n = TOP_N) {
  const arr = [...stats.entries()].map(([mult, v]) => ({ mult, ...v }));
  arr.sort((a, b) => (b.loss - a.loss) || (b.spins - a.spins));
  return arr.slice(0, n);
}

function rowsByVarianceDesc(n = TOP_N) {
  const arr = [...stats.entries()]
    .map(([mult, v]) => {
      const expLoss = expectedLossBeforeWin(mult);
      const score = varianceScore(mult, v.loss);
      return { mult, ...v, expLoss, score };
    })
    .filter((r) => r.expLoss != null && Number.isFinite(r.expLoss))
    .sort((a, b) => {
      const as = a.score ?? -Infinity;
      const bs = b.score ?? -Infinity;
      return (bs - as) || (b.loss - a.loss) || (b.spins - a.spins);
    });

  return arr.slice(0, n);
}

function rowsByVarianceAsc(n = TOP_N) {
  const arr = [...stats.entries()]
    .map(([mult, v]) => {
      const expLoss = expectedLossBeforeWin(mult);
      const score = varianceScore(mult, v.loss);
      return { mult, ...v, expLoss, score };
    })
    .filter((r) => r.expLoss != null && Number.isFinite(r.expLoss))
    .sort((a, b) => {
      const as = a.score ?? Infinity;
      const bs = b.score ?? Infinity;
      return (as - bs) || (a.loss - b.loss) || (b.spins - a.spins);
    });

  return arr.slice(0, n);
}

function latestWinsRows(n = 10) {
  const arr = [...stats.entries()]
    .map(([mult, v]) => ({ mult, ...v }))
    .filter((r) => r.lastWinBlock != null)
    .sort((a, b) => (b.lastWinBlock - a.lastWinBlock));

  return arr.slice(0, n);
}

function findMultiplierKey(query) {
  const key = normalizeMultInput(query);
  if (!key) return null;
  if (stats.has(key)) return key;

  const qn = multKeyToNumber(key);
  if (!Number.isFinite(qn)) return null;

  let best = null;
  let bestDiff = Infinity;

  for (const k of stats.keys()) {
    const kn = multKeyToNumber(k);
    if (!Number.isFinite(kn)) continue;
    const diff = Math.abs(kn - qn);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = k;
    }
  }

  if (best != null && bestDiff <= 0.05) return best;
  return null;
}

function buildMultiplierDetails(foundKey) {
  const s = stats.get(foundKey);
  const chance = theoreticalWinChance(foundKey);
  const expLoss = expectedLossBeforeWin(foundKey);
  const score = varianceScore(foundKey, s.loss);

  const wager = s.lastWinBlock == null ? "-" : fmtUnits(s.lastWagerRaw, tokenInfo.decimals, tokenInfo.symbol);
  const payout = s.lastWinBlock == null ? "-" : fmtUnits(s.lastPayoutRaw, tokenInfo.decimals, tokenInfo.symbol);
  const jackpot = s.lastWinBlock == null ? "-" : fmtUnits(s.lastJackpotRaw, tokenInfo.decimals, tokenInfo.symbol);

  return [
    `🎯 ${foundKey}`,
    "",
    `📉 LOSS atuais: ${s.loss}`,
    `🎰 SPINS: ${s.spins}`,
    `🏆 WINS: ${s.wins}`,
    "",
    `📊 Chance teórica: ${fmtPct(chance)}`,
    `📏 LOSS esperado: ${expLoss == null ? "-" : expLoss.toFixed(2)}`,
    `📈 Score variância: ${fmtScore(score)}`,
    `🚦 Status: ${varianceStatus(score)}`,
    "",
    `🧱 Último WIN: ${s.lastWinBlock == null ? "-" : s.lastWinBlock}`,
    `👤 Último ganhador: ${s.lastWinner ? fmtAddr(s.lastWinner) : "-"}`,
    `💸 Wager: ${wager}`,
    `💰 Payout: ${payout}`,
    `🎁 Jackpot: ${jackpot}`,
    `🧱 Último spin: ${s.lastSpinBlock || "-"}`,
  ].join("\n");
}

function renderConsole() {
  const rows = rowsByVarianceDesc(TOP_N);

  console.clear();
  console.log("🎰 Scanner — Histórico via RPC + Live via RPC\n");
  console.log(`📌 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`⛓️  chainid: ${CHAIN_ID}`);
  console.log(`🕒 DAYS_BACK: ${DAYS_BACK} | RESUME=${RESUME} | BLOCKS_PER_DAY=${BLOCKS_PER_DAY}`);
  console.log(`🧱 HIST_CHUNK_BLOCKS=${HIST_CHUNK_BLOCKS} | HIST_RETRY_DELAY_MS=${HIST_RETRY_DELAY_MS}ms`);
  console.log(`🌐 RPC: ${RPC_URL}`);
  console.log(`🛰️ LIVE_STEP_BLOCKS=${LIVE_STEP_BLOCKS} | POLL_MS=${POLL_MS}ms | timeout=${RPC_TIMEOUT_MS}ms | LIVE_MAX_LAG_BLOCKS=${LIVE_MAX_LAG_BLOCKS}\n`);

  console.log(`📍 Phase: ${runtime.phase}`);
  if (runtime.histFrom != null) {
    console.log(`📚 HIST | from=${runtime.histFrom} to=${runtime.histTo} | latestRpc=${runtime.latestRpc} latestEs=${runtime.latestEs}`);
  }
  if (runtime.liveNext != null) {
    console.log(`🌐 LIVE | nextBlock=${runtime.liveNext} latestRpc=${runtime.latestRpc}`);
  }
  console.log(`ℹ️ logs: started=${runtime.startedLogs} | resolved=${runtime.resolvedLogs} | matched=${runtime.matched} | startMap=${startMap.size}`);
  if (runtime.lastErr) console.log(`⚠️ lastErr: ${runtime.lastErr}`);
  console.log("");

  console.log(
    [
      "MULT".padEnd(10),
      "LOSS".padStart(6),
      "ESP".padStart(8),
      "SCORE".padStart(8),
      "WINS".padStart(6),
      "SPINS".padStart(7),
      "ULT_WIN".padStart(10),
      "ULT_GANHADOR".padEnd(46),
      "WAGER".padStart(14),
      "PAYOUT".padStart(14),
      "ULT_SPIN".padStart(10),
    ].join(" | ")
  );
  console.log("-".repeat(165));

  if (!rows.length) {
    console.log("(sem dados ainda)");
    return;
  }

  for (const r of rows) {
    const ultWin = r.lastWinBlock == null ? "-" : String(r.lastWinBlock);
    const winner = r.lastWinner ? fmtAddr(r.lastWinner).padEnd(46) : "-".padEnd(46);
    const wager = r.lastWinBlock == null ? "-" : fmtUnits(r.lastWagerRaw, tokenInfo.decimals, tokenInfo.symbol);
    const payout = r.lastWinBlock == null ? "-" : fmtUnits(r.lastPayoutRaw, tokenInfo.decimals, tokenInfo.symbol);

    console.log(
      [
        r.mult.padEnd(10),
        String(r.loss).padStart(6),
        String(r.expLoss == null ? "-" : r.expLoss.toFixed(1)).padStart(8),
        String(fmtScore(r.score)).padStart(8),
        String(r.wins).padStart(6),
        String(r.spins).padStart(7),
        ultWin.padStart(10),
        winner,
        String(wager).padStart(14),
        String(payout).padStart(14),
        String(r.lastSpinBlock || "-").padStart(10),
      ].join(" | ")
    );
  }
}

// =====================
// RPC log readers
// =====================
async function getLogsSafe(fromBlock, toBlock, topic0) {
  return provider.getLogs({
    address: CONTRACT_ADDRESS,
    fromBlock,
    toBlock,
    topics: [topic0],
  });
}

// =====================
// Historical scan (RPC)
// =====================
async function scanHistorical() {
  runtime.phase = "init-hist";
  runtime.lastErr = null;

  const latestRpc = await provider.getBlockNumber();
  runtime.latestRpc = latestRpc;
  runtime.latestEs = latestRpc;

  const latestUse = latestRpc;
  const fromGuess = Math.max(0, latestUse - Math.floor(DAYS_BACK * BLOCKS_PER_DAY));

  let fromBlock = fromGuess;
  if (RESUME && persisted.lastHistTo != null && Number(persisted.lastHistTo) > 0) {
    fromBlock = Number(persisted.lastHistTo) + 1;
  }

  let cur = fromBlock;

  while (cur <= latestUse) {
    const end = Math.min(latestUse, cur + HIST_CHUNK_BLOCKS - 1);

    runtime.phase = "hist";
    runtime.histFrom = cur;
    runtime.histTo = end;
    runtime.latestRpc = await provider.getBlockNumber().catch(() => runtime.latestRpc);
    runtime.latestEs = runtime.latestRpc;
    runtime.lastErr = null;

    try {
      const [startedLogs, resolvedLogs] = await Promise.all([
        getLogsSafe(cur, end, topicStarted),
        getLogsSafe(cur, end, topicResolved),
      ]);

      for (const log of startedLogs) {
        try { onSpinStarted(log); } catch {}
      }
      for (const log of resolvedLogs) {
        try { onSpinResolved(log); } catch {}
      }

      persisted.lastHistTo = end;
      persisted.nextBlock = end + 1;
      persistAll();

      renderConsole();
      cur = end + 1;
    } catch (e) {
      runtime.lastErr = e?.shortMessage || e?.message || String(e);
      renderConsole();
      await sleep(HIST_RETRY_DELAY_MS);
    }
  }
}

// =====================
// Live scan (RPC)
// =====================
async function scanLiveForever() {
  runtime.phase = "live";
  runtime.lastErr = null;

  const latest = await provider.getBlockNumber();
  runtime.latestRpc = latest;
  runtime.latestEs = latest;

  let next = persisted.nextBlock != null ? Number(persisted.nextBlock) : latest;
  if (next < latest - LIVE_MAX_LAG_BLOCKS) next = latest;

  while (true) {
    try {
      const latestNow = await provider.getBlockNumber();
      runtime.latestRpc = latestNow;
      runtime.latestEs = latestNow;

      if (next > latestNow) {
        runtime.liveNext = next;
        renderConsole();
        await sleep(POLL_MS);
        continue;
      }

      const to = Math.min(latestNow, next + LIVE_STEP_BLOCKS - 1);
      runtime.liveNext = next;

      const [startedLogs, resolvedLogs] = await Promise.all([
        getLogsSafe(next, to, topicStarted).catch(() => []),
        getLogsSafe(next, to, topicResolved).catch(() => []),
      ]);

      for (const log of startedLogs) {
        try { onSpinStarted(log); } catch {}
      }
      for (const log of resolvedLogs) {
        try { onSpinResolved(log); } catch {}
      }

      next = to + 1;
      persisted.nextBlock = next;
      persistAll();

      renderConsole();
      await sleep(POLL_MS);
    } catch (e) {
      runtime.lastErr = e?.shortMessage || e?.message || String(e);
      renderConsole();
      await sleep(Math.max(1500, POLL_MS));
    }
  }
}

// =====================
// Telegram commands
// =====================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  send(chatId, "🤖 Bot da Roleta online.\nUse /help");
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  send(
    chatId,
    [
      "🤖 COMANDOS DO SCANNER",
      "",
      "📊 /top      → top mais esticados pela variância",
      "📈 /rank     → ranking completo por variância",
      "🔥 /hot      → os mais atrasados agora",
      "🧊 /cold     → os menos atrasados agora",
      "🎯 /m 66.45  → detalhes de um multiplicador",
      "⚖️ /compare 30 66.45 → compara dois multiplicadores",
      "🏆 /win      → últimos wins detectados",
      "📦 /stats    → resumo geral",
      "🩺 /scan     → saúde do scanner",
      "🆔 /chatid   → mostra seu chat id",
      "",
      "Obs: o ranking usa atraso vs esperado pela variância.",
    ].join("\n")
  );
});

bot.onText(/\/chatid/, (msg) => {
  send(msg.chat.id, `Seu chat_id é:\n${msg.chat.id}`);
});

bot.onText(/\/health/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  send(
    chatId,
    [
      "🩺 Status",
      `phase: ${runtime.phase}`,
      `startedLogs: ${runtime.startedLogs}`,
      `resolvedLogs: ${runtime.resolvedLogs}`,
      `matched: ${runtime.matched}`,
      `startMap: ${startMap.size}`,
      `latestRpc: ${runtime.latestRpc}`,
      `latestEs: ${runtime.latestEs}`,
      `nextBlock: ${persisted.nextBlock}`,
      runtime.lastErr ? `lastErr: ${runtime.lastErr}` : "",
    ].filter(Boolean).join("\n")
  );
});

bot.onText(/\/scan/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  send(
    chatId,
    [
      "🛰️ SCANNER",
      "",
      `Fase: ${runtime.phase}`,
      `Último bloco RPC: ${runtime.latestRpc ?? "-"}`,
      `Próximo bloco LIVE: ${runtime.liveNext ?? persisted.nextBlock ?? "-"}`,
      `Histórico: ${runtime.histFrom ?? "-"} → ${runtime.histTo ?? "-"}`,
      `SpinStarted lidos: ${runtime.startedLogs}`,
      `SpinResolved lidos: ${runtime.resolvedLogs}`,
      `Pares casados: ${runtime.matched}`,
      `startMap: ${startMap.size}`,
      runtime.lastErr ? `Erro recente: ${runtime.lastErr}` : "Erro recente: -",
    ].join("\n")
  );
});

bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const rows = [...stats.entries()].map(([mult, v]) => ({ mult, ...v }));
  if (!rows.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const totalMultipliers = rows.length;
  const totalSpins = rows.reduce((a, b) => a + b.spins, 0);
  const totalWins = rows.reduce((a, b) => a + b.wins, 0);
  const totalCurrentLoss = rows.reduce((a, b) => a + b.loss, 0);

  const hottest = rowsByVarianceDesc(1)[0];
  const coldest = rowsByVarianceAsc(1)[0];
  const latestWin = latestWinsRows(1)[0];

  send(
    chatId,
    [
      "📦 RESUMO GERAL",
      "",
      `Multiplicadores monitorados: ${totalMultipliers}`,
      `Spins contados: ${totalSpins}`,
      `Wins contados: ${totalWins}`,
      `Loss atuais somados: ${totalCurrentLoss}`,
      "",
      `🔥 Mais esticado: ${hottest ? `${hottest.mult} (${fmtScore(hottest.score)})` : "-"}`,
      `🧊 Mais frio: ${coldest ? `${coldest.mult} (${fmtScore(coldest.score)})` : "-"}`,
      `🏆 Win mais recente: ${latestWin ? `${latestWin.mult} no bloco ${latestWin.lastWinBlock}` : "-"}`,
    ].join("\n")
  );
});

bot.onText(/\/top/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const rows = rowsByVarianceDesc(TOP_N);
  if (!rows.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = [];
  lines.push("📊 TOP ESTICADOS PELA VARIÂNCIA");
  lines.push("");

  rows.slice(0, TOP_N).forEach((r, i) => {
    lines.push(
      `${i + 1}. ${r.mult} → LOSS ${r.loss} | esperado ${r.expLoss.toFixed(1)} | score ${fmtScore(r.score)}`
    );
  });

  send(chatId, lines.join("\n"));
});

bot.onText(/\/rank/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const rows = rowsByVarianceDesc(TOP_N);
  if (!rows.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = ["📈 RANKING POR VARIÂNCIA", ""];
  for (const r of rows) {
    lines.push(
      `${r.mult} | score ${fmtScore(r.score)} | LOSS ${r.loss} | esperado ${r.expLoss.toFixed(1)} | ${varianceStatus(r.score)}`
    );
  }

  send(chatId, lines.join("\n"));
});

bot.onText(/\/hot/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const rows = rowsByVarianceDesc(10);
  if (!rows.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = ["🔥 MAIS ATRASADOS AGORA", ""];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.mult} | score ${fmtScore(r.score)} | LOSS ${r.loss}`);
  });

  send(chatId, lines.join("\n"));
});

bot.onText(/\/cold/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const rows = rowsByVarianceAsc(10);
  if (!rows.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = ["🧊 MENOS ATRASADOS AGORA", ""];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.mult} | score ${fmtScore(r.score)} | LOSS ${r.loss}`);
  });

  send(chatId, lines.join("\n"));
});

bot.onText(/\/win/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const rows = latestWinsRows(10);
  if (!rows.length) {
    send(chatId, "Ainda não há wins registrados no período carregado.");
    return;
  }

  const lines = ["🏆 ÚLTIMOS WINS", ""];
  for (const r of rows) {
    lines.push(
      [
        `${r.mult} | bloco ${r.lastWinBlock}`,
        `ganhador: ${r.lastWinner ? fmtAddr(r.lastWinner) : "-"}`,
        `wager: ${fmtUnits(r.lastWagerRaw, tokenInfo.decimals, tokenInfo.symbol)}`,
        `payout: ${fmtUnits(r.lastPayoutRaw, tokenInfo.decimals, tokenInfo.symbol)}`,
        `jackpot: ${fmtUnits(r.lastJackpotRaw, tokenInfo.decimals, tokenInfo.symbol)}`,
        "",
      ].join("\n")
    );
  }

  send(chatId, lines.join("\n"));
});

bot.onText(/\/m(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const query = String(match?.[1] || "").trim();
  if (!query) {
    send(chatId, "Uso: /m 100x  ou  /m 66.45");
    return;
  }

  const foundKey = findMultiplierKey(query);

  if (!foundKey || !stats.has(foundKey)) {
    send(chatId, `Não achei esse multiplicador ainda: ${query}\nTente /top para ver os disponíveis.`);
    return;
  }

  send(chatId, buildMultiplierDetails(foundKey));
});

bot.onText(/\/compare(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const raw = String(match?.[1] || "").trim();
  const parts = raw.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    send(chatId, "Uso: /compare 30 66.45");
    return;
  }

  const k1 = findMultiplierKey(parts[0]);
  const k2 = findMultiplierKey(parts[1]);

  if (!k1 || !k2 || !stats.has(k1) || !stats.has(k2)) {
    send(chatId, "Não consegui encontrar os dois multiplicadores. Tente valores como /compare 30 66.45");
    return;
  }

  const s1 = stats.get(k1);
  const s2 = stats.get(k2);

  const sc1 = varianceScore(k1, s1.loss);
  const sc2 = varianceScore(k2, s2.loss);

  send(
    chatId,
    [
      "⚖️ COMPARAÇÃO",
      "",
      `${k1}`,
      `LOSS: ${s1.loss} | WINS: ${s1.wins} | SPINS: ${s1.spins}`,
      `Chance teórica: ${fmtPct(theoreticalWinChance(k1))}`,
      `Loss esperado: ${expectedLossBeforeWin(k1)?.toFixed(2) ?? "-"}`,
      `Score variância: ${fmtScore(sc1)}`,
      `Status: ${varianceStatus(sc1)}`,
      "",
      `${k2}`,
      `LOSS: ${s2.loss} | WINS: ${s2.wins} | SPINS: ${s2.spins}`,
      `Chance teórica: ${fmtPct(theoreticalWinChance(k2))}`,
      `Loss esperado: ${expectedLossBeforeWin(k2)?.toFixed(2) ?? "-"}`,
      `Score variância: ${fmtScore(sc2)}`,
      `Status: ${varianceStatus(sc2)}`,
    ].join("\n")
  );
});

// =====================
// Boot
// =====================
(async () => {
  console.log("✅ Bot Telegram online. Use /help no Telegram.");
  await loadEvaTokenInfo();
  renderConsole();

  // histórico completo primeiro; só depois entra no live
  await scanHistorical();
  await scanLiveForever();
})().catch((e) => {
  console.error("❌ Scanner erro fatal:", e?.message || e);
  process.exit(1);
});
