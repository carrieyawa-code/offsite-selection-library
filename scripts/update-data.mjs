import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSectionFromLevel1 } from "../app-logic.mjs";

const SHEET_ID = "1sNXgaBwFEe-oDhJYtCvF64Hzot8fy4qtind-Q3qqwL8";
const SHEET_NAME = "2026-6-25";
const ACCESS_CODE = "xuanpin2026";
const OUTPUT_DIR = path.join("data");
const OUTPUT_PATH = path.join("data", "products-all-data.enc.js");
const SECTION_FILES = {
  women: "products-women-data.enc.js",
  men: "products-men-data.enc.js",
  underwear: "products-underwear-data.enc.js",
  sports: "products-sports-data.enc.js",
};

const FIELD_ALIASES = {
  image: ["商品主图", "主图", "图片", "image", "Image"],
  category: ["类目", "分类", "category", "Category"],
  price: ["参考价格", "参考价", "价格", "price", "Price"],
  orders: ["成交订单", "订单数", "orders", "Orders"],
  gmv: ["GMV", "gmv"],
  status: ["审核状态", "审核标签", "状态", "status", "Status"],
  updatedAt: ["更新时间", "更新日期", "updatedAt", "Updated At"],
  source: ["来源", "source", "Source"],
  jid: ["J-ID", "JID", "jid"],
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function parsePrice(value) {
  const numbers = String(value).match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (!numbers.length) return [null, null, null];
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return [low, high, (low + high) / 2];
}

function splitCategory(value) {
  const parts = String(value || "")
    .split(/\s*(?:>|\/)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 3) {
    return [parts[0], parts[1], parts[2]];
  }

  if (parts.length === 2) {
    return [parts[0], parts[1], parts[1]];
  }

  const level1 = parts[0] || "Uncategorized";
  return [level1, "Uncategorized", "Uncategorized"];
}

function toNumber(value) {
  const numeric = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeHeader(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function pickField(source, aliases) {
  const entries = Object.entries(source);
  const normalizedAliases = aliases.map(normalizeHeader);
  for (const [header, value] of entries) {
    if (normalizedAliases.includes(normalizeHeader(header))) return value ?? "";
  }
  return "";
}

function assertRequiredField(fieldName, value) {
  if (!String(value || "").trim()) {
    throw new Error(`Google Sheet 缺少必要字段：${fieldName}`);
  }
}

function normalizeRows(rows) {
  const headers = (rows[0] || []).map((header) => String(header || "").trim());

  return rows.slice(1).map((row, index) => {
    const sourceRow = Object.fromEntries(headers.map((header, colIndex) => [header, row[colIndex] ?? ""]));
    const image = pickField(sourceRow, FIELD_ALIASES.image);
    const categoryPath = pickField(sourceRow, FIELD_ALIASES.category);
    const priceLabel = pickField(sourceRow, FIELD_ALIASES.price);
    const gmv = pickField(sourceRow, FIELD_ALIASES.gmv);

    assertRequiredField("商品主图", image);
    assertRequiredField("类目", categoryPath);
    assertRequiredField("GMV", gmv);

    const [priceMin, priceMax, priceMid] = parsePrice(priceLabel);
    const [level1, level2, level3] = splitCategory(categoryPath);
    const section = resolveSectionFromLevel1(level1);

    return {
      id: index + 1,
      image,
      categoryPath,
      level1,
      level2,
      level3,
      section,
      priceLabel,
      priceMin,
      priceMax,
      priceMid,
      orders: toNumber(pickField(sourceRow, FIELD_ALIASES.orders)),
      gmv: toNumber(gmv),
      status: pickField(sourceRow, FIELD_ALIASES.status) || "未知",
      updatedAt: pickField(sourceRow, FIELD_ALIASES.updatedAt),
      source: pickField(sourceRow, FIELD_ALIASES.source) || "未知",
      jid: pickField(sourceRow, FIELD_ALIASES.jid),
    };
  });
}

function encryptPayload(records, sourceHash, sourceUrl) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const iterations = 210000;
  const key = crypto.pbkdf2Sync(ACCESS_CODE, salt, iterations, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.from(JSON.stringify(records), "utf8");
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    source: "google_sheets",
    sourceSheet: SHEET_NAME,
    sourceUrl,
    sourceHash,
    generatedAt: new Date().toISOString(),
    kdf: "PBKDF2-SHA256",
    cipher: "AES-256-GCM",
    iterations,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

async function writeEncryptedFile(outputPath, encrypted) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `window.ENCRYPTED_PRODUCTS = ${JSON.stringify(encrypted)};\n`, "utf8");
}

function readEncryptedPayload(text) {
  const match = text.match(/window\.ENCRYPTED_PRODUCTS\s*=\s*({[\s\S]*});?\s*$/);
  if (!match) {
    throw new Error("missing encrypted payload");
  }
  return JSON.parse(match[1]);
}

async function decryptEncryptedFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const encrypted = readEncryptedPayload(text);
  const keyMaterial = await crypto.webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ACCESS_CODE),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt: Buffer.from(encrypted.salt, "base64"), iterations: encrypted.iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const plainBuffer = await crypto.webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(encrypted.iv, "base64"), tagLength: 128 },
    key,
    combined,
  );
  return JSON.parse(new TextDecoder().decode(plainBuffer));
}

