import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
loadDotEnv(join(__dirname, ".env"));
const preferredPort = Number(process.env.DASHBOARD_PORT || process.env.PORT || 5173);
const listenHost = process.env.DASHBOARD_HOST || "0.0.0.0";
const snapshotCacheMs = Number(process.env.SNAPSHOT_CACHE_MS || 15000);
const adminToken = process.env.ADMIN_TOKEN || "";
const phoneAlertThresholdPct = Number(process.env.DISCOUNT_ALERT_THRESHOLD_PCT || 2);
const phoneAlertStepPct = Number(process.env.DISCOUNT_ALERT_STEP_PCT || 1);
const phoneAlertConfirmRefreshes = Number(process.env.DISCOUNT_ALERT_CONFIRM_REFRESHES || 2);
const phoneAlertCheckMs = Number(process.env.DISCOUNT_ALERT_CHECK_MS || 30000);
const phoneAlertCooldownMs = Number(process.env.DISCOUNT_ALERT_COOLDOWN_MS || 5 * 60 * 1000);
const preopenStrategyTime = process.env.PREOPEN_STRATEGY_TIME || "08:55";
const preopenStrategyUntil = process.env.PREOPEN_STRATEGY_UNTIL || "09:20";
const preopenStrategyTimezone = process.env.PREOPEN_STRATEGY_TIMEZONE || "Asia/Hong_Kong";
const preopenStrategyEnabled = process.env.PREOPEN_STRATEGY_ENABLED !== "0";
const phoneAlertNavIds = new Set(
  (process.env.DISCOUNT_ALERT_NAV_IDS || "theoretical")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const execFileAsync = promisify(execFile);

const PRODUCT_NAME = "CSOP SK Hynix Daily (2x) Leveraged Product";
const YAHOO_CHART_HOSTS = [
  "https://query1.finance.yahoo.com/v8/finance/chart",
  "https://query2.finance.yahoo.com/v8/finance/chart",
];
const HYNIX_SYMBOL = "000660.KS";
const NAVER_HYNIX_CODE = "000660";
const NAVER_HYNIX_PAGE = "https://stock.naver.com/domestic/stock/000660/total";
const NAVER_HYNIX_MOBILE_PAGE = "https://m.stock.naver.com/domestic/stock/000660/total";
const NAVER_HYNIX_CHART_API = `https://api.stock.naver.com/chart/domestic/item/${NAVER_HYNIX_CODE}`;
const PRODUCT_SYMBOL = "7709.HK";
const TENCENT_PRODUCT_CODE = "hk07709";
const TENCENT_PRODUCT_PAGE = "https://gu.qq.com/hk07709";
const TENCENT_PRODUCT_QUOTE_API = `https://qt.gtimg.cn/q=r_${TENCENT_PRODUCT_CODE}`;
const TENCENT_PRODUCT_MINUTE_API = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${TENCENT_PRODUCT_CODE}`;
const CSOP_NAV_API = "https://website-api.csopasset.com/cmsApi/NAV/product";
const CSOP_PRODUCT_URL = "https://www.csopasset.com/en/products/hk-skhy-2l";
const CSOP_INTRADAY_NAV_URL =
  "https://csopasset.factsetdigitalsolutions.com/application/index/quote?s=7709&l=en";
const TRADINGVIEW_SCAN_API = "https://scanner.tradingview.com/hongkong/scan";
const TRADINGVIEW_SYMBOL = "HKEX:7709";
const TRADINGVIEW_COLUMNS = [
  "name",
  "description",
  "close",
  "change",
  "change_abs",
  "currency",
  "nav",
  "nav_discount_premium",
  "total_assets",
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

const fetchHeaders = {
  "accept": "application/json,text/plain,*/*",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
};

let snapshotCache = null;
let snapshotInFlight = null;
const phoneAlertConfig = buildPhoneAlertConfig();
const phoneAlertState = {
  active: false,
  lastSentAt: 0,
  lastError: null,
  lastResult: null,
  notifiedLevelKeys: new Set(),
  pendingLevelCounts: new Map(),
  timer: null,
};
const preopenStrategyState = {
  timer: null,
  lastSentDate: null,
  lastReport: null,
  lastError: null,
};
function loadDotEnv(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Optional local config file.
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      res.writeHead(204, jsonHeaders);
      res.end();
      return;
    }

    if (url.pathname === "/api/snapshot") {
      const snapshot = await getSnapshotCached();
      writeJson(res, 200, snapshot);
      return;
    }

    if (url.pathname === "/api/health") {
      writeJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        cacheTtlMs: snapshotCacheMs,
        phoneAlert: publicPhoneAlertStatus(),
      });
      return;
    }

    if (url.pathname === "/api/alert/status") {
      writeJson(res, 200, publicPhoneAlertStatus());
      return;
    }

    if (url.pathname === "/api/alert/test") {
      if (!authorizeAdminRequest(req, res)) return;
      const snapshot = await getSnapshotCached();
      const theoretical = findTheoreticalNavView(snapshot);
      const officialNav = snapshot.officialNav || {};
      const productPrice = snapshot.quotes?.product?.price;
      const result = await sendPhoneAlert(
        "7709 理论NAV提醒测试",
        [
          `当前折溢价: ${formatPercentServer(theoretical?.discount)}`,
          `7709 ${formatServerMoney(productPrice)}`,
          `理论 NAV ${formatServerMoney(theoretical?.value)}`,
          `官方 NAV ${formatServerMoney(officialNav.hkdNav)}${officialNav.date ? `（${officialNav.date}）` : ""}`,
          `时间 ${timeInZone(Date.now(), "Asia/Shanghai")}`,
        ].join("\n"),
      );
      writeJson(res, result.ok ? 200 : 500, result);
      return;
    }

    if (url.pathname === "/api/preopen-strategy") {
      const report = await buildPreopenStrategyReport();
      writeJson(res, 200, report);
      return;
    }

    if (url.pathname === "/api/preopen-strategy/test") {
      if (!authorizeAdminRequest(req, res)) return;
      const report = await buildPreopenStrategyReport();
      const result = await sendPreopenStrategyReport(report, true);
      writeJson(res, result.ok ? 200 : 500, { report, push: result });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    writeJson(res, 500, {
      error: "SERVER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

function authorizeAdminRequest(req, res) {
  if (!adminToken && isLocalRequest(req)) return true;

  const authorization = req.headers.authorization || "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  if (adminToken && tokensMatch(suppliedToken, adminToken)) return true;

  writeJson(res, 403, {
    error: "ADMIN_AUTH_REQUIRED",
    message: "This endpoint requires an admin bearer token.",
  });
  return false;
}

function isLocalRequest(req) {
  const forwardedHost = Array.isArray(req.headers["x-forwarded-host"])
    ? req.headers["x-forwarded-host"][0]
    : req.headers["x-forwarded-host"]?.split(",")[0];
  const hostHeader = forwardedHost?.trim() || req.headers.host || "";
  let hostname = "";

  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }

  return isLoopbackAddress(req.socket.remoteAddress) &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]");
}

function isLoopbackAddress(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function tokensMatch(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

listenWithFallback(server, preferredPort, listenHost);

function listenWithFallback(instance, candidatePort, host, attempts = 0) {
  instance.once("error", (error) => {
    if (error?.code === "EADDRINUSE" && attempts < 10) {
      listenWithFallback(instance, candidatePort + 1, host, attempts + 1);
      return;
    }
    throw error;
  });

  instance.listen(candidatePort, host, () => {
    console.log(`7709 NAV Watch running at http://localhost:${candidatePort}`);
    for (const url of getLanUrls(candidatePort)) {
      console.log(`LAN access: ${url}`);
    }
    startPhoneAlertMonitor();
    startPreopenStrategyMonitor();
  });
}

function getLanUrls(port) {
  const urls = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`http://${item.address}:${port}`);
      }
    }
  }
  return urls;
}

async function serveStatic(pathname, res) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function writeJson(res, status, payload) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(payload));
}

async function getSnapshotCached() {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.createdAt < snapshotCacheMs) {
    return decorateSnapshotCache(snapshotCache.payload, true);
  }

  if (!snapshotInFlight) {
    snapshotInFlight = buildSnapshot()
      .then((payload) => {
        snapshotCache = {
          createdAt: Date.now(),
          payload,
        };
        return payload;
      })
      .finally(() => {
        snapshotInFlight = null;
      });
  }

  const payload = await snapshotInFlight;
  return decorateSnapshotCache(payload, false);
}

function decorateSnapshotCache(snapshot, hit) {
  const ageMs = snapshotCache ? Date.now() - snapshotCache.createdAt : 0;
  return {
    ...snapshot,
    cache: {
      hit,
      ageMs: Math.max(0, ageMs),
      ttlMs: snapshotCacheMs,
    },
  };
}

