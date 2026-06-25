const PRICE_BANDS = [
  { label: "<10", min: 0, max: 10 },
  { label: "10-15", min: 10, max: 15 },
  { label: "15-20", min: 15, max: 20 },
  { label: "20-25", min: 20, max: 25 },
  { label: "25-30", min: 25, max: 30 },
  { label: "30-40", min: 30, max: 40 },
  { label: "40-60", min: 40, max: 60 },
  { label: "60+", min: 60, max: Infinity },
];

function roundIndex(value) {
  return Math.round(value * 100) / 100;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatPriceValue(value) {
  if (!isFiniteNumber(value)) return "未知";
  if (value > 999) return "异常";
  return value.toFixed(2);
}

function resolveGroupedFreshness(values, fallback) {
  const normalized = [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];
  const hasFresh = normalized.some((value) => /new|新品|鏂板搧/i.test(value));
  const hasAged = normalized.some((value) => /old|老品|鑰佸搧/i.test(value));

  if (hasFresh && hasAged) return "老品/新品";
  if (hasFresh) return "新品";
  if (hasAged) return "老品";
  return fallback;
}

function getPriceBand(price) {
  if (typeof price !== "number" || Number.isNaN(price)) {
    return "未知";
  }
  const band = PRICE_BANDS.find((item) => price >= item.min && price < item.max);
  return band ? band.label : "未知";
}

const SECTION_ALIASES = {
  women: ["women", "woman", "women's clothing", "womens clothing", "women clothing"],
  men: ["men", "men's clothing", "mens clothing", "men clothing"],
  underwear: ["underwear", "lingerie & underwear", "lingerie and underwear", "lingerie"],
  sports: ["sports", "sports & outdoor", "sports and outdoor", "sportswear"],
};

function normalizeCategoryName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s*&\s*/g, " & ");
}

function resolveSectionFromLevel1(level1) {
  const normalized = normalizeCategoryName(level1);
  for (const [section, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return section;
    }
  }
  return "unknown";
}

function filterProductsBySection(items, section) {
  const targetSection = String(section || "").trim().toLowerCase();
  return items.filter((item) => {
    const itemSection =
      (item.section && String(item.section).trim().toLowerCase()) ||
      resolveSectionFromLevel1(item.level1 || item.categoryPath || "");
    return itemSection === targetSection;
  });
}

function computeIndexes(items) {
  const totalGmv = items.reduce((sum, item) => sum + Number(item.gmv || 0), 0);
  const totalOrders = items.reduce((sum, item) => sum + Number(item.orders || 0), 0);

  return items.map((item) => ({
    ...item,
    priceBand: getPriceBand(item.priceMid),
    gmvIndex: totalGmv ? roundIndex((Number(item.gmv || 0) / totalGmv) * 100) : 0,
    orderIndex: totalOrders ? roundIndex((Number(item.orders || 0) / totalOrders) * 100) : 0,
  }));
}

