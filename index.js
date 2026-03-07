const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { ethers } = require("ethers");

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CHAIN_ID = Number(process.env.CHAIN_ID || 42161);
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS || "").trim();

const DAYS_BACK = Number(process.env.DAYS_BACK || 90);
const RESUME = Number(process.env.RESUME || 1);

const RPC_URL = (process.env.RPC_URL || "").trim();

const HIST_CHUNK_BLOCKS = Number(process.env.HIST_CHUNK_BLOCKS || 6000);
const HIST_RETRY_DELAY_MS = Number(process.env.HIST_RETRY_DELAY_MS || 2000);

const LIVE_STEP_BLOCKS = Number(process.env.LIVE_STEP_BLOCKS || 3000);
const POLL_MS = Number(process.env.POLL_MS || 1500);
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 30000);
const BLOCKS_PER_DAY = Number(process.env.BLOCKS_PER_DAY || 345600);
const LIVE_MAX_LAG_BLOCKS = Number(process.env.LIVE_MAX_LAG_BLOCKS || 2000000);

if (!TELEGRAM_BOT_TOKEN) throw new Error("Faltou TELEGRAM_BOT_TOKEN");
if (!RPC_URL) throw new Error("Faltou RPC_URL");
if (!CONTRACT_ADDRESS) throw new Error("Faltou CONTRACT_ADDRESS");

// =====================
// PATHS / STATE FILE
// =====================
const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "scanner_state.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// =====================
// HELPERS
// =====================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtMult(h) {
  return (Number(h) / 100).toFixed(2).replace(/\.00$/, "") + "x";
}

function multNum(mult) {
  return Number(String(mult).replace("x", ""));
}

function winChance(mult) {
  return 1 / multNum(mult);
}

function expectedLoss(mult) {
  const p = winChance(mult);
  return (1 / p) - 1;
}

function varianceScore(mult, loss) {
  const exp = expectedLoss(mult);
  return exp > 0 ? loss / exp : 0;
}

function streakProbability(mult, loss) {
  const p = winChance(mult);
  const lose = 1 - p;
  return Math.pow(lose, loss);
}

function allowedChat(chatId) {
  if (!TELEGRAM_ALLOWED_CHAT_IDS.length) return true;
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId));
}

// =====================
// TELEGRAM
// =====================
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

let pollingStarting = false;
let pollingStarted = false;

const recentCommands = new Map();

function shouldProcessCommand(chatId, text, windowMs = 2500) {
  const now = Date.now();
  const key = `${chatId}:${String(text || "").trim()}`;
  const last = recentCommands.get(key);

  for (const [k, ts] of recentCommands.entries()) {
    if (now - ts > 15000) recentCommands.delete(k);
  }

  if (last && now - last < windowMs) return false;
  recentCommands.set(key, now);
  return true;
}

function send(chatId, text) {
  return bot.sendMessage(chatId, text, {
    disable_web_page_preview: true,
  }).catch((e) => {
    console.log("send error:", e?.message || e);
  });
}

async function startTelegramPolling() {
  if (pollingStarting || pollingStarted) return;

  pollingStarting = true;

  try {
    await bot.deleteWebHook({ drop_pending_updates: false }).catch(() => {});
    await bot.stopPolling().catch(() => {});
    await sleep(4000);

    await bot.startPolling({
      restart: true,
      polling: {
        interval: 300,
        params: { timeout: 10 },
      },
    });

    pollingStarted = true;
    console.log("🤖 Telegram polling iniciado");
  } catch (e) {
    console.log("Erro ao iniciar polling:", e?.message || e);
  } finally {
    pollingStarting = false;
  }
}

async function restartTelegramPolling(reason = "") {
  if (pollingStarting) return;

  pollingStarted = false;

  try {
    console.log(`⚠️ Reiniciando polling: ${reason}`);
    await bot.stopPolling().catch(() => {});
  } catch {}

  await sleep(5000);
  await startTelegramPolling();
}

bot.on("polling_error", async (err) => {
  const msg = err?.message || String(err || "");
  console.log("⚠️ polling_error:", msg);

  if (/409|terminated by other getUpdates request|conflict/i.test(msg)) {
    await restartTelegramPolling("409 conflict");
  }
});

