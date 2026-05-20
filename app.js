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

function getPriceBand(price) {
  if (typeof price !== "number" || Number.isNaN(price)) {
    return "未知";
  }
  const band = PRICE_BANDS.find((item) => price >= item.min && price < item.max);
  return band ? band.label : "未知";
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

function enrichProductSignals(items) {
  const imageCounts = items.reduce((counts, item) => {
    const image = item.image || "";
    counts.set(image, (counts.get(image) || 0) + 1);
    return counts;
  }, new Map());

  return items.map((item) => {
    const duplicateImageCount = imageCounts.get(item.image || "") || 0;

    return {
      ...item,
      duplicateImageCount,
      isDuplicateImage: duplicateImageCount > 1,
    };
  });
}

function applyFilters(items, filters = {}) {
  const level2 = filters.level2 || "all";
  const level3 = filters.level3 || "all";
  const status = filters.status || "all";
  const priceBand = filters.priceBand || "all";
  const sortBy = filters.sortBy || "gmvIndex";

  const filtered = items.filter((item) => {
    if (level2 !== "all" && item.level2 !== level2) return false;
    if (level3 !== "all" && item.level3 !== level3) return false;
    if (status !== "all" && item.status !== status) return false;
    if (priceBand !== "all" && getPriceBand(item.priceMid) !== priceBand) return false;
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
  if (!third || third === "未分类" || third === second) {
    return second;
  }
  return `${second} > ${third}`;
}

function formatLeadingCategories(rows, threshold = 10) {
  const leading = rows.filter((row) => row.gmvIndex > threshold);
  const visible = leading.length ? leading : rows.slice(0, 1);
  return visible.map((row) => `${row.name} ${row.gmvIndex.toFixed(2)}`).join(" / ");
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
const ACCESS_STORAGE_KEY = "offsiteSelectionAccessCode";
const state = {
  level2: "all",
  level3: "all",
  priceBand: "all",
  status: "all",
  sortBy: "gmvIndex",
  view: "card",
};

const els = {
  summaryGrid: document.querySelector("#summaryGrid"),
  level2Filter: document.querySelector("#level2Filter"),
  level3Filter: document.querySelector("#level3Filter"),
  priceFilter: document.querySelector("#priceFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  sortFilter: document.querySelector("#sortFilter"),
  resetFilters: document.querySelector("#resetFilters"),
  level2Table: document.querySelector("#level2Table"),
  level3Bars: document.querySelector("#level3Bars"),
  level3Context: document.querySelector("#level3Context"),
  priceBandBars: document.querySelector("#priceBandBars"),
  productGroups: document.querySelector("#productGroups"),
  resultCount: document.querySelector("#resultCount"),
  resultNote: document.querySelector("#resultNote"),
  viewButtons: document.querySelectorAll("[data-view]"),
};

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function decryptProducts(password) {
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

function getStoredAccessCode() {
  return sessionStorage.getItem(ACCESS_STORAGE_KEY);
}

function redirectToUnlock() {
  window.location.href = "./index.html";
}

async function unlockDashboard() {
  const password = getStoredAccessCode();
  if (!password) {
    redirectToUnlock();
    return;
  }

  try {
    products = enrichProductSignals(await decryptProducts(password));
    initFilters();
    if (!hasBoundDashboardEvents) {
      bindEvents();
      hasBoundDashboardEvents = true;
    }
    render();
  } catch {
    sessionStorage.removeItem(ACCESS_STORAGE_KEY);
    redirectToUnlock();
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
    els.priceFilter,
    PRICE_BANDS.map((band) => band.label),
    state.priceBand,
    "全部价格带",
  );
}

function bindEvents() {
  els.level2Filter.addEventListener("change", () => {
    state.level2 = els.level2Filter.value;
    state.level3 = "all";
    render();
  });

  els.level3Filter.addEventListener("change", () => {
    state.level3 = els.level3Filter.value;
    render();
  });

  els.priceFilter.addEventListener("change", () => {
    state.priceBand = els.priceFilter.value;
    render();
  });

  els.statusFilter.addEventListener("change", () => {
    state.status = els.statusFilter.value;
    render();
  });

  els.sortFilter.addEventListener("change", () => {
    state.sortBy = els.sortFilter.value;
    render();
  });

  els.resetFilters.addEventListener("click", () => {
    Object.assign(state, {
      level2: "all",
      level3: "all",
      priceBand: "all",
      status: "all",
      sortBy: "gmvIndex",
    });
    render();
  });

  for (const button of els.viewButtons) {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      for (const item of els.viewButtons) item.classList.toggle("active", item === button);
      renderProducts(applyFilters(products, state));
    });
  }
}

function getFilteredProducts() {
  return applyFilters(products, state);
}

function renderSummary(filtered) {
  const allLevel2 = new Set(products.map((item) => item.level2)).size;
  const allLevel3 = new Set(products.map((item) => item.level3)).size;
  const topLevel2Rows = summarizeByCategory(products, "level2");
  const topLevel3Rows = summarizeByCategory(products, "level3");
  const topBand = summarizePriceBands(products).sort((a, b) => b.gmvIndex - a.gmvIndex)[0];

  const summary = [
    { label: "商品总数", value: formatNumber(products.length), hint: "" },
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

function renderProducts(filtered) {
  const groups = groupBy(filtered, "level3");
  const totalGroups = [...groups.entries()].sort((a, b) => sumIndex(b[1]) - sumIndex(a[1]));
  els.resultCount.textContent = `${formatNumber(filtered.length)} 个商品`;
  els.resultNote.textContent =
    state.view === "card"
      ? "按三级类目分组，默认按 GMV指数 排序。"
      : "图片墙模式保留核心指数，方便快速扫款。";
  els.productGroups.className = `product-groups ${state.view === "wall" ? "wall-mode" : ""}`;

  if (!filtered.length) {
    els.productGroups.innerHTML = `<div class="empty-state">当前筛选没有匹配商品，请调整筛选条件。</div>`;
    return;
  }

  els.productGroups.innerHTML = totalGroups
    .map(([name, items]) => {
      const sorted = [...items].sort((a, b) => b.gmvIndex - a.gmvIndex);
      const groupGmvIndex = sorted.reduce((sum, item) => sum + item.gmvIndex, 0);
      return `
        <section class="category-group">
          <div class="group-heading">
            <div>
              <h3>${name}</h3>
              <p>${sorted[0]?.level2 || ""}</p>
            </div>
            <span>GMV指数 ${formatIndex(groupGmvIndex)}</span>
          </div>
          <div class="product-grid">
            ${sorted.map(renderProductCard).join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function renderProductCard(item) {
  const statusClass = item.status === "通过" ? "approved" : "rejected";
  const duplicateTag = item.isDuplicateImage
    ? `<span class="signal-pill duplicate">图片重复款 · ${item.duplicateImageCount}</span>`
    : `<span class="signal-pill">图片不重复</span>`;

  return `
    <article class="product-card">
      <div class="image-wrap">
        <img src="${escapeAttr(item.image)}" alt="${escapeAttr(item.level3)} 商品主图" loading="lazy" />
        <span class="status ${statusClass}">${item.status}</span>
      </div>
      <div class="product-body">
        <p class="category-path">${item.level2} / ${item.level3}</p>
        <div class="metric-line price-line">
          <span>价格指数</span>
          <strong>${formatPrice(item.priceMid)}</strong>
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
          ${duplicateTag}
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
  els.sortFilter.value = state.sortBy;
}

function render() {
  syncControls();
  const filtered = getFilteredProducts();
  renderSummary(filtered);
  renderLevel2Table(filtered);
  renderLevel3Bars(filtered);
  renderPriceBands(filtered);
  renderProducts(filtered);
}

unlockDashboard();