function buildImageDedupedProducts(items) {
  const groups = new Map();

  for (const item of items) {
    const image = String(item.image || "").trim();
    const key = image || `record:${item.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const mergedProducts = [...groups.values()].map((groupItems, groupIndex) => {
    const representative = [...groupItems].sort((a, b) => Number(b.gmv || 0) - Number(a.gmv || 0))[0] || {};
    const prices = groupItems
      .flatMap((item) => [item.priceMin, item.priceMax, item.priceMid])
      .filter(isFiniteNumber);
    const priceMin = prices.length ? Math.min(...prices) : null;
    const priceMax = prices.length ? Math.max(...prices) : null;
    const statuses = [...new Set(groupItems.map((item) => item.status).filter(Boolean))];
    const sources = [...new Set(groupItems.map((item) => item.source).filter(Boolean))].sort();
    const freshnessValues = groupItems.map((item) => item.freshness);
    const freshness = resolveGroupedFreshness(freshnessValues, representative.freshness);
    const jids = [...new Set(groupItems.map((item) => item.jid).filter(Boolean))];

    return {
      ...representative,
      id: `image:${representative.image || groupIndex}`,
      originalIds: groupItems.map((item) => item.id),
      duplicateImageCount: groupItems.length,
      isDuplicateImage: groupItems.length > 1,
      gmv: groupItems.reduce((sum, item) => sum + Number(item.gmv || 0), 0),
      orders: groupItems.reduce((sum, item) => sum + Number(item.orders || 0), 0),
      priceMin,
      priceMax,
      priceMid: priceMax,
      priceDisplay:
        priceMin !== null && priceMax !== null && priceMin !== priceMax
          ? `${formatPriceValue(priceMin)}-${formatPriceValue(priceMax)}`
          : formatPriceValue(priceMax),
      status: statuses.length > 1 ? "混合" : statuses[0] || representative.status,
      source: sources.length ? sources.join("/") : representative.source,
      freshness,
      jid: jids.join("\n"),
    };
  });

  const rankedByGmv = [...mergedProducts].sort((a, b) => Number(b.gmv || 0) - Number(a.gmv || 0));
  const rankMap = new Map(rankedByGmv.map((item, index) => [item.id, index + 1]));

  return computeIndexes(mergedProducts)
    .map((item) => ({
      ...item,
      rank: rankMap.get(item.id) || 0,
    }))
    .sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
}

function parseUpdateDate(value) {
  if (!value) return null;
  const match = String(value)
    .trim()
    .match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getFreshnessLabel(updatedAt, now = new Date()) {
  const parsedDate = parseUpdateDate(updatedAt);
  if (!parsedDate) return "未知";

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const diffDays = (now.getTime() - parsedDate.getTime()) / millisecondsPerDay;
  return diffDays <= 90 ? "新品" : "老品";
}

function enrichProductSignals(items, now = new Date()) {
  const imageCounts = items.reduce((counts, item) => {
    const image = item.image || "";
    counts.set(image, (counts.get(image) || 0) + 1);
    return counts;
  }, new Map());
  const rankMap = [...items]
    .sort((a, b) => Number(b.gmv || 0) - Number(a.gmv || 0))
    .reduce((map, item, index) => {
      map.set(item.id, index + 1);
      return map;
    }, new Map());

  return items.map((item) => {
    const duplicateImageCount = imageCounts.get(item.image || "") || 0;

    return {
      ...item,
      duplicateImageCount,
      isDuplicateImage: duplicateImageCount > 1,
      freshness: getFreshnessLabel(item.updatedAt, now),
      rank: rankMap.get(item.id) || 0,
    };
  });
}

function applyFilters(items, filters = {}) {
  const level2 = filters.level2 || "all";
  const level3 = filters.level3 || "all";
  const status = filters.status || "all";
  const source = filters.source || "all";
  const freshness = filters.freshness || "all";
  const priceBand = filters.priceBand || "all";
  const duplicate = filters.duplicate || "all";
  const rankMin = Number(filters.rankMin || 0);
  const rankMax = Number(filters.rankMax || 0);
  const sortBy = filters.sortBy || "gmvIndex";

  const filtered = items.filter((item) => {
    if (level2 !== "all" && item.level2 !== level2) return false;
    if (level3 !== "all" && item.level3 !== level3) return false;
    if (status !== "all" && item.status !== status) return false;
    if (source !== "all" && (item.source || "未知") !== source) return false;
    if (freshness !== "all" && item.freshness !== freshness) return false;
    if (priceBand !== "all" && getPriceBand(item.priceMid) !== priceBand) return false;
    if (duplicate === "duplicate" && !item.isDuplicateImage) return false;
    if (duplicate === "unique" && item.isDuplicateImage) return false;
    if (rankMin > 0 && Number(item.rank || 0) < rankMin) return false;
    if (rankMax > 0 && Number(item.rank || 0) > rankMax) return false;
    return true;
  });

  return computeIndexes(filtered).sort((a, b) => {
    if (sortBy === "orderIndex") return b.orderIndex - a.orderIndex;
    if (sortBy === "priceAsc") return (a.priceMid || 0) - (b.priceMid || 0);
    if (sortBy === "priceDesc") return (b.priceMid || 0) - (a.priceMid || 0);
    return b.gmvIndex - a.gmvIndex;
  });
}

function getCategoryOptions(items, selectedLevel2 = "all") {
  const level2Options = [...new Set(items.map((item) => item.level2))].sort();
  const level3Source =
    selectedLevel2 === "all"
      ? items
      : items.filter((item) => item.level2 === selectedLevel2);
  const level3Options = [...new Set(level3Source.map((item) => item.level3))].sort();

  return { level2Options, level3Options };
}

function summarizeByCategory(items, key) {
  const indexedProducts = computeIndexes(items);
  const totalGmv = items.reduce((sum, item) => sum + Number(item.gmv || 0), 0);
  const totalOrders = items.reduce((sum, item) => sum + Number(item.orders || 0), 0);
  const groups = new Map();

  for (const item of items) {
    const name = item[key] || "未分类";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }

  return [...groups.entries()]
    .map(([name, groupItems]) => {
      const groupGmv = groupItems.reduce((sum, item) => sum + Number(item.gmv || 0), 0);
      const groupOrders = groupItems.reduce((sum, item) => sum + Number(item.orders || 0), 0);
      const prices = groupItems
        .map((item) => item.priceMid)
        .filter((price) => typeof price === "number" && !Number.isNaN(price))
        .sort((a, b) => a - b);
      const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : null;

      return {
        name,
        itemCount: groupItems.length,
        gmvIndex: totalGmv ? roundIndex((groupGmv / totalGmv) * 100) : 0,
        orderIndex: totalOrders ? roundIndex((groupOrders / totalOrders) * 100) : 0,
        itemIndex: items.length ? roundIndex((groupItems.length / items.length) * 100) : 0,
        medianPrice,
        topLevel3: getTopLevel3(groupItems),
        topItem: indexedProducts
          .filter((item) => item[key] === name)
          .sort((a, b) => b.gmvIndex - a.gmvIndex)[0],
      };
    })
    .sort((a, b) => b.gmvIndex - a.gmvIndex);
}

function getTopLevel3(items) {
  const summary = summarizeSimple(items, "level3");
  return summary.length ? summary[0].name : "未分类";
}

function formatCategoryDrilldownName(level2, level3) {
  const second = level2 || "未分类";
  const third = level3 || "";
  if (!third || third === "未分类" || third === "未分组" || third === "Uncategorized" || third === second) {
    return second;
  }
  return `${second} > ${third}`;
}

function formatLeadingCategories(rows, threshold = 10) {
  const leading = rows.filter((row) => row.gmvIndex > threshold);
  const visible = leading.length ? leading : rows.slice(0, 1);
  return visible.map((row) => `${row.name} ${row.gmvIndex.toFixed(2)}`).join(" / ");
}

function getProductDisplayGroups(items, displayMode = "flatGmv") {
  const sortedProducts = [...items].sort((a, b) => b.gmvIndex - a.gmvIndex);

  if (displayMode === "flatGmv") {
    return [
      {
        name: "",
        items: sortedProducts,
        gmvIndex: sortedProducts.reduce((sum, item) => sum + item.gmvIndex, 0),
      },
    ];
  }

  const groupKey = displayMode === "level2" ? "level2" : "level3";
  const groups = new Map();
  for (const item of sortedProducts) {
    const groupName = item[groupKey] || "未分类";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(item);
  }

  return [...groups.entries()]
    .map(([name, groupItems]) => ({
      name,
      items: groupItems,
      gmvIndex: groupItems.reduce((sum, item) => sum + item.gmvIndex, 0),
    }))
    .sort((a, b) => b.gmvIndex - a.gmvIndex);
}

function summarizePriceBands(items) {
  const total = items.length || 1;
  const withIndexes = computeIndexes(items);
  return PRICE_BANDS.map((band) => {
    const bandItems = withIndexes.filter((item) => item.priceBand === band.label);
    return {
      name: band.label,
      itemCount: bandItems.length,
      itemIndex: roundIndex((bandItems.length / total) * 100),
      gmvIndex: roundIndex(bandItems.reduce((sum, item) => sum + item.gmvIndex, 0)),
      orderIndex: roundIndex(bandItems.reduce((sum, item) => sum + item.orderIndex, 0)),
    };
  }).filter((band) => band.itemCount > 0);
}

function summarizeSimple(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = item[key] || "未分类";
    const current = groups.get(name) || { name, gmv: 0 };
    current.gmv += Number(item.gmv || 0);
    groups.set(name, current);
  }
  return [...groups.values()].sort((a, b) => b.gmv - a.gmv);
}

let products = [];
let hasBoundDashboardEvents = false;
const DATA_DECRYPTION_KEY = "xuanpin2026";
const CARD_PAGE_SIZE = 60;
const LIST_PAGE_SIZE = 100;
const CANONICAL_HOSTS = new Set(["offsiteselection.uk", "www.offsiteselection.uk"]);
const dashboardConfig = window.DASHBOARD_CONFIG || {};
const dataFile = dashboardConfig.dataFile || "products-all-data.enc.js";
const dataVersion = dashboardConfig.dataVersion || "";
const section = dashboardConfig.section || "women";
const state = {
  level2: "all",
  level3: "all",
  priceBand: "all",
  status: "all",
  source: "all",
  freshness: "all",
  duplicate: "all",
  rankMin: "",
  rankMax: "",
  sortBy: "gmvIndex",
  displayMode: "flatGmv",
  view: "card",
  productPage: 1,
};

function enforceCanonicalHost() {
  if (!["http:", "https:"].includes(window.location.protocol)) return true;
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return true;
  if (CANONICAL_HOSTS.has(window.location.hostname)) return true;

  document.body.innerHTML = `
    <main class="redirect-screen" aria-label="请使用正式域名访问">
      <section class="redirect-panel">
        <p class="eyebrow">Cloudflare Access</p>
        <h1>请使用正式域名访问</h1>
        <p>为了启用邮箱验证，请从 offsiteselection.uk 进入看板。</p>
        <a href="https://offsiteselection.uk/">打开正式入口</a>
      </section>
    </main>
  `;
  return false;
}

const shouldBootDashboard = enforceCanonicalHost();

const els = {
  topNav: document.querySelector(".top-nav"),
  filterStrip: document.querySelector(".filter-strip"),
  summaryGrid: document.querySelector("#summaryGrid"),
  level2Filter: document.querySelector("#level2Filter"),
  level3Filter: document.querySelector("#level3Filter"),
  priceFilter: document.querySelector("#priceFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  sourceFilter: document.querySelector("#sourceFilter"),
  freshnessFilter: document.querySelector("#freshnessFilter"),
  duplicateFilter: document.querySelector("#duplicateFilter"),
  rankMinFilter: document.querySelector("#rankMinFilter"),
  rankMaxFilter: document.querySelector("#rankMaxFilter"),
  sortFilter: document.querySelector("#sortFilter"),
  displayModeFilter: document.querySelector("#displayModeFilter"),
  resetFilters: document.querySelector("#resetFilters"),
  level2Table: document.querySelector("#level2Table"),
  level3Bars: document.querySelector("#level3Bars"),
  level3Context: document.querySelector("#level3Context"),
  priceBandBars: document.querySelector("#priceBandBars"),
  productGroups: document.querySelector("#productGroups"),
  resultCount: document.querySelector("#resultCount"),
  resultNote: document.querySelector("#resultNote"),
  dataUpdatedAt: document.querySelector("#dataUpdatedAt"),
  viewButtons: document.querySelectorAll("[data-view]"),
};

let stickyOffsetFrame = 0;

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function decryptProducts(password) {
  await loadEncryptedProducts();
  const encrypted = window.ENCRYPTED_PRODUCTS;
  if (!encrypted) {
    throw new Error("missing_encrypted_data");
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToBytes(encrypted.salt),
      iterations: encrypted.iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const ciphertext = base64ToBytes(encrypted.ciphertext);
  const tag = base64ToBytes(encrypted.tag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encrypted.iv), tagLength: 128 },
    key,
    combined,
  );
  return JSON.parse(new TextDecoder().decode(plainBuffer));
}

function loadEncryptedProducts() {
  if (window.ENCRYPTED_PRODUCTS) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = dataVersion
      ? `./data/${dataFile}?v=${encodeURIComponent(dataVersion)}`
      : `./data/${dataFile}`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("encrypted_data_load_failed"));
    document.head.appendChild(script);
  });
}

async function unlockDashboard() {
  try {
    const decrypted = await decryptProducts(DATA_DECRYPTION_KEY);
    products = enrichProductSignals(filterProductsBySection(decrypted, section));
    renderDataUpdatedAt();
    initFilters();
    if (!hasBoundDashboardEvents) {
      bindEvents();
      hasBoundDashboardEvents = true;
    }
    render();
  } catch (error) {
    console.error(error);
    if (els.productGroups) {
      els.productGroups.innerHTML = '<div class="empty-state">数据加载失败，请稍后刷新重试。</div>';
    }
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatIndex(value) {
  return Number(value || 0).toFixed(2);
}

function formatPrice(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "未知";
  if (value > 999) return "异常";
  return value.toFixed(2);
}

function formatGeneratedDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderDataUpdatedAt() {
  if (!els.dataUpdatedAt) return;
  els.dataUpdatedAt.textContent = `更新日期：${formatGeneratedDate(window.ENCRYPTED_PRODUCTS?.generatedAt)}`;
}

async function writeClipboardText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function syncListHeaderOffset() {
  const navBottom = Math.max(0, els.topNav?.getBoundingClientRect().bottom || 0);
  const filterBottom = Math.max(0, els.filterStrip?.getBoundingClientRect().bottom || 0);
  const offset = Math.max(navBottom, filterBottom) + 8;
  document.documentElement.style.setProperty("--list-table-header-top", `${Math.round(offset)}px`);
}

function scheduleListHeaderOffsetSync() {
  if (stickyOffsetFrame) return;
  stickyOffsetFrame = window.requestAnimationFrame(() => {
    stickyOffsetFrame = 0;
    syncListHeaderOffset();
  });
}

function fillSelect(select, options, selected, allLabel) {
  select.innerHTML = "";
  select.append(new Option(allLabel, "all"));
  for (const option of options) {
    select.append(new Option(option, option));
  }
  select.value = selected;
}

function initFilters() {
  const options = getCategoryOptions(products, state.level2);
  fillSelect(els.level2Filter, options.level2Options, state.level2, "全部二级类目");
  fillSelect(els.level3Filter, options.level3Options, state.level3, "全部三级类目");
  fillSelect(
    els.sourceFilter,
    [...new Set(products.map((item) => item.source || "未知"))].sort(),
    state.source,
    "全部来源",
  );
  fillSelect(
    els.priceFilter,
    PRICE_BANDS.map((band) => band.label),
    state.priceBand,
    "全部价格带",
  );
}

function resetProductPage() {
  state.productPage = 1;
}

function bindEvents() {
  els.level2Filter.addEventListener("change", () => {
    state.level2 = els.level2Filter.value;
    state.level3 = "all";
    resetProductPage();
    render();
  });

  els.level3Filter.addEventListener("change", () => {
    state.level3 = els.level3Filter.value;
    resetProductPage();
    render();
  });

  els.priceFilter.addEventListener("change", () => {
    state.priceBand = els.priceFilter.value;
    resetProductPage();
    render();
  });

  els.statusFilter.addEventListener("change", () => {
    state.status = els.statusFilter.value;
    resetProductPage();
    render();
  });

  els.sourceFilter.addEventListener("change", () => {
    state.source = els.sourceFilter.value;
    resetProductPage();
    render();
  });

  els.freshnessFilter.addEventListener("change", () => {
    state.freshness = els.freshnessFilter.value;
    resetProductPage();
    render();
  });

  els.duplicateFilter.addEventListener("change", () => {
    state.duplicate = els.duplicateFilter.value;
    resetProductPage();
    render();
  });

  [els.rankMinFilter, els.rankMaxFilter].forEach((input) => {
    input.addEventListener("input", () => {
      state.rankMin = els.rankMinFilter.value;
      state.rankMax = els.rankMaxFilter.value;
      resetProductPage();
      render();
    });
  });

  els.sortFilter.addEventListener("change", () => {
    state.sortBy = els.sortFilter.value;
    resetProductPage();
    render();
  });

  els.displayModeFilter.addEventListener("change", () => {
    state.displayMode = els.displayModeFilter.value;
    resetProductPage();
    renderProducts(applyFilters(products, state));
  });

  els.resetFilters.addEventListener("click", () => {
    Object.assign(state, {
      level2: "all",
      level3: "all",
      priceBand: "all",
      status: "all",
      source: "all",
      freshness: "all",
      duplicate: "all",
      rankMin: "",
      rankMax: "",
      sortBy: "gmvIndex",
      displayMode: "flatGmv",
      productPage: 1,
    });
    render();
  });

  for (const button of els.viewButtons) {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      resetProductPage();
      for (const item of els.viewButtons) item.classList.toggle("active", item === button);
      renderProducts(applyFilters(products, state));
    });
  }

  els.productGroups.addEventListener("click", async (event) => {
    const pageButton = event.target.closest("[data-page-action]");
    if (pageButton) {
      const direction = pageButton.dataset.pageAction === "next" ? 1 : -1;
      state.productPage += direction;
      renderProducts(applyFilters(products, state));
      return;
    }

    const button = event.target.closest("[data-jid]");
    if (!button) return;
    await writeClipboardText(button.dataset.jid || "");
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = "Copy JID";
    }, 1200);
  });

  window.addEventListener("scroll", scheduleListHeaderOffsetSync, { passive: true });
  window.addEventListener("resize", scheduleListHeaderOffsetSync);
}

function getFilteredProducts() {
  return applyFilters(products, state);
}

function renderSummary(filtered) {
  const allLevel2 = new Set(products.map((item) => item.level2).filter(Boolean)).size;
  const allLevel3 = new Set(products.map((item) => item.level3).filter(Boolean)).size;
  const dedupedTotal = buildImageDedupedProducts(products).length;
  const topLevel2Rows = summarizeByCategory(products, "level2");
  const topLevel3Rows = summarizeByCategory(products, "level3");
  const topBand = summarizePriceBands(products).sort((a, b) => b.gmvIndex - a.gmvIndex)[0];

  const summary = [
    { label: "商品总数", value: formatNumber(products.length), hint: "" },
    { label: "图片去重商品数", value: formatNumber(dedupedTotal), hint: "按主图去重" },
    { label: "当前结果", value: formatNumber(filtered.length), hint: "随筛选变化" },
    { label: "二级类目", value: allLevel2, hint: "可下钻筛选" },
    { label: "三级类目", value: allLevel3, hint: "商品分组依据" },
    { label: "主力二级类目", value: formatLeadingCategories(topLevel2Rows), hint: "GMV指数 > 10" },
    { label: "主力三级类目", value: formatLeadingCategories(topLevel3Rows), hint: "GMV指数 > 10" },
    { label: "主力价格带", value: topBand?.name || "-", hint: `GMV指数 ${formatIndex(topBand?.gmvIndex)}` },
  ];

  els.summaryGrid.innerHTML = summary
    .map(
      (item) => `
        <article class="summary-tile">
          <span>${item.label}</span>
          <strong>${item.value}</strong>
          ${item.hint ? `<small>${item.hint}</small>` : ""}
        </article>
      `,
    )
    .join("");
}

function renderLevel2Table(filtered) {
  const rows = summarizeByCategory(filtered, "level2");
  els.level2Table.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>
            <button type="button" class="link-button" data-level2="${escapeAttr(row.name)}">${row.name}</button>
            <small>Top: ${row.topLevel3}</small>
          </td>
          <td>${formatNumber(row.itemCount)}</td>
          <td>${formatIndex(row.gmvIndex)}</td>
          <td>${formatIndex(row.orderIndex)}</td>
          <td>${formatPrice(row.medianPrice)}</td>
        </tr>
      `,
    )
    .join("");

  els.level2Table.querySelectorAll("[data-level2]").forEach((button) => {
    button.addEventListener("click", () => {
      state.level2 = button.dataset.level2;
      state.level3 = "all";
      resetProductPage();
      render();
    });
  });
}

