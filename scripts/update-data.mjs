import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSectionFromLevel1 } from "../app-logic.mjs";

const SHEET_ID = "1sNXgaBwFEe-oDhJYtCvF64Hzot8fy4qtind-Q3qqwL8";
const SHEET_NAME = "2025-6-8";
const ACCESS_CODE = "xuanpin2026";
const OUTPUT_PATH = path.join("data", "products-all-data.enc.js");

const REQUIRED_HEADERS = ["商品主图", "类目", "参考价格", "成交订单", "GMV", "审核状态"];

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

function normalizeRows(rows) {
  const headers = rows[0].map((header) => header.trim());
  for (const header of REQUIRED_HEADERS) {
    if (!headers.includes(header)) {
      throw new Error(`Google Sheet 缺少必要字段：${header}`);
    }
  }

  return rows.slice(1).map((row, index) => {
    const source = Object.fromEntries(headers.map((header, colIndex) => [header, row[colIndex] ?? ""]));
    const [priceMin, priceMax, priceMid] = parsePrice(source["参考价格"]);
    const [level1, level2, level3] = splitCategory(source["类目"]);
    const section = resolveSectionFromLevel1(level1);

    return {
      id: index + 1,
      image: source["商品主图"],
      categoryPath: source["类目"],
      level1,
      level2,
      level3,
      section,
      priceLabel: source["参考价格"],
      priceMin,
      priceMax,
      priceMid,
      orders: toNumber(source["成交订单"]),
      gmv: toNumber(source.GMV),
      status: source["审核状态"],
      updatedAt: source["更新时间"] || "",
      source: source["来源"] || "未知",
      jid: source["J-ID"] || "",
    };
  });
}

async function readExistingSourceHash(outputPath) {
  try {
    const text = await fs.readFile(outputPath, "utf8");
    const match = text.match(/window\.ENCRYPTED_PRODUCTS\s*=\s*({[\s\S]*});?\s*$/);
    return match ? JSON.parse(match[1]).sourceHash || "" : "";
  } catch {
    return "";
  }
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

async function main() {
  const sourceUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Google Sheet 读取失败：${response.status} ${response.statusText}`);
  }

  const csv = await response.text();
  const rows = parseCsv(csv);
  const records = normalizeRows(rows);
  const sourceHash = crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");
  const existingHash = await readExistingSourceHash(OUTPUT_PATH);

  if (existingHash === sourceHash) {
    console.log(`Google Sheet 数据无变化，跳过重建。rows=${records.length}`);
    return;
  }

  const encrypted = encryptPayload(records, sourceHash, sourceUrl);
  await writeEncryptedFile(OUTPUT_PATH, encrypted);
  console.log(`已更新加密数据：rows=${records.length}, hash=${sourceHash.slice(0, 12)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
