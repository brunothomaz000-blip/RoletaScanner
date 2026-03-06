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

const DAYS_BACK = Number(process.env.DAYS_BACK || 7);
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
  const s = x.toFixed(2).replace(/\.00$/, "");
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

function topLossRows(n = TOP_N) {
  const arr = [...stats.entries()].map(([mult, v]) => ({ mult, ...v }));
  arr.sort((a, b) => (b.loss - a.loss) || (b.spins - a.spins));
  return arr.slice(0, n);
}

function renderConsole() {
  const rows = topLossRows(TOP_N);

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
      "WINS".padStart(6),
      "SPINS".padStart(7),
      "ULT_WIN".padStart(10),
      "ULT_GANHADOR".padEnd(46),
      "WAGER".padStart(14),
      "PAYOUT".padStart(14),
      "JACKPOT".padStart(14),
      "ULT_SPIN".padStart(10),
    ].join(" | ")
  );
  console.log("-".repeat(170));

  if (!rows.length) {
    console.log("(sem dados ainda)");
    return;
  }

  for (const r of rows) {
    const ultWin = r.lastWinBlock == null ? "-" : String(r.lastWinBlock);
    const winner = r.lastWinner ? fmtAddr(r.lastWinner).padEnd(46) : "-".padEnd(46);

    const wager = r.lastWinBlock == null ? "-" : fmtUnits(r.lastWagerRaw, tokenInfo.decimals, tokenInfo.symbol);
    const payout = r.lastWinBlock == null ? "-" : fmtUnits(r.lastPayoutRaw, tokenInfo.decimals, tokenInfo.symbol);
    const jackpot = r.lastWinBlock == null ? "-" : fmtUnits(r.lastJackpotRaw, tokenInfo.decimals, tokenInfo.symbol);

    console.log(
      [
        r.mult.padEnd(10),
        String(r.loss).padStart(6),
        String(r.wins).padStart(6),
        String(r.spins).padStart(7),
        ultWin.padStart(10),
        winner,
        String(wager).padStart(14),
        String(payout).padStart(14),
        String(jackpot).padStart(14),
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
      "🤖 Comandos",
      "",
      "/top — top LOSS seguidos por multiplicador",
      "/m 100x — detalhes de um multiplicador (ex: /m 1.40x, /m 100x)",
      "/health — status do scanner",
      "/chatid — mostra seu chat id",
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

bot.onText(/\/top/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const rows = topLossRows(TOP_N);
  if (!rows.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = [];
  lines.push("📊 Top LOSS (após último WIN)");
  lines.push("");

  for (const r of rows.slice(0, TOP_N)) {
    lines.push(`${r.mult} → ${r.loss} LOSS | spins ${r.spins} | wins ${r.wins}`);
  }

  send(chatId, lines.join("\n"));
});

bot.onText(/\/m (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;

  const query = String(match[1] || "").trim();
  if (!query) {
    send(chatId, "Uso: /m 100x  (ou /m 1.40x)");
    return;
  }

  let key = query.toLowerCase().includes("x") ? query : (query + "x");
  let foundKey = null;

  if (stats.has(key)) foundKey = key;
  else {
    const qn = Number(key.replace("x", "").trim());
    if (Number.isFinite(qn)) {
      let best = null;
      let bestDiff = Infinity;
      for (const k of stats.keys()) {
        const kn = Number(String(k).replace("x", ""));
        if (!Number.isFinite(kn)) continue;
        const diff = Math.abs(kn - qn);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = k;
        }
      }
      if (best != null && bestDiff <= 0.05) foundKey = best;
    }
  }

  if (!foundKey || !stats.has(foundKey)) {
    send(chatId, `Não achei esse multiplicador ainda: ${query}\nTente /top pra ver os disponíveis.`);
    return;
  }

  const s = stats.get(foundKey);

  const wager = s.lastWinBlock == null ? "-" : fmtUnits(s.lastWagerRaw, tokenInfo.decimals, tokenInfo.symbol);
  const payout = s.lastWinBlock == null ? "-" : fmtUnits(s.lastPayoutRaw, tokenInfo.decimals, tokenInfo.symbol);
  const jackpot = s.lastWinBlock == null ? "-" : fmtUnits(s.lastJackpotRaw, tokenInfo.decimals, tokenInfo.symbol);

  send(
    chatId,
    [
      `📌 ${foundKey}`,
      "",
      `LOSS atuais: ${s.loss}`,
      `SPINS: ${s.spins}`,
      `WINS: ${s.wins}`,
      "",
      `Último WIN (bloco): ${s.lastWinBlock == null ? "-" : s.lastWinBlock}`,
      `Último ganhador: ${s.lastWinner ? fmtAddr(s.lastWinner) : "-"}`,
      `Wager: ${wager}`,
      `Payout: ${payout}`,
      `Jackpot: ${jackpot}`,
      `Último spin (bloco): ${s.lastSpinBlock || "-"}`,
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
