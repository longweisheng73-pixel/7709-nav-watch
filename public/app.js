const refreshButton = document.querySelector("#refresh-button");
const statusPill = document.querySelector("#status-pill");
const statusText = document.querySelector("#status-text");
const lastUpdated = document.querySelector("#last-updated");
const alertToggle = document.querySelector("#alert-toggle");
const alertThresholdInput = document.querySelector("#alert-threshold");
const alertState = document.querySelector("#alert-state");
const alertBanner = document.querySelector("#discount-alert-banner");
const alertTitle = document.querySelector("#discount-alert-title");
const alertMessage = document.querySelector("#discount-alert-message");

const ALERT_STORAGE_KEY = "7709-theory-spread-alert-v2";
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

let refreshTimer = null;
let alertSettings = loadAlertSettings();
let lastAlertAt = 0;
let lastAlertSignature = "";
let audioContext = null;

refreshButton.addEventListener("click", () => loadSnapshot(true));
alertToggle.addEventListener("click", toggleDiscountAlert);
alertThresholdInput.addEventListener("change", () => {
  alertSettings.thresholdPct = normalizeThreshold(alertThresholdInput.value);
  saveAlertSettings();
  renderAlertControls();
});

renderAlertControls();

loadSnapshot();

async function loadSnapshot(manual = false) {
  setStatus("loading", manual ? "手动刷新中" : "更新中");

  try {
    const response = await fetch(`/api/snapshot?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    renderSnapshot(data);
    setStatus("live", "已连接");

    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(loadSnapshot, data.refreshMs || 30000);
  } catch (error) {
    setStatus("error", "数据暂不可用");
    lastUpdated.textContent = `错误：${error.message}`;
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(loadSnapshot, 45000);
  }
}

function renderSnapshot(data) {
  const { officialNav, quotes, calculation, metrics, sources } = data;
  const navViews = Object.fromEntries((data.navViews || []).map((item) => [item.id, item]));

  text("#product-price", money(quotes.product.price, quotes.product.currency));
  renderChange("#product-change", quotes.product.change, quotes.product.changePercent, quotes.product.currency);
  text("#product-meta", `${quotes.product.exchange} · ${timeText(quotes.product.timestamp)} · 成交量 ${compact(quotes.product.volume)}`);

  renderNavCard(navViews.official, {
    value: "#official-nav",
    discount: "#discount-official",
    meta: "#official-meta",
    fallbackValue: officialNav.hkdNav,
    fallbackDiscount: metrics.discountToOfficial,
    fallbackMeta: `${officialNav.dateLabel || officialNav.date} · NAV 变动 ${officialNav.navChange || "--"}`,
  });
  renderNavCard(navViews.theoretical, {
    value: "#theory-nav",
    discount: "#discount-theory",
    meta: "#theory-meta",
    fallbackValue: calculation.theoreticalNav,
    fallbackDiscount: metrics.discountToTheory,
    fallbackMeta: "按官方 NAV 锚点滚动估算",
  });
  renderUnderlyingSessions(quotes.underlying);
  text(
    "#underlying-meta",
    `${quotes.underlying.exchange} · ${quotes.underlying.session || "KRX 常规盘"} · ${timeText(
      quotes.underlying.timestamp,
      "Asia/Seoul",
      "KST",
    )} · 成交量 ${compact(quotes.underlying.volume)}`,
  );

  text(
    "#anchor-underlying",
    calculation.anchorUnderlying
      ? `${money(calculation.anchorUnderlying.close, "KRW", 0)} · ${calculation.anchorUnderlying.date}`
      : "--",
  );
  text("#fx-ratio", calculation.fxRatio ? `${calculation.fxRatio.toFixed(5)}×` : "--");
  text("#theory-no-fx", money(calculation.theoreticalNavNoFx, "HKD"));
  text(
    "#leverage-today",
    Number.isFinite(metrics.estimatedLeverageToday)
      ? `${metrics.estimatedLeverageToday.toFixed(2)}×`
      : "--",
  );

  renderCombinedChart("#nav-chart", [
    { points: data.series.product, className: "orange" },
    { points: data.series.theoretical, className: "blue" },
  ]);
  renderCombinedChart("#underlying-chart", [{ points: data.series.underlying, className: "green" }]);
  renderSources(sources, data);
  evaluateDiscountAlert(data);

  lastUpdated.textContent = `最后更新：${timeText(data.generatedAt)} · 自动刷新约 ${Math.round((data.refreshMs || 30000) / 1000)} 秒`;
}

async function toggleDiscountAlert() {
  alertSettings.enabled = !alertSettings.enabled;
  alertSettings.thresholdPct = normalizeThreshold(alertThresholdInput.value);

  if (alertSettings.enabled && "Notification" in window && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // The in-page banner and sound still work if system notifications are blocked.
    }
  }

  if (alertSettings.enabled) {
    primeAudioContext();
    playAlertTone(0.04);
  }

  saveAlertSettings();
  renderAlertControls();
}

function evaluateDiscountAlert(data) {
  const threshold = normalizeThreshold(alertSettings.thresholdPct) / 100;
  const theoretical = (data.navViews || []).find((nav) => nav.id === "theoretical");
  const spread = theoretical?.discount;
  const triggered = Number.isFinite(spread) && Math.abs(spread) >= threshold;

  if (!triggered) {
    alertBanner.hidden = true;
    lastAlertSignature = "";
    renderAlertControls();
    return;
  }

  const directionText = spread < 0 ? "折价" : "溢价";
  const magnitudePct = Math.abs(spread * 100);
  const levelPct = Math.floor(magnitudePct);
  const title = `7709 理论NAV${directionText}超过 ${alertSettings.thresholdPct.toFixed(1)}%`;
  const message = `理论 NAV ${formatPercent(spread)} · 当前档位 ${directionText}${levelPct}%`;

  alertTitle.textContent = title;
  alertMessage.textContent = `${message} · 7709 ${money(data.quotes?.product?.price, data.quotes?.product?.currency)}`;
  alertBanner.hidden = false;

  const signature = `${directionText}:${levelPct}`;
  const now = Date.now();
  if (!alertSettings.enabled || (signature === lastAlertSignature && now - lastAlertAt < ALERT_COOLDOWN_MS)) {
    renderAlertControls(triggered ? [theoretical] : []);
    return;
  }

  lastAlertAt = now;
  lastAlertSignature = signature;
  notifyDiscountAlert(title, `${message}，当前 7709 ${money(data.quotes?.product?.price, "HKD")}`);
  renderAlertControls([theoretical]);
}

function notifyDiscountAlert(title, body) {
  playAlertTone(0.18);
  if ("vibrate" in navigator) navigator.vibrate([220, 80, 220]);

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, {
      body,
      tag: "7709-discount-alert",
      renotify: true,
    });
  }
}

function primeAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  audioContext ||= new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume();
}

function playAlertTone(volume = 0.12) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  audioContext ||= new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume();

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const start = audioContext.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, start);
  oscillator.frequency.setValueAtTime(660, start + 0.16);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.45);
}

function renderAlertControls(breaches = []) {
  alertThresholdInput.value = alertSettings.thresholdPct.toFixed(1);
  alertToggle.classList.toggle("enabled", alertSettings.enabled);
  alertToggle.textContent = alertSettings.enabled ? "提醒已开" : "开启提醒";

  const notificationText =
    "Notification" in window
      ? Notification.permission === "granted"
        ? "系统通知已允许"
        : Notification.permission === "denied"
          ? "系统通知被浏览器阻止"
          : "待授权系统通知"
      : "浏览器不支持系统通知";
  const breachText = breaches.length ? "理论NAV已触发" : "等待触发";
  alertState.textContent = `${alertSettings.enabled ? "已开启" : "未开启"} · ${breachText} · 阈值 ${alertSettings.thresholdPct.toFixed(1)}% · ${notificationText}`;
}

function loadAlertSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(ALERT_STORAGE_KEY) || "{}");
    return {
      enabled: Boolean(saved.enabled),
      thresholdPct: normalizeThreshold(saved.thresholdPct ?? 2),
    };
  } catch {
    return { enabled: false, thresholdPct: 2 };
  }
}

function saveAlertSettings() {
  localStorage.setItem(
    ALERT_STORAGE_KEY,
    JSON.stringify({
      enabled: alertSettings.enabled,
      thresholdPct: normalizeThreshold(alertSettings.thresholdPct),
    }),
  );
}

function normalizeThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 2;
  return Math.min(20, Math.max(0.1, number));
}

function renderSources(sources, data) {
  const grid = document.querySelector("#source-grid");
  grid.innerHTML = "";

  const extra = [
    {
      name: "当前计算锚点",
      url: "https://www.csopasset.com/en/products/hk-skhy-2l",
      role: `官方 NAV ${money(data.officialNav.hkdNav, "HKD")}，日期 ${data.officialNav.date}`,
    },
    {
      name: "四口径 NAV 状态",
      url: "https://stock.naver.com/domestic/stock/000660/total",
      role: (data.navViews || [])
        .map((item) => `${item.shortLabel || item.label}: ${item.status === "ok" ? money(item.value, item.currency) : "暂不可用"}`)
        .join(" / "),
    },
    {
      name: "手机推送状态",
      url: "/api/alert/status",
      role: data.phoneAlert?.configured
        ? `${data.phoneAlert.enabled ? "已开启" : "已配置但停用"} · ${data.phoneAlert.channels.join(" / ")} · 理论NAV双向 ${data.phoneAlert.thresholdPct}% 起，每 ${data.phoneAlert.stepPct}% 一档，连续 ${data.phoneAlert.confirmRefreshes} 次确认`
        : "未配置服务端手机推送；网页内提醒仍可使用",
    },
  ];

  [...sources, ...extra].forEach((source) => {
    const item = document.createElement("article");
    item.className = "source-item";
    item.innerHTML = `
      <a href="${source.url}" target="_blank" rel="noreferrer">${source.name}</a>
      <p>${source.role}</p>
    `;
    grid.appendChild(item);
  });
}

function renderNavCard(nav, selectors) {
  const value = nav?.value ?? selectors.fallbackValue;
  const discount = nav?.discount ?? selectors.fallbackDiscount;
  const meta = nav ? navMeta(nav) : selectors.fallbackMeta;

  text(selectors.value, money(value, nav?.currency || "HKD"));
  renderPercent(selectors.discount, discount, "7709 折溢价");
  text(selectors.meta, meta || "--");

  const valueEl = document.querySelector(selectors.value);
  valueEl.classList.toggle("muted-value", nav?.status === "unavailable");
  valueEl.classList.toggle("proxy-value", nav?.status === "proxy");
}

function navMeta(nav) {
  if (!nav) return "--";
  const stamp = [nav.date, nav.time].filter(Boolean).join(" ");
  if (nav.status === "proxy") return `代理估算 · ${nav.note || "直接来源不可用"}`;
  if (nav.status !== "ok") return `暂不可用 · ${nav.note || "数据源未返回"}`;
  return [stamp, nav.source].filter(Boolean).join(" · ");
}

function renderUnderlyingSessions(underlying) {
  text("#underlying-regular-price", money(underlying.regularPrice ?? underlying.price, underlying.currency, 0));
  renderChange(
    "#underlying-regular-change",
    underlying.regularChange,
    underlying.regularChangePercent ?? underlying.changePercent,
    underlying.currency,
    0,
  );

  text("#underlying-extended-price", money(underlying.extendedPrice, underlying.currency, 0));
  renderChange(
    "#underlying-extended-change",
    underlying.extendedChange,
    underlying.extendedChangePercent,
    underlying.currency,
    0,
  );
}

function renderCombinedChart(selector, datasets) {
  const svg = document.querySelector(selector);
  const width = svg.clientWidth || 800;
  const height = svg.clientHeight || 320;
  const pad = { left: 52, right: 18, top: 18, bottom: 32 };
  const series = datasets
    .map((dataset) => ({
      ...dataset,
      points: (dataset.points || []).filter((point) => Number.isFinite(point.close) && Number.isFinite(point.t)),
    }))
    .filter((dataset) => dataset.points.length > 1);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  if (!series.length) {
    svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="axis-label">暂无走势图数据</text>`;
    return;
  }

  const allPoints = series.flatMap((dataset) => dataset.points);
  const minT = Math.min(...allPoints.map((point) => point.t));
  const maxT = Math.max(...allPoints.map((point) => point.t));
  const minY = Math.min(...allPoints.map((point) => point.close));
  const maxY = Math.max(...allPoints.map((point) => point.close));
  const yRange = maxY - minY || Math.max(Math.abs(maxY), 1) * 0.02;

  const x = (t) => pad.left + ((t - minT) / (maxT - minT || 1)) * (width - pad.left - pad.right);
  const y = (value) =>
    height - pad.bottom - ((value - (minY - yRange * 0.08)) / (yRange * 1.16)) * (height - pad.top - pad.bottom);

  for (let i = 0; i <= 4; i += 1) {
    const yy = pad.top + ((height - pad.top - pad.bottom) / 4) * i;
    const value = maxY - (yRange / 4) * i;
    svg.appendChild(svgEl("line", { x1: pad.left, x2: width - pad.right, y1: yy, y2: yy, stroke: "rgba(104,115,109,.18)" }));
    svg.appendChild(svgEl("text", { x: 10, y: yy + 4, class: "axis-label" }, shortNumber(value)));
  }

  for (const dataset of series) {
    const d = dataset.points.map((point) => `${x(point.t).toFixed(1)},${y(point.close).toFixed(1)}`).join(" ");
    svg.appendChild(svgEl("polyline", { points: d, class: `chart-line ${dataset.className}` }));
  }

  const firstLabel = new Date(minT).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const lastLabel = new Date(maxT).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  svg.appendChild(svgEl("text", { x: pad.left, y: height - 8, class: "axis-label" }, firstLabel));
  svg.appendChild(svgEl("text", { x: width - pad.right, y: height - 8, "text-anchor": "end", class: "axis-label" }, lastLabel));
}

function svgEl(name, attributes, content = "") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes || {}).forEach(([key, value]) => element.setAttribute(key, value));
  if (content) element.textContent = content;
  return element;
}