async function loadSourceRecords() {
  const sourceUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Google Sheet read failed: ${response.status} ${response.statusText}`);
    const csv = await response.text();
    return { records: normalizeRows(parseCsv(csv)), sourceUrl };
  } catch {
    const records = await decryptEncryptedFile(OUTPUT_PATH);
    return { records, sourceUrl: "local-total-fallback" };
  }
}

function updateDashboardConfig(html, section, dataFile, dataVersion) {
  return html.replace(
    /window\.DASHBOARD_CONFIG = \{[\s\S]*?\};/,
    `window.DASHBOARD_CONFIG = {\n        section: "${section}",\n        dataFile: "${dataFile}",\n        dataVersion: "${dataVersion}"\n      };`,
  );
}

async function writeSectionDataFiles(records) {
  const grouped = new Map(Object.keys(SECTION_FILES).map((section) => [section, []]));
  for (const record of records) {
    if (grouped.has(record.section)) grouped.get(record.section).push(record);
  }

  const versions = {};
  for (const [section, fileName] of Object.entries(SECTION_FILES)) {
    const sectionRecords = grouped.get(section) || [];
    const sectionHash = crypto.createHash("sha256").update(JSON.stringify(sectionRecords)).digest("hex");
    const encrypted = encryptPayload(sectionRecords, sectionHash, `${SHEET_NAME}:${section}`);
    await writeEncryptedFile(path.join(OUTPUT_DIR, fileName), encrypted);
    versions[section] = sectionHash.slice(0, 12);
  }

  return versions;
}

async function writePageConfigs(versionBySection) {
  const pages = [
    ["women.html", "women"],
    ["men.html", "men"],
    ["underwear.html", "underwear"],
    ["sports.html", "sports"],
    ["dashboard.html", "women"],
  ];

  for (const [fileName, section] of pages) {
    const filePath = path.join(".", fileName);
    const html = await fs.readFile(filePath, "utf8");
    const dataFile = SECTION_FILES[section] || SECTION_FILES.women;
    const dataVersion = versionBySection[section] || versionBySection.women || "1";
    await fs.writeFile(filePath, updateDashboardConfig(html, section, dataFile, dataVersion), "utf8");
  }
}

async function main() {
  const { records, sourceUrl } = await loadSourceRecords();
  const sourceHash = crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");

  const encryptedAll = encryptPayload(records, sourceHash, sourceUrl);
  await writeEncryptedFile(OUTPUT_PATH, encryptedAll);

  const versionBySection = await writeSectionDataFiles(records);
  await writePageConfigs(versionBySection);

  console.log(`Updated encrypted data: rows=${records.length}, hash=${sourceHash.slice(0, 12)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


