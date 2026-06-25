export const PRICE_BANDS = [
  { label: "<10", min: 0, max: 10 },
  { label: "10-15", min: 10, max: 15 },
  { label: "15-20", min: 15, max: 20 },
  { label: "20-25", min: 20, max: 25 },
  { label: "25-30", min: 25, max: 30 },
  { label: "30-40", min: 30, max: 40 },
  { label: "40-60", min: 40, max: 60 },
  { label: "60+", min: 60, max: Infinity },
];

const roundIndex = (value) => Math.round(value * 100) / 100;

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

export function parseCategoryPath(value) {
  const parts = String(value || "")
    .split(/\s*(?:>|\/)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 3) {
    return { level1: parts[0], level2: parts[1], level3: parts[2] };
  }

  if (parts.length === 2) {
    return { level1: parts[0], level2: parts[1], level3: parts[1] };
  }

  const level1 = parts[0] || "Uncategorized";
  return { level1, level2: "Uncategorized", level3: "Uncategorized" };
}

export function resolveSectionFromLevel1(level1) {
  const normalized = normalizeCategoryName(level1);

  for (const [section, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return section;
    }
  }

  return "unknown";
}

export function filterProductsBySection(products, section) {
  const targetSection = String(section || "").trim().toLowerCase();
  return products.filter((item) => {
    const itemSection =
      (item.section && String(item.section).trim().toLowerCase()) ||
      resolveSectionFromLevel1(item.level1 || item.categoryPath || "");
    return itemSection === targetSection;
  });
}

export function getPriceBand(price) {
  if (typeof price !== "number" || Number.isNaN(price)) {
    return "未知";
  }

  const band = PRICE_BANDS.find((item) => price >= item.min && price < item.max);
  return band ? band.label : "未知";
}

export function parsePriceRange(value) {
  const numbers = String(value || "").match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (!numbers.length) return { priceMin: null, priceMax: null, priceMid: null };

  const priceMin = Math.min(...numbers);
  const priceMax = Math.max(...numbers);
  return { priceMin, priceMax, priceMid: priceMax };
}

export function computeIndexes(products) {
  const totalGmv = products.reduce((sum, item) => sum + Number(item.gmv || 0), 0);
  const totalOrders = products.reduce((sum, item) => sum + Number(item.orders || 0), 0);

  return products.map((item) => ({
    ...item,
    priceBand: getPriceBand(item.priceMid),
    gmvIndex: totalGmv ? roundIndex((Number(item.gmv || 0) / totalGmv) * 100) : 0,
    orderIndex: totalOrders ? roundIndex((Number(item.orders || 0) / totalOrders) * 100) : 0,
  }));
}