// =====================
// STATE
// =====================
const stats = new Map();
const startMap = new Map();

let latestKnownBlock = 0;
let historicalRunning = false;
let historicalFinished = false;
let liveRunning = false;
let historicalCursor = null;
let historicalStartBlock = null;

// evita live e histórico processarem o mesmo tempo de forma bagunçada
let processingLock = false;

function getStat(mult) {
  if (!stats.has(mult)) {
    stats.set(mult, {
      loss: 0,
      wins: 0,
      spins: 0,
      lastWinBlock: null,
      lastWinner: null,
      lastWager: 0n,
      lastPayout: 0n,
      lastJackpot: 0n,
    });
  }
  return stats.get(mult);
}

function serializeStats() {
  const out = {};
  for (const [mult, s] of stats.entries()) {
    out[mult] = {
      ...s,
      lastWager: String(s.lastWager || 0n),
      lastPayout: String(s.lastPayout || 0n),
      lastJackpot: String(s.lastJackpot || 0n),
    };
  }
  return out;
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const data = JSON.parse(raw);

    latestKnownBlock = Number(data.latestKnownBlock || 0);
    historicalFinished = Boolean(data.historicalFinished);
    historicalCursor = data.historicalCursor == null ? null : Number(data.historicalCursor);
    historicalStartBlock = data.historicalStartBlock == null ? null : Number(data.historicalStartBlock);

    if (data.stats && typeof data.stats === "object") {
      for (const [mult, s] of Object.entries(data.stats)) {
        stats.set(mult, {
          loss: Number(s.loss || 0),
          wins: Number(s.wins || 0),
          spins: Number(s.spins || 0),
          lastWinBlock: s.lastWinBlock == null ? null : Number(s.lastWinBlock),
          lastWinner: s.lastWinner || null,
          lastWager: BigInt(s.lastWager || "0"),
          lastPayout: BigInt(s.lastPayout || "0"),
          lastJackpot: BigInt(s.lastJackpot || "0"),
        });
      }
    }

    console.log("♻️ state carregado");
  } catch (e) {
    console.log("Erro ao carregar state:", e?.message || e);
  }
}

function saveState() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      latestKnownBlock,
      historicalFinished,
      historicalCursor,
      historicalStartBlock,
      stats: serializeStats(),
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (e) {
    console.log("Erro ao salvar state:", e?.message || e);
  }
}

// =====================
// PROVIDER
// =====================
const provider = new ethers.JsonRpcProvider(
  RPC_URL,
  CHAIN_ID,
  { staticNetwork: true, timeout: RPC_TIMEOUT_MS }
);

const ABI = [
  "event SpinStarted(uint256 indexed requestId,address indexed player,uint256 wager,uint256 netStake,uint256 multiplierHundredths,uint256 maxPayout,uint256 jackpotContribution,uint32 configIndex,bool participatingInJackpot)",
  "event SpinResolved(uint256 indexed requestId,address indexed player,uint8 outcome,uint256 payout,uint8 spinsConsumed,uint256 jackpotPayout)"
];

const iface = new ethers.Interface(ABI);
const topicStarted = iface.getEvent("SpinStarted").topicHash;
const topicResolved = iface.getEvent("SpinResolved").topicHash;

// =====================
// EVENTS
// =====================
function onSpinStarted(log) {
  const parsed = iface.parseLog(log);

  startMap.set(parsed.args.requestId.toString(), {
    mult: parsed.args.multiplierHundredths,
    wager: parsed.args.wager,
    player: parsed.args.player,
  });
}

function onSpinResolved(log) {
  const parsed = iface.parseLog(log);
  const id = parsed.args.requestId.toString();
  const start = startMap.get(id);

  if (!start) return;

  const mult = fmtMult(start.mult);
  const s = getStat(mult);

  s.spins++;

  if (parsed.args.payout > 0n || parsed.args.jackpotPayout > 0n) {
    s.wins++;
    s.loss = 0;
    s.lastWinBlock = log.blockNumber;
    s.lastWinner = parsed.args.player;
    s.lastWager = start.wager;
    s.lastPayout = parsed.args.payout;
    s.lastJackpot = parsed.args.jackpotPayout;
  } else {
    s.loss++;
  }

  startMap.delete(id);
}

