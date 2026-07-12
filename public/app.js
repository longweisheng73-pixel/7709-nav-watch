const refreshButton = document.querySelector("#refresh-button");
const statusPill = document.querySelector("#status-pill");
const statusText = document.querySelector("#status-text");
const lastUpdated = document.querySelector("#last-updated");
const pathStartDate = document.querySelector("#path-start-date");
const pathEndDate = document.querySelector("#path-end-date");
const applyCustomPeriod = document.querySelector("#apply-custom-period");

let refreshTimer = null;
let selectedPeriod = "20d";
let latestSnapshot = null;
let customPath = null;

refreshButton.addEventListener("click", () => loadSnapshot(true));
applyCustomPeriod.addEventListener("click", applyCustomPath);
loadSnapshot();

async function loadSnapshot(manual = false) {
  setStatus("loading", manual ? "刷新中" : "更新中");
  try {
    const response = await fetch(`/api/snapshot?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    latestSnapshot = await response.json();
    renderSnapshot(latestSnapshot);
    setStatus("live", "实时连接");
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(loadSnapshot, latestSnapshot.refreshMs || 30000);
  } catch (error) {
    setStatus("error", "数据暂不可用");
    lastUpdated.textContent = `更新失败：${error.message}`;
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(loadSnapshot, 45000);
  }
}

function renderSnapshot(data) {
  const product = data.quotes?.product || {};
  const underlying = data.quotes?.underlying || {};
  const adr = data.quotes?.adr || {};
  const navs = Object.fromEntries((data.navViews || []).map((item) => [item.id, item]));

  text("#product-price", money(product.price, "HKD"));
  setLink("#product-source-link", product.url);
  renderChange("#product-change", product.changePercent);
  text("#product-meta", `${product.exchange || "HKEX"} · ${timeText(product.timestamp)}`);

  text("#underlying-price", money(underlying.price, "KRW", 0));
  renderChange("#underlying-change", underlying.changePercent);
  text("#underlying-regular", money(underlying.regularPrice, "KRW", 0));
  text("#underlying-extended", money(underlying.extendedPrice, "KRW", 0));
  text("#underlying-meta", `${underlying.session || "KRX"} · ${timeText(underlying.timestamp, "Asia/Seoul", "KST")}`);

  text("#adr-symbol", adr.symbol || "SKHY / SKHYV");
  setLink("#adr-source-link", adr.url);
  setLink("#adr-premium-source-link", adr.url);
  text("#adr-price", money(adr.regularPrice ?? adr.price, "USD"));
  renderChange("#adr-change", adr.changePercent);
  text("#adr-after-price", money(adr.afterHoursPrice, "USD"));
  text("#adr-after-change", percent(adr.afterHoursChangePercent));
  tone(document.querySelector("#adr-after-change"), adr.afterHoursChangePercent);
  text("#adr-meta", `正式盘 · ${adr.tradingMode === "when-issued" ? "When-issued" : "Regular-way"} · ${timeText(adr.regularTimestamp ?? adr.timestamp, "America/New_York", "ET")}`);

  text("#official-nav", money(navs.official?.value ?? data.officialNav?.hkdNav, "HKD"));
  renderSpread("#official-spread", navs.official?.discount, "7709 折溢价");
  text("#official-meta", `${data.officialNav?.date || "--"} · CSOP 官方每日净值`);

  text("#theory-nav", money(navs.theoretical?.value ?? data.calculation?.theoreticalNav, "HKD"));
  renderSpread("#theory-spread", navs.theoretical?.discount, "7709 偏离");
  text("#theory-basis", `采用 ${data.theoreticalNavBasis?.market || "韩国最新价"} · 最新官方 NAV 锚点`);

  text("#adr-premium", percent(data.adrAnalysis?.premium));
  tone(document.querySelector("#adr-premium"), data.adrAnalysis?.premium);
  text("#adr-theory", `理论 ${money(data.adrAnalysis?.theoreticalPrice, "USD")} · 实际 ${money(data.adrAnalysis?.actualPrice, "USD")}`);
  text("#adr-after-premium", percent(data.adrAnalysis?.afterHoursPremium));
  tone(document.querySelector("#adr-after-premium"), data.adrAnalysis?.afterHoursPremium);
  text("#adr-regular-price", money(data.adrAnalysis?.actualPrice, "USD"));
  text("#adr-reference", `${money(data.adrAnalysis?.koreanReferencePrice, "KRW", 0)} · USD/KRW ${number(data.adrAnalysis?.usdKrw, 2)} · 10 ADS = 1 股`);

  renderSignal(data.tSignal || {});
  renderHoldings(data.holdings);
  initializeCustomDates(data.pathHistory?.product || []);
  if (selectedPeriod === "custom") customPath = calculateCustomPath();
  renderPeriodTabs(data.pathDeviations || []);
  renderPath(data.pathDeviations || []);

  lastUpdated.textContent = `最后更新 ${timeText(data.generatedAt)} · 每 ${Math.round((data.refreshMs || 30000) / 1000)} 秒刷新`;
}

function renderSignal(signal) {
  const panel = document.querySelector("#decision-panel");
  panel.dataset.level = signal.level || "neutral";
  text("#signal-title", signal.title || "暂无信号");
  text("#signal-action", signal.action || "等待数据");
  renderCheck("#check-adr", signal.checks?.adrPremium, "≥ 3%", latestSnapshot?.adrAnalysis?.premium);
  renderCheck("#check-excess", signal.checks?.excessMove, "> 2%", signal.excessMove);
  renderCheck("#check-theory", signal.checks?.theoryPremium, "≥ 2%", latestSnapshot?.metrics?.discountToTheory);
}

function renderCheck(selector, passed, threshold, value) {
  const element = document.querySelector(selector);
  element.textContent = Number.isFinite(value) ? `${percent(value)} / ${threshold}` : `-- / ${threshold}`;
  element.classList.toggle("passed", Boolean(passed));
}

function renderHoldings(holding) {
  const panel = document.querySelector("#holdings-panel");
  panel.hidden = !holding;
  if (!holding) return;
  text("#holding-quantity", `${number(holding.quantity, 0)} 份`);
  text("#holding-cost", money(holding.cost, "HKD", 3));
  text("#holding-value", money(holding.marketValue, "HKD"));
  const pnl = document.querySelector("#holding-pnl");
  pnl.textContent = `${money(holding.unrealizedPnl, "HKD")} · ${percent(holding.unrealizedPnlPercent)}`;
  tone(pnl, holding.unrealizedPnl);
  text("#holding-t-profit", money(holding.tProfit, "HKD"));
  text("#holding-split", `核心 ${number(holding.coreQuantity, 0)} · T 仓 ${number(holding.tQuantity, 0)}`);
}

function renderPeriodTabs(periods) {
  const container = document.querySelector("#period-tabs");
  container.innerHTML = "";
  periods.forEach((period) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = period.label;
    button.className = period.id === selectedPeriod ? "active" : "";
    button.addEventListener("click", () => {
      selectedPeriod = period.id;
      renderPeriodTabs(periods);
      renderPath(periods);
    });
    container.appendChild(button);
  });
  const customButton = document.createElement("button");
  customButton.type = "button";
  customButton.textContent = "自定义";
  customButton.className = selectedPeriod === "custom" ? "active" : "";
  customButton.addEventListener("click", () => {
    selectedPeriod = "custom";
    customPath ||= calculateCustomPath();
    renderPeriodTabs(periods);
    renderPath(periods);
  });
  container.appendChild(customButton);
}

function renderPath(periods) {
  const period = selectedPeriod === "custom"
    ? customPath
    : periods.find((item) => item.id === selectedPeriod) || periods[0];
  text("#path-underlying", percent(period?.underlyingReturn));
  text("#path-simple-double", percent(period?.simpleDoubleReturn));
  text("#path-theory", percent(period?.theoreticalReturn));
  text("#path-actual", percent(period?.actualReturn));
  text("#path-effect", percent(period?.pathEffect));
  tone(document.querySelector("#path-effect"), period?.pathEffect);
  text("#path-simple-deviation", percent(period?.simpleDeviation));
  tone(document.querySelector("#path-simple-deviation"), period?.simpleDeviation);
  text("#path-deviation", percent(period?.deviation));
  tone(document.querySelector("#path-deviation"), period?.deviation);
  text("#path-status", period?.available ? `${period.status} · ${period.trackingStatus || ""} · ${period.startDate} 至 ${period.endDate}` : "该周期历史数据不足");
}

function initializeCustomDates(productPoints) {
  const points = productPoints.filter((point) => point.date && Number.isFinite(point.close));
  if (points.length < 2) return;
  const minimum = points[0].date;
  const maximum = points.at(-1).date;
  pathStartDate.min = minimum;
  pathStartDate.max = maximum;
  pathEndDate.min = minimum;
  pathEndDate.max = maximum;
  if (!pathEndDate.value) pathEndDate.value = maximum;
  if (!pathStartDate.value) pathStartDate.value = points[Math.max(0, points.length - 21)].date;
}

function applyCustomPath() {
  customPath = calculateCustomPath();
  selectedPeriod = "custom";
  renderPeriodTabs(latestSnapshot?.pathDeviations || []);
  renderPath(latestSnapshot?.pathDeviations || []);
}

function calculateCustomPath() {
  const startDate = pathStartDate.value;
  const endDate = pathEndDate.value;
  if (!latestSnapshot || !startDate || !endDate || startDate >= endDate) {
    return unavailableCustomPath(startDate, endDate, "请选择有效的起止日期");
  }

  const productPoints = (latestSnapshot.pathHistory?.product || [])
    .filter((point) => point.date >= startDate && point.date <= endDate && Number.isFinite(point.close));
  const underlyingPoints = (latestSnapshot.pathHistory?.underlying || [])
    .filter((point) => point.date && Number.isFinite(point.close));
  if (productPoints.length < 2 || underlyingPoints.length < 2) {
    return unavailableCustomPath(startDate, endDate, "所选区间交易数据不足");
  }

  const startProduct = productPoints[0];
  const endProduct = productPoints.at(-1);
  let underlyingStartIndex = -1;
  for (let index = 0; index < underlyingPoints.length; index += 1) {
    if (underlyingPoints[index].date <= startProduct.date) underlyingStartIndex = index;
  }
  if (underlyingStartIndex < 0) underlyingStartIndex = 0;
  const underlyingSlice = underlyingPoints
    .slice(underlyingStartIndex)
    .filter((point) => point.date <= endProduct.date);
  if (underlyingSlice.length < 2) {
    return unavailableCustomPath(startDate, endDate, "所选区间韩股数据不足");
  }

  let theoreticalFactor = 1;
  for (let index = 1; index < underlyingSlice.length; index += 1) {
    const dailyReturn = underlyingSlice[index].close / underlyingSlice[index - 1].close - 1;
    theoreticalFactor *= 1 + 2 * dailyReturn;
  }

  const underlyingReturn = underlyingSlice.at(-1).close / underlyingSlice[0].close - 1;
  const simpleDoubleReturn = underlyingReturn * 2;
  const theoreticalReturn = theoreticalFactor - 1;
  const actualReturn = endProduct.close / startProduct.close - 1;
  const pathEffect = theoreticalReturn - simpleDoubleReturn;
  const simpleDeviation = actualReturn - simpleDoubleReturn;
  const deviation = actualReturn - theoreticalReturn;

  return {
    id: "custom",
    label: "自定义",
    startDate: startProduct.date,
    endDate: endProduct.date,
    observations: productPoints.length,
    underlyingReturn,
    simpleDoubleReturn,
    theoreticalReturn,
    actualReturn,
    pathEffect,
    simpleDeviation,
    deviation,
    status: pathEffect > 0.01 ? "路径复利收益" : pathEffect < -0.01 ? "波动路径损耗" : "路径影响较小",
    trackingStatus: deviation > 0.01 ? "正跟踪偏差" : deviation < -0.01 ? "负跟踪偏差" : "接近理论跟踪",
    available: true,
  };
}

function unavailableCustomPath(startDate, endDate, status) {
  return {
    id: "custom",
    label: "自定义",
    startDate: startDate || "--",
    endDate: endDate || "--",
    underlyingReturn: null,
    simpleDoubleReturn: null,
    theoreticalReturn: null,
    actualReturn: null,
    pathEffect: null,
    simpleDeviation: null,
    deviation: null,
    trackingStatus: "数据不足",
    status,
    available: false,
  };
}

function renderChange(selector, value) {
  const element = document.querySelector(selector);
  element.textContent = percent(value);
  tone(element, value);
}

function renderSpread(selector, value, label) {
  const element = document.querySelector(selector);
  element.textContent = Number.isFinite(value) ? `${label} ${percent(value)}` : "--";
  tone(element, value);
}

function setStatus(type, label) {
  statusPill.classList.toggle("live", type === "live");
  statusPill.classList.toggle("error", type === "error");
  statusText.textContent = label;
}

function tone(element, value) {
  element.classList.toggle("up", Number.isFinite(value) && value > 0);
  element.classList.toggle("down", Number.isFinite(value) && value < 0);
}

function text(selector, value) {
  document.querySelector(selector).textContent = value ?? "--";
}

function setLink(selector, value) {
  if (!value) return;
  document.querySelector(selector).href = value;
}

function money(value, currency, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  const prefix = currency === "HKD" ? "HK$" : currency === "KRW" ? "₩" : currency === "USD" ? "$" : "";
  return `${prefix}${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function percent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function number(value, digits = 2) {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "--";
}

function timeText(value, timeZone = "Asia/Shanghai", suffix = "") {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const formatted = date.toLocaleString("zh-CN", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return suffix ? `${formatted} ${suffix}` : formatted;
}