function renderLevel3Bars(filtered) {
  const rows = summarizeByCategory(filtered, "level3").slice(0, 12);
  els.level3Context.textContent = state.level2 === "all" ? "全部二级类目" : state.level2;
  els.level3Bars.innerHTML = rows
    .map((row) => {
      const level2Name = row.topItem?.level2 || state.level2;
      const displayName = formatCategoryDrilldownName(level2Name, row.name);
      return renderBarRow(displayName, row.gmvIndex, row.orderIndex, row.itemCount, "level3", row.name);
    })
    .join("");

  els.level3Bars.querySelectorAll("[data-level3]").forEach((button) => {
    button.addEventListener("click", () => {
      state.level3 = button.dataset.level3;
      resetProductPage();
      render();
    });
  });
}

function renderPriceBands(filtered) {
  const rows = summarizePriceBands(filtered);
  els.priceBandBars.innerHTML = rows
    .map((row) => renderBarRow(row.name, row.gmvIndex, row.orderIndex, row.itemCount, "price"))
    .join("");
}

function renderBarRow(name, gmvIndex, orderIndex, count, kind, rawValue = name) {
  const width = Math.max(2, Math.min(100, gmvIndex));
  const attr = kind === "level3" ? `data-level3="${escapeAttr(rawValue)}"` : "";
  return `
    <button type="button" class="bar-row" ${attr}>
      <span class="bar-label">
        <strong>${name}</strong>
        <small>${formatNumber(count)} 个商品</small>
      </span>
      <span class="bar-track"><i style="width:${width}%"></i></span>
      <span class="bar-values">
        <b>${formatIndex(gmvIndex)}</b>
        <small>${formatIndex(orderIndex)}</small>
      </span>
    </button>
  `;
}