function varianceRows(n = 10) {
  const arr = [];

  for (const [mult, v] of stats.entries()) {
    if (multNum(mult) < 2) continue;
    if (v.loss < 5) continue;
    if (v.spins < 10) continue;

    const expLoss = expectedLoss(mult);

    arr.push({
      mult,
      ...v,
      expLoss,
      score: varianceScore(mult, v.loss),
    });
  }

  arr.sort((a, b) => b.score - a.score);
  return arr.slice(0, n);
}

// =====================
// TELEGRAM COMMANDS
// =====================
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  send(
    chatId,
    [
      "🤖 COMANDOS",
      "",
      "/best → melhores pela variância",
      "/top → maior sequência de loss",
      "/m 30 → detalhes multiplicador",
      "/lastwin 30 → último ganhador",
      "/stats → resumo",
      "/status → andamento do scanner",
      "/chatid",
    ].join("\n")
  );
});

bot.onText(/\/chatid/, (msg) => {
  const chatId = msg.chat.id;
  if (!shouldProcessCommand(chatId, msg.text)) return;
  send(chatId, String(chatId));
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  send(
    chatId,
    [
      "📡 STATUS",
      `telegram: ${pollingStarted ? "online" : "offline"}`,
      `histórico rodando: ${historicalRunning ? "sim" : "não"}`,
      `histórico finalizado: ${historicalFinished ? "sim" : "não"}`,
      `live rodando: ${liveRunning ? "sim" : "não"}`,
      `latestKnownBlock: ${latestKnownBlock || "-"}`,
      `historicalCursor: ${historicalCursor || "-"}`,
      `multiplicadores: ${stats.size}`,
    ].join("\n")
  );
});

bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  let spins = 0;
  let wins = 0;

  for (const v of stats.values()) {
    spins += v.spins;
    wins += v.wins;
  }

  send(
    chatId,
    `📦 STATS

multiplicadores: ${stats.size}
spins: ${spins}
wins: ${wins}`
  );
});

bot.onText(/\/top/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  const arr = [...stats.entries()]
    .map(([m, v]) => ({ mult: m, ...v }))
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 10);

  if (!arr.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = ["📊 TOP LOSS", ""];
  arr.forEach((r) => lines.push(`${r.mult} → ${r.loss} LOSS`));
  send(chatId, lines.join("\n"));
});

bot.onText(/\/best/, (msg) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  const rows = varianceRows(10);

  if (!rows.length) {
    send(chatId, "Sem dados ainda. O scanner está carregando histórico.");
    return;
  }

  const lines = ["🔥 MELHORES PELA VARIÂNCIA", ""];
  rows.forEach((r, i) => {
    lines.push(
      `${i + 1}️⃣ ${r.mult}
score: ${r.score.toFixed(2)}
loss: ${r.loss}
esperado: ${r.expLoss.toFixed(1)}`
    );
  });

  send(chatId, lines.join("\n\n"));
});

bot.onText(/\/m (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  let q = String(match[1] || "").replace(",", ".");
  let key = q.includes("x") ? q : q + "x";

  if (!stats.has(key)) {
    send(chatId, "multiplicador não encontrado");
    return;
  }

  const s = stats.get(key);
  const exp = expectedLoss(key);
  const prob = streakProbability(key, s.loss);

  send(
    chatId,
    `🎯 ${key}

LOSS: ${s.loss}
SPINS: ${s.spins}
WINS: ${s.wins}

esperado: ${exp.toFixed(1)}
score: ${(s.loss / exp).toFixed(2)}

chance dessa sequência: ${(prob * 100).toFixed(2)}%

último win: ${s.lastWinBlock || "-"}`
  );
});

bot.onText(/\/lastwin (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!allowedChat(chatId)) return;
  if (!shouldProcessCommand(chatId, msg.text)) return;

  let q = String(match[1] || "").replace(",", ".");
  let key = q.includes("x") ? q : q + "x";

  if (!stats.has(key)) {
    send(chatId, "multiplicador não encontrado");
    return;
  }

  const s = stats.get(key);

  if (!s.lastWinBlock) {
    send(chatId, "nenhum win registrado ainda");
    return;
  }

  send(
    chatId,
    `🏆 Último WIN — ${key}

Carteira:
${s.lastWinner}

Bloco:
${s.lastWinBlock}`
  );
});