function setStatus(type, message) {
  statusPill.classList.toggle("live", type === "live");
  statusPill.classList.toggle("error", type === "error");
  statusText.textContent = message;
}

function text(selector, value) {
  document.querySelector(selector).textContent = value ?? "--";
}

function renderChange(selector, change, percent, currency, digits = 2) {
  const el = document.querySelector(selector);
  const sign = change > 0 ? "+" : "";
  el.textContent =
    Number.isFinite(change) && Number.isFinite(percent)
      ? `${sign}${money(change, currency, digits)} (${formatPercent(percent)})`
      : "--";
  setTone(el, percent);
}

function renderPercent(selector, percent, prefix) {
  const el = document.querySelector(selector);
  el.textContent = Number.isFinite(percent) ? `${prefix} ${formatPercent(percent)}` : "--";
  setTone(el, percent);
}

function setTone(el, value) {
  el.classList.toggle("up", value > 0);
  el.classList.toggle("down", value < 0);
}

function money(value, currency = "", digits = 2) {
  if (!Number.isFinite(value)) return "--";
  const normalizedCurrency = currency || "";
  const prefix = normalizedCurrency === "HKD" ? "HK$" : normalizedCurrency === "KRW" ? "₩" : "";
  return `${prefix}${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${prefix ? "" : normalizedCurrency ? ` ${normalizedCurrency}` : ""}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function compact(value) {
  if (!Number.isFinite(value)) return "--";
  return Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function shortNumber(value) {
  if (!Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US");
  return value.toFixed(2);
}

function timeText(value, timeZone = "Asia/Shanghai", suffix = "") {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const formatted = date.toLocaleString("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return suffix ? `${formatted} ${suffix}` : formatted;
}