function buildPhoneAlertConfig() {
  const targets = [];

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    targets.push({
      type: "telegram",
      name: "Telegram",
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    });
  }

  if (process.env.BARK_PUSH_URL || process.env.BARK_DEVICE_KEY) {
    const serverUrl = (process.env.BARK_SERVER_URL || "https://api.day.app").replace(/\/$/, "");
    targets.push({
      type: "bark",
      name: "Bark",
      url: process.env.BARK_PUSH_URL || `${serverUrl}/${process.env.BARK_DEVICE_KEY}`,
    });
  }

  if (process.env.PUSHPLUS_TOKEN) {
    targets.push({
      type: "pushplus",
      name: "PushPlus",
      token: process.env.PUSHPLUS_TOKEN,
    });
  }

  if (process.env.SERVERCHAN_SENDKEY) {
    targets.push({
      type: "serverchan",
      name: "Server酱",
      sendKey: process.env.SERVERCHAN_SENDKEY,
    });
  }

  if (process.env.DISCOUNT_ALERT_WEBHOOK_URL) {
    targets.push({
      type: "webhook",
      name: "Webhook",
      url: process.env.DISCOUNT_ALERT_WEBHOOK_URL,
    });
  }

  return {
    enabled: process.env.DISCOUNT_ALERT_ENABLED !== "0" && targets.length > 0,
    targets,
  };
}

function publicPhoneAlertStatus() {
  return {
    enabled: phoneAlertConfig.enabled,
    configured: phoneAlertConfig.targets.length > 0,
    channels: phoneAlertConfig.targets.map((target) => target.name),
    thresholdPct: phoneAlertThresholdPct,
    stepPct: phoneAlertStepPct,
    confirmRefreshes: phoneAlertConfirmRefreshes,
    checkMs: phoneAlertCheckMs,
    cooldownMs: phoneAlertCooldownMs,
    navIds: [...phoneAlertNavIds],
    active: phoneAlertState.active,
    lastSentAt: phoneAlertState.lastSentAt ? new Date(phoneAlertState.lastSentAt).toISOString() : null,
    lastResult: phoneAlertState.lastResult,
    lastError: phoneAlertState.lastError,
    notifiedLevels: [...phoneAlertState.notifiedLevelKeys],
    pendingLevels: Object.fromEntries(phoneAlertState.pendingLevelCounts),
  };
}

function startPhoneAlertMonitor() {
  if (!phoneAlertConfig.enabled) {
    console.log("Phone discount alerts are not configured. Set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, BARK_DEVICE_KEY, PUSHPLUS_TOKEN, SERVERCHAN_SENDKEY, or DISCOUNT_ALERT_WEBHOOK_URL to enable.");
    return;
  }

  if (phoneAlertState.timer) return;
  console.log(
    `Phone discount alerts enabled via ${phoneAlertConfig.targets
      .map((target) => target.name)
      .join(", ")}; theoretical NAV spread levels start at ${phoneAlertThresholdPct.toFixed(1)}%, step ${phoneAlertStepPct.toFixed(
      1,
    )}%, confirm ${phoneAlertConfirmRefreshes} refreshes.`,
  );
  schedulePhoneAlertCheck(1000);
}

function schedulePhoneAlertCheck(delayMs) {
  phoneAlertState.timer = setTimeout(runPhoneAlertCheck, delayMs);
}

async function runPhoneAlertCheck() {
  try {
    const snapshot = await getSnapshotCached();
    await evaluatePhoneAlert(snapshot);
  } catch (error) {
    phoneAlertState.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    schedulePhoneAlertCheck(phoneAlertCheckMs);
  }
}

async function evaluatePhoneAlert(snapshot) {
  const theoretical = findTheoreticalNavView(snapshot);
  const levels = findTheorySpreadAlertLevels(theoretical?.discount);

  if (!levels.length) {
    phoneAlertState.active = false;
    phoneAlertState.notifiedLevelKeys.clear();
    phoneAlertState.pendingLevelCounts.clear();
    return;
  }

  const confirmedLevelKeys = updatePendingLevelCounts(levels);
  const newLevels = levels.filter(
    (level) => confirmedLevelKeys.has(level.key) && !phoneAlertState.notifiedLevelKeys.has(level.key),
  );
  if (!newLevels.length) {
    phoneAlertState.active = true;
    return;
  }

  const productPrice = snapshot.quotes?.product?.price;
  const officialNav = snapshot.officialNav || {};
  phoneAlertState.active = true;

  for (const level of newLevels) {
    const directionText = level.direction === "discount" ? "折价" : "溢价";
    const title = `7709 理论NAV${directionText}达到 ${level.levelPct.toFixed(0)}%`;
    const body = [
      `当前${directionText}: ${formatPercentServer(theoretical.discount)}`,
      `7709 ${formatServerMoney(productPrice)}`,
      `理论 NAV ${formatServerMoney(theoretical.value)}`,
      `官方 NAV ${formatServerMoney(officialNav.hkdNav)}${officialNav.date ? `（${officialNav.date}）` : ""}`,
      `触发档位: ${directionText}${level.levelPct.toFixed(0)}%`,
      `时间 ${timeInZone(Date.now(), "Asia/Shanghai")}`,
    ].join("\n");

    const result = await sendPhoneAlert(title, body, {
      productPrice,
      theoreticalNav: theoretical.value,
      officialNav: officialNav.hkdNav,
      officialNavDate: officialNav.date,
      spread: theoretical.discount,
      direction: level.direction,
      levelPct: level.levelPct,
      generatedAt: snapshot.generatedAt,
    });

    phoneAlertState.lastSentAt = Date.now();
    phoneAlertState.lastResult = result;
    phoneAlertState.lastError = result.ok ? null : result.error || "phone alert send failed";
    if (result.ok) phoneAlertState.notifiedLevelKeys.add(level.key);
  }
}

function updatePendingLevelCounts(levels) {
  const currentKeys = new Set(levels.map((level) => level.key));
  for (const key of [...phoneAlertState.pendingLevelCounts.keys()]) {
    if (!currentKeys.has(key)) phoneAlertState.pendingLevelCounts.delete(key);
  }

  for (const level of levels) {
    const count = phoneAlertState.pendingLevelCounts.get(level.key) || 0;
    phoneAlertState.pendingLevelCounts.set(level.key, count + 1);
  }

  const required = Math.max(1, Math.floor(phoneAlertConfirmRefreshes));
  return new Set(
    [...phoneAlertState.pendingLevelCounts.entries()]
      .filter(([, count]) => count >= required)
      .map(([key]) => key),
  );
}

function findTheoreticalNavView(snapshot) {
  return (snapshot.navViews || []).find((nav) => nav.id === "theoretical") || null;
}

function findTheorySpreadAlertLevels(spread) {
  if (!isFiniteNumber(spread)) return [];
  const direction = spread < 0 ? "discount" : "premium";
  const magnitudePct = Math.abs(spread * 100);
  if (magnitudePct < phoneAlertThresholdPct) return [];

  const stepPct = Math.max(0.1, phoneAlertStepPct);
  const levels = [];
  const maxIndex = Math.floor((magnitudePct - phoneAlertThresholdPct) / stepPct);
  for (let index = 0; index <= maxIndex; index += 1) {
    const levelPct = Number((phoneAlertThresholdPct + index * stepPct).toFixed(4));
    levels.push({
      direction,
      levelPct,
      key: `${direction}:${levelPct}`,
    });
  }
  return levels;
}