// =====================
// RPC
// =====================
async function getLogs(from, to, topic) {
  return provider.getLogs({
    address: CONTRACT_ADDRESS,
    fromBlock: from,
    toBlock: to,
    topics: [topic],
  });
}

async function processRange(from, to, label) {
  const [a, b] = await Promise.all([
    getLogs(from, to, topicStarted),
    getLogs(from, to, topicResolved),
  ]);

  a.forEach(onSpinStarted);
  b.forEach(onSpinResolved);

  if (to > latestKnownBlock) {
    latestKnownBlock = to;
  }

  console.log(`${label} ${from} -> ${to}`);
}

async function withProcessingLock(fn) {
  while (processingLock) {
    await sleep(20);
  }

  processingLock = true;
  try {
    return await fn();
  } finally {
    processingLock = false;
  }
}

// =====================
// HISTORICAL
// =====================
async function scanHistorical() {
  if (historicalRunning) return;
  historicalRunning = true;

  try {
    const latest = await provider.getBlockNumber();

    const baseFrom = Math.max(
      0,
      latest - (DAYS_BACK * BLOCKS_PER_DAY)
    );

    if (!RESUME || historicalStartBlock == null) {
      historicalStartBlock = baseFrom;
    }

    if (!RESUME || historicalCursor == null) {
      historicalCursor = historicalStartBlock;
    }

    if (historicalCursor < historicalStartBlock) {
      historicalCursor = historicalStartBlock;
    }

    console.log(`📚 histórico start=${historicalStartBlock} latest=${latest} cursor=${historicalCursor}`);

    while (historicalCursor <= latest) {
      const from = historicalCursor;
      const to = Math.min(latest, from + HIST_CHUNK_BLOCKS - 1);

      try {
        await withProcessingLock(async () => {
          await processRange(from, to, "hist");
        });

        historicalCursor = to + 1;
        saveState();
        await sleep(1);
      } catch (e) {
        console.log("hist error:", e?.message || e);
        await sleep(HIST_RETRY_DELAY_MS);
      }
    }

    historicalFinished = true;
    saveState();
    console.log("✅ histórico finalizado");
  } catch (e) {
    console.log("Erro no histórico:", e?.message || e);
  } finally {
    historicalRunning = false;
  }
}

// =====================
// LIVE
// =====================
async function scanLive() {
  if (liveRunning) return;
  liveRunning = true;

  try {
    let next = await provider.getBlockNumber();

    if (latestKnownBlock > 0) {
      next = Math.max(next, latestKnownBlock + 1);
    }

    console.log("📡 live mode");

    while (true) {
      try {
        const latest = await provider.getBlockNumber();

        let from = next;
        const minAllowed = Math.max(0, latest - LIVE_MAX_LAG_BLOCKS);

        if (from < minAllowed) {
          from = minAllowed;
        }

        if (from > latest) {
          await sleep(POLL_MS);
          continue;
        }

        const to = Math.min(latest, from + LIVE_STEP_BLOCKS - 1);

        await withProcessingLock(async () => {
          await processRange(from, to, "live");
        });

        next = to + 1;
        saveState();
        await sleep(1);
      } catch (e) {
        console.log("live error:", e?.message || e);
        await sleep(Math.max(POLL_MS, 2000));
      }
    }
  } finally {
    liveRunning = false;
  }
}

// =====================
// START
// =====================
(async () => {
  console.log("🚀 scanner start");

  if (RESUME) {
    loadState();
  }

  await startTelegramPolling();

  scanHistorical().catch((e) => {
    console.log("scanHistorical error:", e?.message || e);
  });

  scanLive().catch((e) => {
    console.log("scanLive error:", e?.message || e);
  });
})().catch((e) => {
  console.error("❌ erro fatal:", e?.message || e);
});

// =====================
// EXIT
// =====================
function shutdown(signal) {
  try {
    console.log(`🛑 ${signal}`);
    saveState();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  console.log("uncaughtException:", e?.message || e);
});
process.on("unhandledRejection", (e) => {
  console.log("unhandledRejection:", e?.message || e);
});