function getProductPageSize() {
  return state.view === "list" ? LIST_PAGE_SIZE : CARD_PAGE_SIZE;
}

function getPagedItems(items) {
  const pageSize = getProductPageSize();
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(Number(state.productPage) || 1, 1), totalPages);
  state.productPage = currentPage;
  const start = (currentPage - 1) * pageSize;
  const end = Math.min(start + pageSize, items.length);

  return {
    currentPage,
    totalPages,
    pageSize,
    startIndex: items.length ? start + 1 : 0,
    endIndex: end,
    items: items.slice(start, end),
  };
}

function getPagedDisplayGroups(displayGroups, pageItems) {
  if (state.displayMode === "flatGmv") {
    return [{ ...displayGroups[0], items: pageItems }];
  }

  const pageIds = new Set(pageItems.map((item) => item.id));
  return displayGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => pageIds.has(item.id)),
    }))
    .filter((group) => group.items.length);
}

function renderPagination(meta, totalItems) {
  if (!totalItems) return "";

  return `
    <nav class="product-pagination" aria-label="商品分页">
      <span>${formatNumber(meta.startIndex)}-${formatNumber(meta.endIndex)} / ${formatNumber(totalItems)}</span>
      <div class="pagination-buttons">
        <button type="button" data-page-action="prev" ${meta.currentPage <= 1 ? "disabled" : ""}>上一页</button>
        <strong>${formatNumber(meta.currentPage)} / ${formatNumber(meta.totalPages)}</strong>
        <button type="button" data-page-action="next" ${meta.currentPage >= meta.totalPages ? "disabled" : ""}>下一页</button>
      </div>
    </nav>
  `;
}

