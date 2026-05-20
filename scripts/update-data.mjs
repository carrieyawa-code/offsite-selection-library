import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SHEET_ID = "1sNXgaBwFEe-oDhJYtCvF64Hzot8fy4qtind-Q3qqwL8";
const SHEET_GID = "0";
const SOURCE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
const ACCESS_CODE = "xuanpin2026";
const OUTPUT_PATH = path.join("data", "products-data.enc.js");

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
  const parts = String(value || "").split(">").map((part) => part.trim());
  const level1 = parts[0] || "Women's Clothing";
  const level2 = parts[1] || "Uncategorized";
  const level3 = parts[2] || level2;
  return [level1, level2, level3];
}

function toNumber(value) {
  const numeric = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeRows(rows) {
  const headers = rows[0].map((header) => header.trim());
  const required = ["商品主图", "类目", "参考价格", "成交订单", "GMV", "审核状态"];
  for (const header of required) {
    if (!headers.includes(header)) {
      throw new Error(`Google Sheet 缺少必需字段：${header}`);
    }
  }

  return rows.slice(1).map((row, index) => {
    const source = Object.fromEntries(headers.map((header, colIndex) => [header, row[colIndex] ?? ""]));
    const [priceMin, priceMax, priceMid] = parsePrice(source["参考价格"]);
    const [level1, level2, level3] = splitCategory(source["类目"]);

    return {
      id: index + 1,
      image: source["商品主图"],
      categoryPath: source["类目"],
      level1,
      level2,
      level3,
      priceLabel: source["参考价格"],
      priceMin,
      priceMax,
      priceMid,
      orders: toNumber(source["成交订单"]),
      gmv: toNumber(source.GMV),
      status: source["审核状态"],
      updatedAt: source["更新日期"] || "",
    };
  });
}

async function readExistingSourceHash() {
  try {
    const text = await fs.readFile(OUTPUT_PATH, "utf8");
    const match = text.match(/window\.ENCRYPTED_PRODUCTS\s*=\s*({[\s\S]*});?\s*$/);
    return match ? JSON.parse(match[1]).sourceHash || "" : "";
  } catch {
    return "";
  }
}

function encryptPayload(records, sourceHash) {
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
    sourceUrl: SOURCE_URL,
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

async function main() {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Google Sheet 读取失败：${response.status} ${response.statusText}`);
  }

  const csv = await response.text();
  const rows = parseCsv(csv);
  const records = normalizeRows(rows);
  const sourceHash = crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");
  const existingHash = await readExistingSourceHash();

  if (existingHash === sourceHash) {
    console.log(`Google Sheet 数据无变化，跳过重建。rows=${records.length}`);
    return;
  }

  const encrypted = encryptPayload(records, sourceHash);
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(
    OUTPUT_PATH,
    `window.ENCRYPTED_PRODUCTS = ${JSON.stringify(encrypted)};\n`,
    "utf8",
  );
  console.log(`已更新加密数据：rows=${records.length}, hash=${sourceHash.slice(0, 12)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