export function buildImageDedupedProducts(products) {
  const groups = new Map();

  for (const item of products) {
    const image = String(item.image || "").trim();
    const key = image || `record:${item.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const mergedProducts = [...groups.values()].map((items, groupIndex) => {
    const representative = [...items].sort((a, b) => Number(b.gmv || 0) - Number(a.gmv || 0))[0] || {};
    const prices = items
      .flatMap((item) => [item.priceMin, item.priceMax, item.priceMid])
      .filter(isFiniteNumber);
    const priceMin = prices.length ? Math.min(...prices) : null;
    const priceMax = prices.length ? Math.max(...prices) : null;
    const statuses = [...new Set(items.map((item) => item.status).filter(Boolean))];
    const sources = [...new Set(items.map((item) => item.source).filter(Boolean))].sort();
    const freshnessValues = items.map((item) => item.freshness);
    const freshness = resolveGroupedFreshness(freshnessValues, representative.freshness);
    const jids = [...new Set(items.map((item) => item.jid).filter(Boolean))];

    return {
      ...representative,
      id: `image:${representative.image || groupIndex}`,
      originalIds: items.map((item) => item.id),
      duplicateImageCount: items.length,
      isDuplicateImage: items.length > 1,
      gmv: items.reduce((sum, item) => sum + Number(item.gmv || 0), 0),
      orders: items.reduce((sum, item) => sum + Number(item.orders || 0), 0),
      priceMin,
      priceMax,
      priceMid: priceMax,
      priceDisplay:
        priceMin !== null && priceMax !== null && priceMin !== priceMax
          ? `${formatPriceValue(priceMin)}-${formatPriceValue(priceMax)}`
          : formatPriceValue(priceMax),
      status: statuses.length > 1 ? "mixed" : statuses[0] || representative.status,
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

export function getFreshnessLabel(updatedAt, now = new Date()) {
  const parsedDate = parseUpdateDate(updatedAt);
  if (!parsedDate) return "未知";

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const diffDays = (now.getTime() - parsedDate.getTime()) / millisecondsPerDay;
  return diffDays <= 90 ? "新品" : "老品";
}

export function enrichProductSignals(products, now = new Date()) {
  const imageCounts = products.reduce((counts, item) => {
    const image = item.image || "";
    counts.set(image, (counts.get(image) || 0) + 1);
    return counts;
  }, new Map());
  const rankMap = [...products]
    .sort((a, b) => Number(b.gmv || 0) - Number(a.gmv || 0))
    .reduce((map, item, index) => {
      map.set(item.id, index + 1);
      return map;
    }, new Map());

  return products.map((item) => {
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

export function applyFilters(products, filters = {}) {
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

  const filtered = products.filter((item) => {
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

export function getCategoryOptions(products, selectedLevel2 = "all") {
  const level2Options = [...new Set(products.map((item) => item.level2).filter(Boolean))].sort();
  const level3Source =
    selectedLevel2 === "all"
      ? products
      : products.filter((item) => item.level2 === selectedLevel2);
  const level3Options = [...new Set(level3Source.map((item) => item.level3).filter(Boolean))].sort();

  return { level2Options, level3Options };
}

export function summarizeByCategory(products, key) {
  const indexedProducts = computeIndexes(products);
  const totalGmv = products.reduce((sum, item) => sum + Number(item.gmv || 0), 0);
  const totalOrders = products.reduce((sum, item) => sum + Number(item.orders || 0), 0);
  const groups = new Map();

  for (const item of products) {
    const name = item[key] || "未分组";
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    groups.get(name).push(item);
  }

  return [...groups.entries()]
    .map(([name, items]) => {
      const groupGmv = items.reduce((sum, item) => sum + Number(item.gmv || 0), 0);
      const groupOrders = items.reduce((sum, item) => sum + Number(item.orders || 0), 0);
      const prices = items
        .map((item) => item.priceMid)
        .filter((price) => typeof price === "number" && !Number.isNaN(price))
        .sort((a, b) => a - b);
      const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : null;
      const topLevel3 = getTopLevel3(items);

      return {
        name,
        itemCount: items.length,
        gmvIndex: totalGmv ? roundIndex((groupGmv / totalGmv) * 100) : 0,
        orderIndex: totalOrders ? roundIndex((groupOrders / totalOrders) * 100) : 0,
        itemIndex: products.length ? roundIndex((items.length / products.length) * 100) : 0,
        medianPrice,
        topLevel3,
        topItem: indexedProducts
          .filter((item) => item[key] === name)
          .sort((a, b) => b.gmvIndex - a.gmvIndex)[0],
      };
    })
    .sort((a, b) => b.gmvIndex - a.gmvIndex);
}

export function getTopLevel3(products) {
  const summary = summarizeSimple(products, "level3");
  return summary.length ? summary[0].name : "未分组";
}

export function formatCategoryDrilldownName(level2, level3) {
  const second = level2 || "未分组";
  const third = level3 || "";
  if (!third || third === "未分组" || third === "未分类" || third === "Uncategorized" || third === second) {
    return second;
  }
  return `${second} > ${third}`;
}

export function formatLeadingCategories(rows, threshold = 10) {
  const leading = rows.filter((row) => row.gmvIndex > threshold);
  const visible = leading.length ? leading : rows.slice(0, 1);
  return visible.map((row) => `${row.name} ${row.gmvIndex.toFixed(2)}`).join(" / ");
}

export function getProductDisplayGroups(products, displayMode = "flatGmv") {
  const sortedProducts = [...products].sort((a, b) => b.gmvIndex - a.gmvIndex);

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
    const groupName = item[groupKey] || "未分组";
    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    groups.get(groupName).push(item);
  }

  return [...groups.entries()]
    .map(([name, items]) => ({
      name,
      items,
      gmvIndex: items.reduce((sum, item) => sum + item.gmvIndex, 0),
    }))
    .sort((a, b) => b.gmvIndex - a.gmvIndex);
}

export function summarizePriceBands(products) {
  const total = products.length || 1;
  const withIndexes = computeIndexes(products);
  const bands = PRICE_BANDS.map((band) => {
    const items = withIndexes.filter((item) => item.priceBand === band.label);
    return {
      name: band.label,
      itemCount: items.length,
      itemIndex: roundIndex((items.length / total) * 100),
      gmvIndex: roundIndex(items.reduce((sum, item) => sum + item.gmvIndex, 0)),
      orderIndex: roundIndex(items.reduce((sum, item) => sum + item.orderIndex, 0)),
    };
  });

  return bands.filter((band) => band.itemCount > 0);
}

function summarizeSimple(products, key) {
  const groups = new Map();
  for (const item of products) {
    const name = item[key] || "未分组";
    const current = groups.get(name) || { name, gmv: 0 };
    current.gmv += Number(item.gmv || 0);
    groups.set(name, current);
  }
  return [...groups.values()].sort((a, b) => b.gmv - a.gmv);
}