function renderProducts(filtered) {
  const dedupedProducts = buildImageDedupedProducts(filtered);
  const displayGroups = getProductDisplayGroups(dedupedProducts, state.displayMode);
  const orderedItems = displayGroups.flatMap((group) => group.items);
  const pageMeta = getPagedItems(orderedItems);
  const pagedGroups = getPagedDisplayGroups(displayGroups, pageMeta.items);
  els.resultCount.innerHTML = `
    <strong>${formatNumber(filtered.length)} 条原始商品记录</strong>
    <small>${formatNumber(dedupedProducts.length)} 个图片去重商品</small>
  `;
  const displayNotes = {
    flatGmv: "不分组，按 GMV指数 降序展示。",
    level2: "按二级类目分组，组内默认按 GMV指数 降序。",
    level3: "按三级类目分组，组内默认按 GMV指数 降序。",
  };
  const pageNote = state.view === "list" ? "列表模式每页 100 个商品。" : "卡片模式每页 60 个商品。";
  els.resultNote.textContent = `${displayNotes[state.displayMode]} ${pageNote}`;
  els.productGroups.className = `product-groups ${state.view === "list" ? "list-mode" : ""}`;

  if (!filtered.length) {
    els.productGroups.innerHTML = products.length
      ? `<div class="empty-state">当前筛选没有匹配商品，请调整筛选条件。</div>`
      : `<div class="empty-state">当前类目暂无数据，请检查总数据源中的类目字段。</div>`;
    return;
  }

  if (state.view === "list") {
    els.productGroups.innerHTML = `
      ${renderProductList(pageMeta.items)}
      ${renderPagination(pageMeta, dedupedProducts.length)}
    `;
    return;
  }

  if (state.displayMode === "flatGmv") {
    els.productGroups.innerHTML = `
      <div class="product-grid flat-product-grid">
        ${pageMeta.items.map(renderProductCard).join("")}
      </div>
      ${renderPagination(pageMeta, dedupedProducts.length)}
    `;
    return;
  }

  els.productGroups.innerHTML = pagedGroups
    .map((group) => {
      const sorted = group.items;
      const subtitle =
        state.displayMode === "level2"
          ? `${formatNumber(sorted.length)} 个商品`
          : sorted[0]?.level2 || "";
      return `
        <section class="category-group">
          <div class="group-heading">
            <div>
              <h3>${group.name}</h3>
              <p>${subtitle}</p>
            </div>
            <span>GMV指数 ${formatIndex(group.gmvIndex)}</span>
          </div>
          <div class="product-grid">
            ${sorted.map(renderProductCard).join("")}
          </div>
        </section>
      `;
    })
    .join("") + renderPagination(pageMeta, dedupedProducts.length);
}