async function sendPhoneAlert(title, body, extra = {}) {
  if (!phoneAlertConfig.targets.length) {
    return { ok: false, error: "No phone alert channel configured", results: [] };
  }

  const results = [];
  for (const target of phoneAlertConfig.targets) {
    try {
      const result = await sendPhoneAlertToTarget(target, title, body, extra);
      results.push({ channel: target.name, ok: true, result });
    } catch (error) {
      results.push({
        channel: target.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: results.some((result) => result.ok),
    results,
    sentAt: new Date().toISOString(),
  };
}

async function sendPhoneAlertToTarget(target, title, body, extra) {
  if (target.type === "telegram") {
    return postJson(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
      chat_id: target.chatId,
      text: `${title}\n\n${body}`,
      disable_web_page_preview: true,
    });
  }

  if (target.type === "bark") {
    const url = `${target.url.replace(/\/$/, "")}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=7709&sound=alarm`;
    return fetchText(url, { method: "GET" });
  }

  if (target.type === "pushplus") {
    return postJson("https://www.pushplus.plus/send", {
      token: target.token,
      title,
      content: body,
      template: "txt",
    });
  }

  if (target.type === "serverchan") {
    const form = new URLSearchParams({ title, desp: body });
    return fetchText(`https://sctapi.ftqq.com/${target.sendKey}.send`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
  }

  if (target.type === "webhook") {
    return postJson(target.url, {
      type: "discount-alert",
      title,
      body,
      ...extra,
    });
  }

  throw new Error(`Unsupported alert target: ${target.type}`);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...fetchHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      ...fetchHeaders,
      ...(options.headers || {}),
    },
    ...options,
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

function startPreopenStrategyMonitor() {
  if (!preopenStrategyEnabled || !phoneAlertConfig.targets.length) return;
  if (preopenStrategyState.timer) return;
  console.log(`Pre-open strategy report enabled at ${preopenStrategyTime} ${preopenStrategyTimezone}.`);
  schedulePreopenStrategyCheck(5000);
}

function schedulePreopenStrategyCheck(delayMs) {
  preopenStrategyState.timer = setTimeout(runPreopenStrategyCheck, delayMs);
}

async function runPreopenStrategyCheck() {
  try {
    const today = dateInZone(Date.now(), preopenStrategyTimezone);
    const now = Date.now();
    const hhmm = timeInZone(now, preopenStrategyTimezone).slice(0, 5);
    if (
      isWeekdayInZone(now, preopenStrategyTimezone) &&
      compareHhmm(hhmm, preopenStrategyTime) >= 0 &&
      compareHhmm(hhmm, preopenStrategyUntil) <= 0 &&
      preopenStrategyState.lastSentDate !== today
    ) {
      const report = await buildPreopenStrategyReport();
      const result = await sendPreopenStrategyReport(report, false);
      preopenStrategyState.lastReport = report;
      preopenStrategyState.lastError = result.ok ? null : result.error || "preopen strategy push failed";
      if (result.ok) preopenStrategyState.lastSentDate = today;
    }
  } catch (error) {
    preopenStrategyState.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    schedulePreopenStrategyCheck(60 * 1000);
  }
}

function compareHhmm(left, right) {
  return minutesOfDay(left) - minutesOfDay(right);
}

function minutesOfDay(value) {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

function isWeekdayInZone(timestamp, timeZone) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(timestamp));
  return weekday !== "Sat" && weekday !== "Sun";
}

async function buildPreopenStrategyReport() {
  const [snapshot, market, news] = await Promise.all([
    getSnapshotCached(),
    fetchStrategyMarketContext(),
    fetchStrategyNews(),
  ]);
  return composePreopenStrategy(snapshot, market, news);
}

async function sendPreopenStrategyReport(report, isTest) {
  const title = `${isTest ? "测试 " : ""}7709 开盘策略 ${report.tradeDate}`;
  return sendPhoneAlert(title, formatPreopenStrategyText(report), {
    type: "preopen-strategy",
    report,
  });
}

async function fetchStrategyMarketContext() {
  const symbols = [
    ["^IXIC", "纳指"],
    ["^SOX", "费半"],
    ["SMH", "半导体ETF SMH"],
    ["SOXX", "半导体ETF SOXX"],
    ["NVDA", "英伟达"],
    ["SKHYV", "海力士ADR WI"],
    ["SKHY", "海力士ADR"],
    ["KRW=X", "USD/KRW"],
  ];
  const rows = await Promise.all(
    symbols.map(async ([symbol, label]) => {
      try {
        const chart = await fetchYahooChart(symbol, "5d", "1d");
        const quote = extractDailyCloseQuote(chart, symbol);
        return { symbol, label, price: quote.price, changePercent: quote.changePercent, source: "Yahoo chart" };
      } catch (error) {
        return { symbol, label, price: null, changePercent: null, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return rows;
}

async function fetchStrategyNews() {
  const feeds = [
    {
      url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=000660.KS,NVDA,MU,AMD&region=US&lang=en-US",
      query: "Yahoo Finance semiconductors",
    },
    {
      url: `https://news.google.com/rss/search?q=${encodeURIComponent("SK hynix HBM Nvidia AI memory")}&hl=en-US&gl=US&ceid=US:en`,
      query: "SK hynix HBM Nvidia AI memory",
    },
    {
      url: `https://news.google.com/rss/search?q=${encodeURIComponent("SK hynix ADR Nasdaq SKHY")}&hl=en-US&gl=US&ceid=US:en`,
      query: "SK hynix ADR Nasdaq SKHY",
    },
    {
      url: `https://news.google.com/rss/search?q=${encodeURIComponent("memory chip DRAM semiconductor AI demand")}&hl=en-US&gl=US&ceid=US:en`,
      query: "memory chip DRAM semiconductor AI demand",
    },
  ];
  const allItems = [];
  for (const feed of feeds) {
    try {
      const xml = await fetchRssText(feed.url);
      allItems.push(...parseRssItems(xml).map((item) => ({ ...item, query: feed.query })));
    } catch {
      // News is useful context, not a hard dependency for the trading report.
    }
  }

  const seen = new Set();
  return allItems
    .filter((item) => {
      const key = item.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

async function fetchRssText(url) {
  try {
    return await fetchText(url, {
      headers: { accept: "application/rss+xml,text/xml,*/*" },
    });
  } catch {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri $env:RSS_URL -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0'; 'Accept'='application/rss+xml,text/xml,*/*'}).Content",
      ],
      {
        timeout: 20000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, RSS_URL: url },
      },
    );
    return stdout;
  }
}

function composePreopenStrategy(snapshot, market, news) {
  const product = snapshot.quotes?.product || {};
  const underlying = snapshot.quotes?.underlying || {};
  const theoretical = findTheoreticalNavView(snapshot);
  const premium = theoretical?.discount;
  const newsScore = scoreNews(news);
  const marketScore = scoreMarket(market);
  const spreadScore = scoreSpread(premium);
  const totalScore = clamp(newsScore.score + marketScore.score + spreadScore.score, -6, 6);
  const bias = totalScore >= 3 ? "偏强，等回落低吸/顺势T" : totalScore <= -3 ? "偏弱，优先降仓/反弹T" : "中性，等折溢价给信号";
  const action = buildStrategyAction({ premium, totalScore, product, theoretical, underlying });

  return {
    tradeDate: dateInZone(Date.now(), "Asia/Hong_Kong"),
    generatedAt: new Date().toISOString(),
    bias,
    totalScore,
    scores: {
      news: newsScore,
      market: marketScore,
      spread: spreadScore,
    },
    levels: action,
    snapshot: {
      productPrice: product.price,
      theoreticalNav: theoretical?.value ?? null,
      spreadToTheory: premium ?? null,
      officialNav: snapshot.officialNav?.hkdNav ?? null,
      officialNavDate: snapshot.officialNav?.date ?? null,
      underlyingPrice: underlying.price,
      underlyingSession: underlying.session,
      underlyingChangePercent: underlying.changePercent,
      underlyingRegularChangePercent: underlying.regularChangePercent,
      underlyingExtendedChangePercent: underlying.extendedChangePercent,
    },
    market: market
      .filter((item) => !item.error && isFiniteNumber(item.price) && isFiniteNumber(item.changePercent))
      .slice(0, 8),
    news: news.slice(0, 6),
    disclaimer: "这是基于公开行情/新闻的交易预案，不是确定性买卖建议；开盘后以实时折溢价和成交量确认。",
  };
}

function buildStrategyAction({ premium, totalScore, product, theoretical, underlying }) {
  const spreadPct = isFiniteNumber(premium) ? premium * 100 : null;
  const nav = theoretical?.value;
  const productPrice = product?.price;
  const fairPrice = isFiniteNumber(nav) ? nav : null;
  const buyZone =
    isFiniteNumber(fairPrice) && totalScore >= 0
      ? `${formatServerMoney(fairPrice * 0.975)} 以下分批，${formatServerMoney(fairPrice * 0.965)} 加一档`
      : isFiniteNumber(fairPrice)
        ? `${formatServerMoney(fairPrice * 0.965)} 以下才考虑，弱势不追`
        : "--";
  const sellZone = isFiniteNumber(fairPrice)
    ? `${formatServerMoney(fairPrice * 1.015)} 至 ${formatServerMoney(fairPrice * 1.03)} 分批做T`
    : "--";

  const openPlan =
    isFiniteNumber(spreadPct) && spreadPct >= 2
      ? "开盘若仍溢价，先不追；冲高优先卖出做T，等回落到理论NAV附近再接。"
      : isFiniteNumber(spreadPct) && spreadPct <= -2
        ? "开盘若仍折价，观察成交量和正股方向，企稳后分批接回，不一次打满。"
        : "折溢价不极端，先看前15分钟方向，围绕理论NAV做小仓T。";

  return {
    openPlan,
    buyZone,
    sellZone,
    stopRule:
      isFiniteNumber(underlying?.changePercent) && underlying.changePercent < -0.03
        ? "正股弱于 -3%，7709 不做逆势加仓；跌破开盘低点优先收缩仓位。"
        : "若7709跌破开盘后15分钟低点且正股同步走弱，停止加仓，先保留现金。",
    referencePrice: productPrice,
    fairPrice,
    spreadPct,
  };
}

function scoreSpread(spread) {
  if (!isFiniteNumber(spread)) return { score: 0, reason: "折溢价不可用" };
  const pct = spread * 100;
  if (pct <= -3) return { score: 2, reason: `理论NAV折价 ${pct.toFixed(2)}%，偏向低吸机会` };
  if (pct <= -1.5) return { score: 1, reason: `理论NAV小幅折价 ${pct.toFixed(2)}%` };
  if (pct >= 3) return { score: -2, reason: `理论NAV溢价 ${pct.toFixed(2)}%，追高风险偏大` };
  if (pct >= 1.5) return { score: -1, reason: `理论NAV小幅溢价 ${pct.toFixed(2)}%` };
  return { score: 0, reason: `折溢价 ${pct.toFixed(2)}%，不极端` };
}

function scoreMarket(market) {
  const important = market.filter((item) => ["^SOX", "SMH", "SOXX", "NVDA", "^IXIC"].includes(item.symbol));
  const score = clamp(
    important.reduce((sum, item) => {
      if (!isFiniteNumber(item.changePercent)) return sum;
      if (item.changePercent > 0.025) return sum + 1;
      if (item.changePercent < -0.025) return sum - 1;
      return sum;
    }, 0),
    -3,
    3,
  );
  const reason = important
    .filter((item) => isFiniteNumber(item.changePercent))
    .map((item) => `${item.label}${formatPercentServer(item.changePercent)}`)
    .join("，");
  return { score, reason: reason || "美股半导体情绪不可用" };
}

function scoreNews(news) {
  const positiveWords = ["hbm", "ai", "nvidia", "demand", "upgrade", "record", "surge", "beat", "supply", "nasdaq"];
  const negativeWords = ["tariff", "restriction", "probe", "delay", "downgrade", "weak", "falls", "selloff", "ban"];
  let raw = 0;
  const hits = [];
  for (const item of news) {
    const title = item.title.toLowerCase();
    const positive = positiveWords.some((word) => title.includes(word));
    const negative = negativeWords.some((word) => title.includes(word));
    if (positive) raw += 1;
    if (negative) raw -= 1;
    if (positive || negative) hits.push(item.title);
  }
  return {
    score: clamp(raw, -2, 2),
    reason: hits.slice(0, 3).join("；") || "未抓到明显新闻催化",
  };
}

function formatPreopenStrategyText(report) {
  const s = report.snapshot;
  const lines = [
    `方向: ${report.bias}（评分 ${report.totalScore}）`,
    `7709 ${formatServerMoney(s.productPrice)} / 理论NAV ${formatServerMoney(s.theoreticalNav)} / 折溢价 ${formatPercentServer(s.spreadToTheory)}`,
    `正股 ${s.underlyingSession || ""} ${formatServerMoneyKrw(s.underlyingPrice)}，涨跌 ${formatPercentServer(s.underlyingChangePercent)}`,
    `开盘计划: ${report.levels.openPlan}`,
    `低吸区: ${report.levels.buyZone}`,
    `做T卖出区: ${report.levels.sellZone}`,
    `风控: ${report.levels.stopRule}`,
    `情绪: ${report.scores.market.reason}`,
    `新闻: ${report.scores.news.reason}`,
    report.disclaimer,
  ];
  return lines.join("\n");
}

function parseRssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const block = match[1];
    return {
      title: decodeXml(extractXmlTag(block, "title")),
      link: decodeXml(extractXmlTag(block, "link")),
      pubDate: decodeXml(extractXmlTag(block, "pubDate")),
    };
  }).filter((item) => item.title);
}

function extractXmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "") : "";
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function formatServerMoneyKrw(value) {
  return isFiniteNumber(value) ? `${Math.round(value).toLocaleString("en-US")} KRW` : "--";
}

async function buildSnapshot() {
  const [
    navResult,
    productIntraday,
    hynixIntraday,
    hynixDaily,
    fxIntraday,
    fxDaily,
  ] = await Promise.all([
    fetchOfficialNav(),
    fetchProductIntraday(),
    fetchHynixIntraday(),
    fetchHynixDaily(),
    fetchKrwHkdChart("5d", "5m"),
    fetchKrwHkdChart("1mo", "1d"),
  ]);

  const productQuote = normalizeProductQuote(productIntraday);
  const officialNav = normalizeOfficialNav(navResult);
  const hynixDailyPoints = normalizeHynixDailyPoints(hynixDaily);
  const hynixQuote = normalizeHynixQuote(hynixIntraday, hynixDailyPoints);
  const fxQuote = extractQuote(fxIntraday, "KRWHKD=X");
  const fxDailyPoints = extractSeries(fxDaily, "UTC");

  const anchorUnderlying = findPointOnDate(hynixDailyPoints, officialNav.date);
  const anchorFx = findPointOnOrBefore(fxDailyPoints, officialNav.date);
  const fxRatio =
    anchorFx?.close && fxQuote.price ? clamp(fxQuote.price / anchorFx.close, 0.9, 1.1) : 1;

  const rollingNoFx = computeRollingNav({
    baseNav: officialNav.hkdNav,
    baseDate: officialNav.date,
    baseUnderlying: anchorUnderlying?.close,
    currentUnderlying: hynixQuote.price,
    currentTimestamp: hynixQuote.timestamp,
    dailyPoints: hynixDailyPoints,
    leverage: 2,
    fxRatio: 1,
  });

  const rollingWithFx = computeRollingNav({
    baseNav: officialNav.hkdNav,
    baseDate: officialNav.date,
    baseUnderlying: anchorUnderlying?.close,
    currentUnderlying: hynixQuote.price,
    currentTimestamp: hynixQuote.timestamp,
    dailyPoints: hynixDailyPoints,
    leverage: 2,
    fxRatio,
  });

  const simpleNoFx = computeSimpleNav({
    baseNav: officialNav.hkdNav,
    baseUnderlying: anchorUnderlying?.close,
    currentUnderlying: hynixQuote.price,
    leverage: 2,
    fxRatio: 1,
  });

  const productPrice = productQuote.price;
  const theoretical = rollingWithFx.value ?? rollingNoFx.value ?? simpleNoFx;
  const theoreticalSeries =
    rollingWithFx.steps?.[0]?.type === "official-anchor-current"
      ? buildFlatSeries(hynixQuote.points, theoretical)
      : buildTheoreticalIntradaySeries({
          baseNav: officialNav.hkdNav,
          baseUnderlying: anchorUnderlying?.close,
          underlyingPoints: hynixQuote.points,
          leverage: 2,
          fxRatio,
        });
  const navViews = buildNavViews({
    officialNav,
    theoretical,
    theoreticalNoFx: rollingNoFx.value ?? simpleNoFx,
    productPrice,
  });

  return {
    generatedAt: new Date().toISOString(),
    refreshMs: 30000,
    phoneAlert: publicPhoneAlertStatus(),
    product: {
      name: "南方东英 SK 海力士每日杠杆(2x)产品",
      ticker: "7709.HK",
      officialName: PRODUCT_NAME,
    },
    officialNav,
    navViews,
    quotes: {
      product: productQuote,
      underlying: hynixQuote,
      fx: fxQuote,
    },
    calculation: {
      method: "CSOP official HKD NAV anchor x daily 2x rolling SK hynix returns x KRW/HKD FX ratio",
      leverage: 2,
      anchorUnderlying,
      anchorFx,
      fxRatio,
      theoreticalNav: theoretical,
      theoreticalNavNoFx: rollingNoFx.value ?? simpleNoFx,
      theoreticalNavSimpleNoFx: simpleNoFx,
      steps: rollingWithFx.steps,
      warnings: [
        "官方 NAV 来自 CSOP，通常为上一交易日或最近交易日。",
        "7709 行情优先来自腾讯港股实时源；000660.KS 盘中行情优先来自 Naver Pay Securities，韩国常规盘收后若 Naver 提供盘后/NXT 价格则继续用于交易口径理论 NAV。",
        "理论 NAV 是本地估算，不等于 CSOP/ICE/FactSet 发布的 iNAV。",
      ],
    },
    metrics: {
      discountToTheory: ratio(productPrice, theoretical),
      discountToTheoryNoFx: ratio(productPrice, rollingNoFx.value ?? simpleNoFx),
      discountToOfficial: ratio(productPrice, officialNav.hkdNav),
      productDayChangePct: productQuote.changePercent,
      underlyingDayChangePct: hynixQuote.changePercent,
      estimatedLeverageToday:
        isFiniteNumber(productQuote.changePercent) && isFiniteNumber(hynixQuote.changePercent)
          ? productQuote.changePercent / hynixQuote.changePercent
          : null,
    },
    series: {
      product: productQuote.points,
      theoretical: theoreticalSeries,
      underlying: hynixQuote.points,
    },
    sources: [
      {
        name: "CSOP 官方产品页 / CMS API",
        url: CSOP_PRODUCT_URL,
        role: "官方 NAV 锚点",
      },
      {
        name: "Tencent HK quote",
        url: TENCENT_PRODUCT_PAGE,
        role:
          productQuote.source === "Tencent HK realtime"
            ? "7709.HK 最新价优先源"
            : "7709.HK 最新价源暂回退到 Yahoo Finance",
      },
      {
        name: "Naver Pay Securities / KRX",
        url: NAVER_HYNIX_PAGE,
        role:
          hynixQuote.source === "Naver Pay Securities"
          ? "000660.KS 正股分钟线及盘后/NXT 价格优先源"
            : "000660.KS 正股源暂回退到 Yahoo Finance",
      },
      {
        name: "Yahoo Finance chart endpoint",
        url: "https://query1.finance.yahoo.com/v8/finance/chart/7709.HK",
        role: "7709.HK 走势图/备用源、KRW/HKD 行情代理；000660.KS 备用源",
      },
    ],
  };
}

async function fetchOfficialNav() {
  const response = await fetch(CSOP_NAV_API, {
    method: "POST",
    headers: { ...fetchHeaders, "content-type": "application/json" },
    body: JSON.stringify({ productName: PRODUCT_NAME }),
  });

  if (!response.ok) {
    throw new Error(`CSOP NAV request failed: ${response.status}`);
  }

  return response.json();
}

async function fetchCsopIntradayNav() {
  try {
    const response = await fetch(CSOP_INTRADAY_NAV_URL, {
      headers: {
        ...fetchHeaders,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        referer: CSOP_PRODUCT_URL,
      },
      signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();

    if (!response.ok) {
      return unavailableNav(
        "csopIntraday",
        explainFactSetFetchFailure(`FactSet iframe HTTP ${response.status}`),
        CSOP_PRODUCT_URL,
        { rawUrl: CSOP_INTRADAY_NAV_URL },
      );
    }

    const parsed = parseCsopIntradayNav(html);
    if (!isFiniteNumber(parsed.value)) {
      return unavailableNav(
        "csopIntraday",
        explainFactSetFetchFailure("未能从 FactSet iframe 解析到 iNAV"),
        CSOP_PRODUCT_URL,
        { rawUrl: CSOP_INTRADAY_NAV_URL },
      );
    }

    return {
      id: "csopIntraday",
      label: "CSOP 盘中 iNAV",
      value: parsed.value,
      currency: "HKD",
      date: parsed.date,
      time: parsed.time,
      marketPrice: parsed.marketPrice,
      status: "ok",
      message: "来自 CSOP 官网嵌入的 FactSet/ICE 盘中预估净值",
      url: CSOP_PRODUCT_URL,
      rawUrl: CSOP_INTRADAY_NAV_URL,
    };
  } catch (error) {
    return unavailableNav(
      "csopIntraday",
      explainFactSetFetchFailure(error instanceof Error ? error.message : String(error)),
      CSOP_PRODUCT_URL,
      { rawUrl: CSOP_INTRADAY_NAV_URL },
    );
  }
}

async function fetchTradingViewNav() {
  try {
    const body = JSON.stringify({
      symbols: { tickers: [TRADINGVIEW_SYMBOL], query: { types: [] } },
      columns: TRADINGVIEW_COLUMNS,
    });
    const payload = await fetchTradingViewJson(body);
    const row = payload?.data?.find((item) => item?.s === TRADINGVIEW_SYMBOL) || payload?.data?.[0];
    const values = row?.d || [];
    const value = toNumber(values[TRADINGVIEW_COLUMNS.indexOf("nav")]);

    if (!isFiniteNumber(value)) {
      return unavailableNav("tradingViewNav", "TradingView scanner 未返回 nav 字段", "https://www.tradingview.com/symbols/HKEX-7709/");
    }

    return {
      id: "tradingViewNav",
      label: "TradingView NAV",
      value,
      currency: values[TRADINGVIEW_COLUMNS.indexOf("currency")] || "HKD",
      date: dateInZone(Date.now(), "Asia/Shanghai"),
      time: timeInZone(Date.now(), "Asia/Shanghai"),
      tvPrice: toNumber(values[TRADINGVIEW_COLUMNS.indexOf("close")]),
      navDiscountPremium: toNumber(values[TRADINGVIEW_COLUMNS.indexOf("nav_discount_premium")]),
      totalAssets: toNumber(values[TRADINGVIEW_COLUMNS.indexOf("total_assets")]),
      status: "ok",
      message: "来自 TradingView ETF scanner 的 nav 字段",
      url: "https://www.tradingview.com/symbols/HKEX-7709/",
    };
  } catch (error) {
    return unavailableNav(
      "tradingViewNav",
      error instanceof Error ? error.message : String(error),
      "https://www.tradingview.com/symbols/HKEX-7709/",
    );
  }
}

async function fetchTradingViewJson(body) {
  try {
    const response = await fetch(TRADINGVIEW_SCAN_API, {
      method: "POST",
      headers: {
        ...fetchHeaders,
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://www.tradingview.com",
        referer: "https://www.tradingview.com/",
      },
      body,
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } catch {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri $env:TV_SCAN_URL -Method POST -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0'; 'Accept'='application/json'; 'Content-Type'='application/json'; 'Origin'='https://www.tradingview.com'; 'Referer'='https://www.tradingview.com/'} -Body $env:TV_SCAN_BODY -ContentType 'application/json').Content",
      ],
      {
        timeout: 45000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, TV_SCAN_URL: TRADINGVIEW_SCAN_API, TV_SCAN_BODY: body },
      },
    );
    return JSON.parse(stdout);
  }
}

async function fetchProductIntraday() {
  try {
    const [quoteText, minutePayload] = await Promise.all([
      fetchTencentText(TENCENT_PRODUCT_QUOTE_API),
      fetchTencentJson(TENCENT_PRODUCT_MINUTE_API),
    ]);
    const quote = parseTencentProductQuote(quoteText);
    const points = parseTencentMinutePoints(minutePayload);

    if (!isFiniteNumber(quote.price)) throw new Error("Tencent quote missing price");

    return {
      source: "tencent",
      url: TENCENT_PRODUCT_PAGE,
      quote,
      points,
    };
  } catch (error) {
    return {
      source: "yahoo",
      url: "https://query1.finance.yahoo.com/v8/finance/chart/7709.HK",
      chart: await fetchYahooChart(PRODUCT_SYMBOL, "1d", "1m"),
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchTencentText(url) {
  const headers = {
    ...fetchHeaders,
    accept: "*/*",
    referer: TENCENT_PRODUCT_PAGE,
  };

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.text();
  } catch {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri $env:TENCENT_STOCK_URL -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0'; 'Accept'='*/*'; 'Referer'='https://gu.qq.com/hk07709'}).Content",
      ],
      {
        timeout: 10000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, TENCENT_STOCK_URL: url },
      },
    );
    return stdout;
  }
}

async function fetchTencentJson(url) {
  const text = await fetchTencentText(url);
  return JSON.parse(text);
}

async function fetchYahooChart(symbol, range, interval) {
  const query = new URLSearchParams({
    range,
    interval,
    includePrePost: "false",
    events: "div,splits",
  });

  let lastError = null;
  for (const host of YAHOO_CHART_HOSTS) {
    try {
      const payload = await fetchYahooJson(`${host}/${encodeURIComponent(symbol)}?${query}`);
      const result = payload?.chart?.result?.[0];
      if (!result) {
        const description = payload?.chart?.error?.description || "empty chart response";
        throw new Error(description);
      }

      return result;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Yahoo chart request failed for ${symbol}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function fetchYahooJson(url) {
  try {
    const response = await fetch(url, { headers: fetchHeaders, signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  } catch {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri $env:YAHOO_CHART_URL -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0'; 'Accept'='application/json'; 'Accept-Language'='en-US,en;q=0.9'}).Content",
      ],
      {
        timeout: 10000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, YAHOO_CHART_URL: url },
      },
    );
    return JSON.parse(stdout);
  }
}

async function fetchHynixIntraday() {
  const dates = recentCompactDatesInZone(Date.now(), "Asia/Seoul", 5);

  try {
    const extendedQuotePromise = fetchNaverHynixExtendedQuote().catch(() => null);
    let selectedUrl = null;
    let points = [];

    for (const date of dates) {
      const url = `${NAVER_HYNIX_CHART_API}/minute?startDateTime=${date}0900&endDateTime=${date}2359`;
      const rows = await fetchNaverJson(url);
      points = parseNaverMinutePoints(rows);
      if (points.length) {
        selectedUrl = url;
        break;
      }
    }

    if (!points.length) throw new Error("empty Naver minute chart");

    return {
      source: "naver",
      url: selectedUrl,
      points,
      extendedQuote: await extendedQuotePromise,
    };
  } catch (error) {
    return {
      source: "yahoo",
      url: "https://query1.finance.yahoo.com/v8/finance/chart/000660.KS",
      chart: await fetchYahooChart(HYNIX_SYMBOL, "1d", "1m"),
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchHynixDaily() {
  const start = compactDateInZone(Date.now() - 45 * 24 * 60 * 60 * 1000, "Asia/Seoul");
  const end = compactDateInZone(Date.now() + 24 * 60 * 60 * 1000, "Asia/Seoul");
  const url = `${NAVER_HYNIX_CHART_API}/day?startDateTime=${start}0000&endDateTime=${end}2359`;

  try {
    const rows = await fetchNaverJson(url);
    const points = parseNaverDailyPoints(rows);
    if (!points.length) throw new Error("empty Naver daily chart");

    return {
      source: "naver",
      url,
      points,
    };
  } catch (error) {
    return {
      source: "yahoo",
      url: "https://query1.finance.yahoo.com/v8/finance/chart/000660.KS",
      chart: await fetchYahooChart(HYNIX_SYMBOL, "1mo", "1d"),
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchNaverJson(url) {
  const headers = {
    ...fetchHeaders,
    accept: "application/json",
    referer: NAVER_HYNIX_PAGE,
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  } catch {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri $env:NAVER_STOCK_URL -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0'; 'Accept'='application/json'; 'Accept-Language'='ko-KR,ko;q=0.9,en-US;q=0.8'; 'Referer'='https://stock.naver.com/domestic/stock/000660/total'}).Content",
      ],
      {
        timeout: 10000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, NAVER_STOCK_URL: url },
      },
    );
    return JSON.parse(stdout);
  }
}

async function fetchNaverHynixExtendedQuote() {
  const html = await fetchNaverHtml(NAVER_HYNIX_MOBILE_PAGE);
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Naver mobile page missing __NEXT_DATA__");

  const payload = JSON.parse(match[1]);
  const queries = payload?.props?.pageProps?.dehydratedState?.queries || [];
  for (const query of queries) {
    const result = query?.state?.data?.result;
    if (result?.itemCode === NAVER_HYNIX_CODE && result?.overMarketPriceInfo) {
      return parseNaverExtendedQuote(result);
    }
  }

  throw new Error("Naver mobile page missing overMarketPriceInfo");
}

async function fetchNaverHtml(url) {
  const headers = {
    ...fetchHeaders,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    referer: NAVER_HYNIX_PAGE,
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.text();
  } catch {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri $env:NAVER_PAGE_URL -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0'; 'Accept'='text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'; 'Accept-Language'='ko-KR,ko;q=0.9,en-US;q=0.8'; 'Referer'='https://stock.naver.com/domestic/stock/000660/total'}).Content",
      ],
      {
        timeout: 15000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, NAVER_PAGE_URL: url },
      },
    );
    return stdout;
  }
}
async function fetchKrwHkdChart(range, interval) {
  try {
    return invertCurrencyChart(await fetchYahooChart("HKDKRW=X", range, interval));
  } catch {
    try {
      return await fetchYahooChart("KRWHKD=X", range, interval);
    } catch {
      return fallbackFxChart();
    }
  }
}

function invertCurrencyChart(chart) {
  const quote = chart.indicators?.quote?.[0] || {};
  const invert = (value) => (isFiniteNumber(toNumber(value)) && Number(value) !== 0 ? 1 / Number(value) : null);
  const invertedQuote = {
    ...quote,
    open: (quote.open || []).map(invert),
    close: (quote.close || []).map(invert),
    high: (quote.low || []).map(invert),
    low: (quote.high || []).map(invert),
  };

  return {
    ...chart,
    meta: {
      ...(chart.meta || {}),
      currency: "HKD",
      symbol: "KRWHKD=X",
      longName: "KRW/HKD",
      shortName: "KRW/HKD",
      regularMarketPrice: invert(chart.meta?.regularMarketPrice),
      previousClose: invert(chart.meta?.previousClose),
      chartPreviousClose: invert(chart.meta?.chartPreviousClose),
      regularMarketDayHigh: invert(chart.meta?.regularMarketDayLow),
      regularMarketDayLow: invert(chart.meta?.regularMarketDayHigh),
    },
    indicators: {
      ...(chart.indicators || {}),
      quote: [invertedQuote],
    },
  };
}

function fallbackFxChart() {
  return {
    meta: {
      currency: "HKD",
      symbol: "KRWHKD=X",
      longName: "KRW/HKD",
      shortName: "KRW/HKD",
      regularMarketPrice: null,
      previousClose: null,
      regularMarketTime: Math.floor(Date.now() / 1000),
    },
    timestamp: [],
    indicators: { quote: [{ close: [] }] },
  };
}

function parseCsopIntradayNav(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  const sectionStart = text.search(/Intra-day Estimated NAV/i);
  const section = sectionStart >= 0 ? text.slice(sectionStart, sectionStart + 1200) : text.slice(0, 1200);
  const value = toNumber(section.match(/(?:HKD|HK\$)\s*([0-9][0-9,]*\.[0-9]{3,6})/i)?.[1]?.replace(/,/g, ""))
    ?? toNumber(section.match(/Intra-day Estimated NAV[^0-9]+(?:\d{1,2}\s+[A-Za-z]{3}\s+\d{4})?[^0-9]+(?:\d{1,2}:\d{2}\s*[AP]M)?[^0-9]+([0-9][0-9,]*\.[0-9]{3,6})/i)?.[1]?.replace(/,/g, ""));
  const marketSection = section.match(/Intra-day Market Price[\s\S]{0,300}/i)?.[0] || "";
  const marketPrice = toNumber(marketSection.match(/([0-9][0-9,]*\.[0-9]{2,6})/)?.[1]?.replace(/,/g, ""));

  return {
    value,
    marketPrice,
    date: section.match(/\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/)?.[0] || null,
    time: section.match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || null,
  };
}

function unavailableNav(id, message, url, extra = {}) {
  return {
    id,
    label: id === "tradingViewNav" ? "TradingView NAV" : "CSOP 盘中 iNAV",
    value: null,
    currency: "HKD",
    date: null,
    time: null,
    status: "unavailable",
    message,
    url,
    ...extra,
  };
}

function explainFactSetFetchFailure(detail) {
  return `${detail}；该 iNAV 位于 CSOP 官网内嵌的 FactSet 跨域组件里，浏览器可以显示，但本地服务直连可能缺少会话/来源校验，前端脚本也不能跨域读取 iframe 内容`;
}

function buildNavViews({
  officialNav,
  theoretical,
  theoreticalNoFx,
  productPrice,
}) {
  const theoreticalStatus = isFiniteNumber(theoretical) ? "ok" : "unavailable";

  return [
    {
      id: "official",
      label: "官方 NAV",
      shortLabel: "官方",
      value: officialNav.hkdNav,
      sourceValue: officialNav.hkdNav,
      modelValue: null,
      currency: "HKD",
      date: officialNav.date,
      time: null,
      status: "ok",
      mode: "official-daily",
      source: "CSOP CMS API",
      note: "正式每日净值，通常是上一交易日/最近交易日",
      discount: ratio(productPrice, officialNav.hkdNav),
    },
    {
      id: "theoretical",
      label: "理论 NAV",
      shortLabel: "理论",
      value: theoretical,
      sourceValue: null,
      modelValue: theoretical,
      currency: "HKD",
      date: dateInZone(Date.now(), "Asia/Shanghai"),
      time: timeInZone(Date.now(), "Asia/Shanghai"),
      status: theoreticalStatus,
      mode: "rolling-from-official",
      source: "本地估算",
      note: `以最新官方 NAV 为锚点；若官方日期已等于正股当前交易日，常规盘内不重复滚动，常规盘后/NXT 继续按正股盘后价估算。不含汇率为 ${formatServerMoney(theoreticalNoFx)}`,
      discount: ratio(productPrice, theoretical),
    },
  ];
}

function normalizeOfficialNav(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data || payload?.value || [];
  const hkd = rows.find((row) => row.Currency === "HKD");
  const usd = rows.find((row) => row.Currency === "USD");

  if (!hkd?.NAV) {
    throw new Error("CSOP NAV response did not include HKD NAV");
  }

  return {
    hkdNav: Number(hkd.NAV),
    usdNav: usd?.NAV ? Number(usd.NAV) : null,
    date: hkd.HstDateFormat || normalizeDate(hkd.HstDate),
    dateLabel: hkd.HstDate || hkd.HstDateTc || hkd.HstDateFormat || "",
    closePrice: toNumber(hkd.closePrice),
    navChange: hkd.NAVChange || null,
    closePriceChange: hkd.cloesePriceChange || hkd.closePriceChange || null,
    shares: toNumber(hkd.Shares),
    aum: toNumber(hkd.AUM),
    raw: hkd,
  };
}

function normalizeProductQuote(source) {
  if (source?.source !== "tencent") return extractQuote(source?.chart || source, PRODUCT_SYMBOL);

  const quote = source.quote || {};
  const points = source.points || [];
  const latest = points.at(-1);
  const price = quote.price ?? latest?.close ?? null;
  const previousClose = quote.previousClose;

  return {
    symbol: PRODUCT_SYMBOL,
    name: quote.name || "CSOP SK Hynix Daily (2x) Leveraged Product",
    currency: "HKD",
    exchange: "Tencent HK realtime / HKEX",
    timezone: "Asia/Hong_Kong",
    price,
    previousClose,
    change:
      isFiniteNumber(quote.change) ? quote.change : isFiniteNumber(price) && isFiniteNumber(previousClose) ? price - previousClose : null,
    changePercent:
      isFiniteNumber(quote.changePercent) ? quote.changePercent : ratio(price, previousClose),
    dayHigh: quote.dayHigh ?? maxFinite(points.map((point) => point.high ?? point.close)),
    dayLow: quote.dayLow ?? minFinite(points.map((point) => point.low ?? point.close)),
    volume: quote.volume ?? latest?.volume ?? null,
    turnover: quote.turnover ?? latest?.turnover ?? null,
    timestamp: quote.timestamp ?? latest?.t ?? null,
    points: points.length ? points : [],
    source: "Tencent HK realtime",
    url: source.url || TENCENT_PRODUCT_PAGE,
  };
}

function parseTencentProductQuote(text) {
  const raw = String(text || "").match(/="([^"]*)"/)?.[1] || "";
  const fields = raw.split("~");
  const timestamp = parseHongKongDateTime(fields[30]);
  const price = toNumber(fields[35]) ?? toNumber(fields[3]);
  const previousClose = toNumber(fields[4]);

  return {
    name: fields[1] || "7709",
    code: fields[2] || "07709",
    price,
    previousClose,
    open: toNumber(fields[5]),
    change: toNumber(fields[31]),
    changePercent: isFiniteNumber(toNumber(fields[32])) ? toNumber(fields[32]) / 100 : ratio(price, previousClose),
    dayHigh: toNumber(fields[33]),
    dayLow: toNumber(fields[34]),
    volume: toNumber(fields[36]) ?? toNumber(fields[6]),
    turnover: toNumber(fields[37]),
    timestamp,
  };
}

function parseTencentMinutePoints(payload) {
  const node = payload?.data?.[TENCENT_PRODUCT_CODE]?.data;
  const date = String(node?.date || "");
  if (!/^\d{8}$/.test(date) || !Array.isArray(node?.data)) return [];

  return node.data
    .map((item) => {
      const [hhmm, close, volume, turnover] = String(item).trim().split(/\s+/);
      if (!/^\d{4}$/.test(hhmm)) return null;
      return {
        t: parseHongKongCompactDateTime(date, hhmm),
        close: toNumber(close),
        volume: toNumber(volume),
        turnover: toNumber(turnover),
      };
    })
    .filter((point) => point && isFiniteNumber(point.t) && isFiniteNumber(point.close))
    .sort((a, b) => a.t - b.t);
}

function parseHongKongCompactDateTime(date, hhmm) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2, 4));
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0);
}

function parseHongKongDateTime(value) {
  const match = String(value || "").match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

function normalizeHynixDailyPoints(source) {
  if (source?.source === "naver") return source.points;
  return extractSeries(source?.chart || source, "Asia/Seoul");
}

function normalizeHynixQuote(source, dailyPoints) {
  if (source?.source !== "naver") return extractQuote(source?.chart || source, HYNIX_SYMBOL);

  const points = source.points || [];
  const latest = points.at(-1);
  const currentDate = latest ? dateInZone(latest.t, "Asia/Seoul") : null;
  const dayPoint = dailyPoints.find((point) => point.date === currentDate) || null;
  const previousClose = findPreviousClose(dailyPoints, currentDate);
  const extendedQuote = normalizeNaverExtendedQuote(source.extendedQuote, latest, dayPoint);
  const regularPrice = latest?.close ?? dayPoint?.close ?? null;
  const regularChange =
    isFiniteNumber(regularPrice) && isFiniteNumber(previousClose) ? regularPrice - previousClose : null;
  const price = extendedQuote?.price ?? latest?.close ?? dayPoint?.close ?? null;
  const change = isFiniteNumber(price) && isFiniteNumber(previousClose) ? price - previousClose : null;
  const dayHigh = dayPoint?.high ?? maxFinite(points.map((point) => point.high));
  const dayLow = dayPoint?.low ?? minFinite(points.map((point) => point.low));
  const volume = dayPoint?.volume ?? sumFinite(points.map((point) => point.volume));
  const quotePoints = appendExtendedPoint(points, extendedQuote).slice(-390);

  return {
    symbol: HYNIX_SYMBOL,
    name: "SK hynix",
    currency: "KRW",
    exchange: extendedQuote ? "Naver Pay Securities / KRX+NXT" : "Naver Pay Securities / KRX",
    timezone: "Asia/Seoul",
    price,
    previousClose,
    change,
    changePercent: ratio(price, previousClose),
    regularPrice,
    regularChange,
    regularChangePercent: ratio(regularPrice, previousClose),
    regularTimestamp: latest?.t ?? dayPoint?.t ?? null,
    extendedPrice: extendedQuote?.price ?? null,
    extendedChange: extendedQuote
      ? isFiniteNumber(extendedQuote.price) && isFiniteNumber(previousClose)
        ? extendedQuote.price - previousClose
        : null
      : null,
    extendedChangePercent: extendedQuote ? ratio(extendedQuote.price, previousClose) : null,
    extendedTimestamp: extendedQuote?.timestamp ?? null,
    dayHigh,
    dayLow,
    volume,
    timestamp: extendedQuote?.timestamp ?? latest?.t ?? dayPoint?.t ?? null,
    session: extendedQuote?.session || "KRX 常规盘",
    points: quotePoints,
    source: "Naver Pay Securities",
    url: source.url || NAVER_HYNIX_PAGE,
  };
}

function parseNaverExtendedQuote(result) {
  const info = result?.overMarketPriceInfo;
  if (!info) return null;

  const price = toNumber(info.overPrice);
  const timestamp = parseNaverIsoDateTime(info.localTradedAt);
  if (!isFiniteNumber(price) || !isFiniteNumber(timestamp)) return null;

  return {
    price,
    timestamp,
    sessionType: info.tradingSessionType || null,
    status: info.overMarketStatus || null,
    compareToPreviousClosePrice: toNumber(info.compareToPreviousClosePrice),
    fluctuationsRatio: toNumber(info.fluctuationsRatio),
    localTradedAt: info.localTradedAt || null,
  };
}

function normalizeNaverExtendedQuote(extendedQuote, latest, dayPoint) {
  if (!extendedQuote) return null;
  const latestTimestamp = latest?.t ?? dayPoint?.t ?? null;
  if (!isFiniteNumber(extendedQuote.price) || !isFiniteNumber(extendedQuote.timestamp)) return null;
  if (isFiniteNumber(latestTimestamp) && extendedQuote.timestamp <= latestTimestamp) return null;

  const session =
    extendedQuote.sessionType === "AFTER_MARKET"
      ? "NXT/盘后"
      : extendedQuote.sessionType === "PRE_MARKET"
        ? "NXT/盘前"
        : "NXT";

  return {
    ...extendedQuote,
    session,
  };
}

function appendExtendedPoint(points, extendedQuote) {
  if (!extendedQuote) return points.slice();
  const filtered = points.filter((point) => point.t < extendedQuote.timestamp);
  return [
    ...filtered,
    {
      t: extendedQuote.timestamp,
      close: extendedQuote.price,
      open: extendedQuote.price,
      high: extendedQuote.price,
      low: extendedQuote.price,
      volume: null,
    },
  ];
}

function parseNaverMinutePoints(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      t: parseNaverKstDateTime(row.localDateTime),
      close: toNumber(row.currentPrice),
      open: toNumber(row.openPrice),
      high: toNumber(row.highPrice),
      low: toNumber(row.lowPrice),
      volume: toNumber(row.accumulatedTradingVolume),
    }))
    .filter((point) => isFiniteNumber(point.t) && isFiniteNumber(point.close))
    .sort((a, b) => a.t - b.t);
}

function parseNaverDailyPoints(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      date: normalizeNaverLocalDate(row.localDate),
      t: parseNaverKstDate(row.localDate),
      close: toNumber(row.closePrice),
      open: toNumber(row.openPrice),
      high: toNumber(row.highPrice),
      low: toNumber(row.lowPrice),
      volume: toNumber(row.accumulatedTradingVolume),
    }))
    .filter((point) => point.date && isFiniteNumber(point.t) && isFiniteNumber(point.close))
    .sort((a, b) => a.t - b.t);
}

function parseNaverKstDateTime(value) {
  const text = String(value || "");
  if (!/^\d{14}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const hour = Number(text.slice(8, 10));
  const minute = Number(text.slice(10, 12));
  const second = Number(text.slice(12, 14));
  return Date.UTC(year, month - 1, day, hour - 9, minute, second);
}

function parseNaverKstDate(value) {
  const text = String(value || "");
  if (!/^\d{8}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  return Date.UTC(year, month - 1, day, 15 - 9, 30, 0);
}

function parseNaverIsoDateTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeNaverLocalDate(value) {
  const text = String(value || "");
  if (!/^\d{8}$/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function findPreviousClose(points, currentDate) {
  let found = null;
  for (const point of points || []) {
    if (!currentDate || point.date < currentDate) found = point.close;
  }
  return found;
}

function maxFinite(values) {
  const numbers = values.filter(isFiniteNumber);
  return numbers.length ? Math.max(...numbers) : null;
}

function minFinite(values) {
  const numbers = values.filter(isFiniteNumber);
  return numbers.length ? Math.min(...numbers) : null;
}

function sumFinite(values) {
  const numbers = values.filter(isFiniteNumber);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function extractDailyCloseQuote(chart, symbol) {
  const meta = chart.meta || {};
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const points = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const close = toNumber(closes[i]);
    if (!isFiniteNumber(close)) continue;
    points.push({
      t: timestamps[i] * 1000,
      close,
    });
  }

  const latest = points.at(-1);
  const previous = points.at(-2);
  const price = latest?.close ?? toNumber(meta.regularMarketPrice) ?? null;
  const previousClose = previous?.close ?? toNumber(meta.previousClose) ?? null;

  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || "",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    timezone: meta.exchangeTimezoneName || meta.timezone || "",
    price,
    previousClose,
    change: isFiniteNumber(price) && isFiniteNumber(previousClose) ? price - previousClose : null,
    changePercent: ratio(price, previousClose),
    timestamp: latest?.t ?? null,
  };
}

function extractQuote(chart, symbol) {
  const meta = chart.meta || {};
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const volumes = quote.volume || [];
  const points = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const close = toNumber(closes[i]);
    if (!isFiniteNumber(close)) continue;
    points.push({
      t: timestamps[i] * 1000,
      close,
      high: toNumber(highs[i]),
      low: toNumber(lows[i]),
      volume: toNumber(volumes[i]),
    });
  }

  const latest = points.at(-1);
  const price = toNumber(meta.regularMarketPrice) ?? latest?.close ?? null;
  const previousClose = toNumber(meta.chartPreviousClose) ?? toNumber(meta.previousClose);
  const change = isFiniteNumber(price) && isFiniteNumber(previousClose) ? price - previousClose : null;
  const changePercent = ratio(price, previousClose);

  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || "",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    timezone: meta.exchangeTimezoneName || meta.timezone || "",
    price,
    previousClose,
    change,
    changePercent,
    dayHigh: toNumber(meta.regularMarketDayHigh),
    dayLow: toNumber(meta.regularMarketDayLow),
    volume: toNumber(meta.regularMarketVolume),
    timestamp: (toNumber(meta.regularMarketTime) || latest?.t / 1000 || null) * 1000,
    points: points.slice(-390),
  };
}

function extractSeries(chart, timeZone) {
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const points = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const close = toNumber(closes[i]);
    if (!isFiniteNumber(close)) continue;
    const t = timestamps[i] * 1000;
    points.push({
      date: dateInZone(t, timeZone),
      t,
      close,
    });
  }

  return points;
}

function computeRollingNav({
  baseNav,
  baseDate,
  baseUnderlying,
  currentUnderlying,
  currentTimestamp,
  dailyPoints,
  leverage,
  fxRatio,
}) {
  if (!isFiniteNumber(baseNav)) {
    return { value: null, steps: [] };
  }

  const currentDate = currentTimestamp ? dateInZone(currentTimestamp, "Asia/Seoul") : baseDate;
  if (
    baseDate &&
    currentDate &&
    (baseDate > currentDate || (baseDate === currentDate && !isAfterKrxRegularClose(currentTimestamp, currentDate)))
  ) {
    return {
      value: baseNav,
      steps: [
        {
          date: baseDate,
          underlying: currentUnderlying ?? baseUnderlying ?? null,
          dailyReturn: 0,
          nav: baseNav,
          type: "official-anchor-current",
        },
      ],
    };
  }

  if (!isFiniteNumber(baseUnderlying) || !isFiniteNumber(currentUnderlying)) {
    return { value: null, steps: [] };
  }

  let nav = baseNav;
  let previousUnderlying = baseUnderlying;
  const steps = [];

  for (const point of dailyPoints) {
    if (point.date <= baseDate || point.date >= currentDate) continue;
    const dailyReturn = point.close / previousUnderlying - 1;
    nav *= 1 + leverage * dailyReturn;
    previousUnderlying = point.close;
    steps.push({
      date: point.date,
      underlying: point.close,
      dailyReturn,
      nav,
      type: "completed-day",
    });
  }

  const liveReturn = currentUnderlying / previousUnderlying - 1;
  nav *= 1 + leverage * liveReturn;
  steps.push({
    date: currentDate,
    underlying: currentUnderlying,
    dailyReturn: liveReturn,
    nav,
    type: "latest",
  });

  const withFx = nav * (isFiniteNumber(fxRatio) ? fxRatio : 1);
  return {
    value: isFiniteNumber(withFx) ? withFx : null,
    steps,
  };
}

function computeSimpleNav({ baseNav, baseUnderlying, currentUnderlying, leverage, fxRatio }) {
  if (!isFiniteNumber(baseNav) || !isFiniteNumber(baseUnderlying) || !isFiniteNumber(currentUnderlying)) {
    return null;
  }
  const nav = baseNav * (1 + leverage * (currentUnderlying / baseUnderlying - 1));
  return nav * (isFiniteNumber(fxRatio) ? fxRatio : 1);
}

function isAfterKrxRegularClose(timestamp, date) {
  if (!isFiniteNumber(timestamp) || !date) return false;
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const regularCloseUtc = Date.UTC(year, month - 1, day, 15 - 9, 30, 0);
  return timestamp > regularCloseUtc;
}

function buildTheoreticalIntradaySeries({ baseNav, baseUnderlying, underlyingPoints, leverage, fxRatio }) {
  if (!isFiniteNumber(baseNav) || !isFiniteNumber(baseUnderlying)) return [];
  return underlyingPoints
    .map((point) => {
      const value = baseNav * (1 + leverage * (point.close / baseUnderlying - 1)) * fxRatio;
      return {
        t: point.t,
        close: value,
      };
    })
    .filter((point) => isFiniteNumber(point.close));
}

function buildFlatSeries(referencePoints, value) {
  if (!isFiniteNumber(value)) return [];
  return (referencePoints || [])
    .filter((point) => Number.isFinite(point.t))
    .map((point) => ({ t: point.t, close: value }));
}

function findPointOnDate(points, targetDate) {
  return points.find((point) => point.date === targetDate) || null;
}

function findPointOnOrBefore(points, targetDate) {
  let found = null;
  for (const point of points) {
    if (point.date <= targetDate) found = point;
  }
  return found;
}

function compactDateInZone(timestamp, timeZone) {
  return dateInZone(timestamp, timeZone).replaceAll("-", "");
}

function recentCompactDatesInZone(timestamp, timeZone, count) {
  return Array.from({ length: count }, (_, index) =>
    compactDateInZone(timestamp - index * 24 * 60 * 60 * 1000, timeZone),
  );
}

function dateInZone(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function timeInZone(timestamp, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatServerMoney(value) {
  return isFiniteNumber(value) ? `HK$${value.toFixed(2)}` : "--";
}

function formatPercentServer(value) {
  if (!isFiniteNumber(value)) return "--";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function ratio(numerator, denominator) {
  return isFiniteNumber(numerator) && isFiniteNumber(denominator) && denominator !== 0
    ? numerator / denominator - 1
    : null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" ? value.replaceAll(",", "").replace("%", "").trim() : value;
  if (normalized === "" || normalized === "-" || normalized === "N/A") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}