function renderProductList(items) {
  return `
    <div class="product-table-wrap">
      <table class="product-table">
        <thead>
          <tr>
            <th>rank</th>
            <th>主图</th>
            <th>二级类目</th>
            <th>三级类目</th>
            <th>价格指数</th>
            <th>GMV指数</th>
            <th>订单指数</th>
            <th>来源</th>
            <th>新老品</th>
            <th>重复款</th>
            <th>审核标签</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(renderProductRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderProductRow(item) {
  const statusClass = item.status === "通过" ? "approved" : "rejected";
  const freshnessClass = item.freshness === "新品" ? "fresh" : item.freshness === "老品" ? "aged" : "";
  const duplicateText = item.isDuplicateImage ? `重复 · ${item.duplicateImageCount}` : "不重复";
  const jidButton = item.jid
    ? `<button class="copy-jid-button" type="button" data-jid="${escapeAttr(item.jid)}">Copy JID</button>`
    : "";

  return `
    <tr>
      <td><strong>${item.rank}</strong></td>
      <td><img class="product-thumb" src="${escapeAttr(item.image)}" alt="${escapeAttr(item.level3)} 商品主图" loading="lazy" /></td>
      <td>${escapeAttr(item.level2 || "未知")}</td>
      <td>${escapeAttr(item.level3 || "未知")}</td>
      <td>${escapeAttr(item.priceDisplay || formatPrice(item.priceMid))}</td>
      <td><strong class="index-value">${formatIndex(item.gmvIndex)}</strong></td>
      <td>${formatIndex(item.orderIndex)}</td>
      <td><span class="signal-pill source">${escapeAttr(item.source || "未知")}</span></td>
      <td><span class="signal-pill ${freshnessClass}">${escapeAttr(item.freshness || "未知")}</span></td>
      <td><span class="signal-pill ${item.isDuplicateImage ? "duplicate" : ""}">${duplicateText}</span></td>
      <td><span class="list-status ${statusClass}">${escapeAttr(item.status || "未知")}</span></td>
      <td>${jidButton}</td>
    </tr>
  `;
}

function renderProductCard
(item) {
  const statusClass = item.status === "通过" ? "approved" : "rejected";
  const freshnessClass = item.freshness === "新品" ? "fresh" : item.freshness === "老品" ? "aged" : "";
  const duplicateTag = item.isDuplicateImage
    ? `<span class="signal-pill duplicate">图片重复款 · ${item.duplicateImageCount}</span>`
    : `<span class="signal-pill">图片不重复</span>`;
  const sourceTag = `<span class="signal-pill source">来源：${escapeAttr(item.source || "未知")}</span>`;
  const jidButton = item.jid
    ? `<button class="copy-jid-button" type="button" data-jid="${escapeAttr(item.jid)}">Copy JID</button>`
    : "";

  return `
    <article class="product-card">
      <div class="image-wrap">
        <img src="${escapeAttr(item.image)}" alt="${escapeAttr(item.level3)} 商品主图" loading="lazy" />
        <span class="image-rank-badge">rank: ${item.rank}</span>
        <span class="status ${statusClass}">${item.status}</span>
      </div>
      <div class="product-body">
        <p class="category-path">${formatCategoryDrilldownName(item.level2, item.level3)}</p>
        <div class="metric-line price-line">
          <span>价格指数</span>
          <strong>${escapeAttr(item.priceDisplay || formatPrice(item.priceMid))}</strong>
        </div>
        <div class="index-pair">
          <div>
            <span>GMV指数</span>
            <strong>${formatIndex(item.gmvIndex)}</strong>
          </div>
          <div>
            <span>订单指数</span>
            <strong>${formatIndex(item.orderIndex)}</strong>
          </div>
        </div>
        <div class="signal-row">
          ${sourceTag}
          <span class="signal-pill ${freshnessClass}">${item.freshness}</span>
          ${duplicateTag}
          ${jidButton}
        </div>
      </div>
    </article>
  `;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const groupName = item[key] || "未分类";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(item);
  }
  return groups;
}

function sumIndex(items) {
  return items.reduce((sum, item) => sum + item.gmvIndex, 0);
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function syncControls() {
  const options = getCategoryOptions(products, state.level2);
  fillSelect(els.level2Filter, options.level2Options, state.level2, "全部二级类目");
  fillSelect(els.level3Filter, options.level3Options, state.level3, "全部三级类目");
  els.priceFilter.value = state.priceBand;
  els.statusFilter.value = state.status;
  els.sourceFilter.value = state.source;
  els.freshnessFilter.value = state.freshness;
  els.duplicateFilter.value = state.duplicate;
  els.rankMinFilter.value = state.rankMin;
  els.rankMaxFilter.value = state.rankMax;
  els.sortFilter.value = state.sortBy;
  els.displayModeFilter.value = state.displayMode;
}

function render() {
  syncControls();
  const filtered = getFilteredProducts();
  renderSummary(filtered);
  renderLevel2Table(filtered);
  renderLevel3Bars(filtered);
  renderPriceBands(filtered);
  renderProducts(filtered);
  scheduleListHeaderOffsetSync();
}

if (shouldBootDashboard) {
  unlockDashboard();
}
