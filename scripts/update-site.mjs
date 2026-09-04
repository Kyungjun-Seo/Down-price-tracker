#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_EXCEL = resolve(ROOT, "DOWN 가격동향 계속~ - 복사본.xlsx");
const DOWN_PATH = resolve(ROOT, "down-sise.html");
const INDEX_PATH = resolve(ROOT, "index.html");
const CN_JSON_PATH = resolve(ROOT, "data", "cn-down-prices.json");
const CFD_BASE = "https://en.cfd.com.cn";
const CFD_PLATFORM = `${CFD_BASE}/index.php?s=%2FWeb%2FMarket%2Fplatform.html`;
const FX_URL = "https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipNetwork = args.has("--skip-network");
const excelArgIndex = process.argv.indexOf("--excel");
const excelPath = excelArgIndex >= 0 ? resolve(process.argv[excelArgIndex + 1]) : DEFAULT_EXCEL;

function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(html) {
  return decodeXml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function unzipEntries(buffer) {
  const eocdSignature = 0x06054b50;
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== eocdSignature) eocd -= 1;
  if (eocd < 0) throw new Error("엑셀 ZIP의 EOCD를 찾을 수 없습니다.");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("엑셀 ZIP 중앙 디렉터리가 손상되었습니다.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${method}`);
    entries.set(name, method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) =>
    decodeXml([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((part) => part[1]).join("")),
  );
}

function columnIndex(reference) {
  const letters = reference.replace(/[^A-Z]/gi, "").toUpperCase();
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function parseSheetGrid(xml, sharedStrings) {
  const grid = new Map();
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = Number.parseInt((rowMatch[1].match(/\br="(\d+)"/) || [])[1], 10);
    if (!Number.isFinite(rowNumber)) continue;
    const row = new Map();
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const reference = (cellMatch[1].match(/\br="([A-Z]+\d+)"/i) || [])[1];
      if (!reference) continue;
      const type = (cellMatch[1].match(/\bt="([^"]+)"/) || [])[1];
      let value;
      if (type === "inlineStr") {
        value = decodeXml([...cellMatch[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((part) => part[1]).join(""));
      } else {
        const raw = (cellMatch[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i) || [])[1];
        if (raw == null) continue;
        value = type === "s" ? sharedStrings[Number.parseInt(raw, 10)] : Number.parseFloat(raw);
      }
      row.set(columnIndex(reference), value);
    }
    grid.set(rowNumber, row);
  }
  return grid;
}

function excelSerialToIso(serial) {
  const date = new Date(Math.round((serial - 25569) * 86_400_000));
  return date.toISOString().slice(0, 10);
}

function extractSpeciesSeries(grid, keyword) {
  const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
  const dataRowNumber = rowNumbers.find((number) => {
    const label = grid.get(number).get(1);
    return typeof label === "string" && label.toUpperCase().includes(keyword);
  });
  if (dataRowNumber == null) throw new Error(`첫 번째 시트에서 ${keyword} 행을 찾지 못했습니다.`);

  const dataIndex = rowNumbers.indexOf(dataRowNumber);
  let headerRowNumber = null;
  for (let index = dataIndex - 1; index >= 0; index -= 1) {
    const values = [...grid.get(rowNumbers[index]).values()].filter((value) => typeof value === "number");
    const dateValues = values.filter((value) => value > 20_000 && value < 80_000);
    if (values.length >= 5 && dateValues.length / values.length > 0.7) {
      headerRowNumber = rowNumbers[index];
      break;
    }
  }
  if (headerRowNumber == null) throw new Error(`${keyword} 행 위에서 날짜 헤더를 찾지 못했습니다.`);

  const headerRow = grid.get(headerRowNumber);
  const dataRow = grid.get(dataRowNumber);
  const result = [];
  for (const [column, serial] of headerRow.entries()) {
    const value = dataRow.get(column);
    if (typeof serial === "number" && serial > 20_000 && serial < 80_000 && Number.isFinite(value)) {
      result.push({ date: excelSerialToIso(serial), value: Math.round(value * 100) / 100 });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

async function readK2Rows(path, existingCount) {
  const entries = unzipEntries(await readFile(path));
  const sheet = entries.get("xl/worksheets/sheet1.xml")?.toString("utf8");
  if (!sheet) throw new Error("엑셀의 첫 번째 시트(xl/worksheets/sheet1.xml)가 없습니다.");
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));
  const grid = parseSheetGrid(sheet, sharedStrings);
  const goose = extractSpeciesSeries(grid, "GOOSE");
  const duck = new Map(extractSpeciesSeries(grid, "DUCK").map((row) => [row.date, row.value]));
  const rows = goose
    .filter((row) => duck.has(row.date))
    .map((row) => ({ date: row.date, goose: row.value, duck: duck.get(row.date) }));

  const uniqueRows = [...new Map(rows.map((row) => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
  const minimumSafeCount = Math.max(20, Math.floor(existingCount * 0.8));
  if (uniqueRows.length < minimumSafeCount) {
    throw new Error(`엑셀 추출 결과가 ${uniqueRows.length}건뿐이어서 기존 ${existingCount}건을 안전하게 대체할 수 없습니다.`);
  }
  return uniqueRows;
}

function parseJsRows(source, variableName) {
  const match = source.match(new RegExp(`var\\s+${variableName}\\s*=\\s*\\[([\\s\\S]*?)\\n\\s*\\];`));
  if (!match) throw new Error(`${variableName} 배열을 찾지 못했습니다.`);
  return [...match[1].matchAll(/\{([^{}]+)\}/g)].map((rowMatch) => {
    const row = {};
    for (const property of rowMatch[1].matchAll(/(\w+)\s*:\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?))/g)) {
      row[property[1]] = property[2] ?? Number(property[3]);
    }
    return row;
  });
}

function replaceJsArray(source, variableName, rows, keys) {
  const pattern = new RegExp(`(  var ${variableName} = \\[\\n)[\\s\\S]*?(\\n  \\];)`);
  const body = rows.map((row) => `    { ${keys.map((key) => `${key}: ${key === "date" ? `"${row[key]}"` : row[key]}`).join(", ")} },`).join("\n");
  if (!pattern.test(source)) throw new Error(`${variableName} 배열 교체 위치를 찾지 못했습니다.`);
  return source.replace(pattern, `$1${body}$2`);
}

function tableRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1])),
  );
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Down-price-tracker/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.text();
      lastError = new Error(`${url} 요청 실패: HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_500));
  }
  throw lastError;
}

async function fetchChinaHistory() {
  const platformHtml = await fetchText(CFD_PLATFORM);
  const tableMatch = platformHtml.match(/<table\b[^>]*class="[^"]*table_body watermark[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) throw new Error("중국 시세 플랫폼 표를 찾지 못했습니다.");

  const targets = new Map();
  let category = null;
  for (const rawRow of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rawRow[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1]));
    if (["WDD", "GDD", "WGD", "GGD"].includes(cells[0])) category = cells.shift();
    const specification = cells[0];
    if (!["GDD", "GGD"].includes(category) || !["80%", "90%"].includes(specification)) continue;
    const hrefMatch = rawRow[1].match(/memberGoto\([^,]*,\s*'([^']+)'/i);
    if (!hrefMatch) throw new Error(`${category} ${specification} 상세 데이터 URL을 찾지 못했습니다.`);
    targets.set(`${category}${specification.slice(0, 2)}`, new URL(hrefMatch[1], CFD_BASE).href);
  }

  const required = ["GGD90", "GDD90", "GGD80", "GDD80"];
  for (const key of required) if (!targets.has(key)) throw new Error(`중국 시세 대상 ${key}를 찾지 못했습니다.`);

  const histories = new Map();
  for (const key of required) {
    const html = await fetchText(targets.get(key));
    const detailMatch = html.match(/<table\b[^>]*class="[^"]*table_body[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
    if (!detailMatch) throw new Error(`${key} 상세 표를 찾지 못했습니다.`);
    const rows = tableRows(detailMatch[1]);
    const header = rows[0] || [];
    const standardIndex = header.findIndex((value) => value === "GB/T 14272-2021");
    if (standardIndex < 0) throw new Error(`${key} 표에서 GB/T 14272-2021 열을 찾지 못했습니다.`);
    const values = new Map();
    for (const row of rows.slice(1)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row[0])) continue;
      const value = Number.parseFloat(row[standardIndex]);
      if (Number.isFinite(value)) values.set(row[0], value);
    }
    if (!values.size) throw new Error(`${key} 상세 표에 유효한 가격이 없습니다.`);
    histories.set(key, values);
  }

  const commonDates = [...histories.get(required[0]).keys()]
    .filter((date) => required.every((key) => histories.get(key).has(date)))
    .sort();
  if (!commonDates.length) throw new Error("네 가지 중국 시세에 공통된 날짜가 없습니다.");
  return commonDates.map((date) => ({
    date,
    ggd9010: histories.get("GGD90").get(date),
    gdd9010: histories.get("GDD90").get(date),
    ggd8020: histories.get("GGD80").get(date),
    gdd8020: histories.get("GDD80").get(date),
  }));
}

async function fetchFx() {
  const payload = JSON.parse(await fetchText(FX_URL));
  const rate = payload?.rates?.USD;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload?.date) || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("환율 응답 형식이 올바르지 않습니다.");
  }
  return { date: payload.date, usdPerCny: Math.round(rate * 100_000) / 100_000 };
}

function mergeChinaRows(existing, fetched) {
  const merged = new Map(existing.map((row) => [row.date, row]));
  for (const row of fetched) merged.set(row.date, row);
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-52);
}

function buildIndex(fragment) {
  const styleEnd = fragment.indexOf("</style>") + "</style>".length;
  if (styleEnd < "</style>".length) throw new Error("down-sise.html에서 </style>을 찾지 못했습니다.");
  const prefix = '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n';
  return `${prefix}${fragment.slice(0, styleEnd)}\n</head>\n<body>\n${fragment.slice(styleEnd)}\n</body>\n</html>\n`;
}

function validate(fragment, index, cnRows, k2Rows) {
  const scriptMatch = fragment.match(/<script>([\s\S]*?)<\/script>\s*$/);
  if (!scriptMatch) throw new Error("페이지 스크립트 블록을 찾지 못했습니다.");
  new vm.Script(scriptMatch[1]);
  if (buildIndex(fragment) !== index) throw new Error("index.html이 down-sise.html과 동기화되지 않았습니다.");
  if (!k2Rows.length || !cnRows.length) throw new Error("가격 데이터가 비어 있습니다.");
  const dates = (rows) => rows.map((row) => row.date);
  for (const [name, rows] of [["K2", k2Rows], ["중국", cnRows]]) {
    const rowDates = dates(rows);
    if (new Set(rowDates).size !== rowDates.length) throw new Error(`${name} 데이터에 중복 날짜가 있습니다.`);
    if (rowDates.join() !== [...rowDates].sort().join()) throw new Error(`${name} 데이터 날짜가 오름차순이 아닙니다.`);
  }
}

async function main() {
  const originalFragment = (await readFile(DOWN_PATH, "utf8")).replace(/\r\n/g, "\n").replace(/\n+$/, "\n");
  const existingK2 = parseJsRows(originalFragment, "K2_SEED");
  const existingCn = parseJsRows(originalFragment, "CN_HISTORY");
  const k2Rows = await readK2Rows(excelPath, existingK2.length);

  let cnRows = existingCn;
  let fxMatch = originalFragment.match(/var FX = \{ date: "([^"]+)", usdPerCny: ([0-9.]+) \}/);
  if (!fxMatch) throw new Error("FX 값을 찾지 못했습니다.");
  let fx = { date: fxMatch[1], usdPerCny: Number(fxMatch[2]) };
  if (!skipNetwork) {
    const [fetchedChina, fetchedFx] = await Promise.all([fetchChinaHistory(), fetchFx()]);
    cnRows = mergeChinaRows(existingCn, fetchedChina);
    fx = fetchedFx;
  }

  let fragment = replaceJsArray(originalFragment, "K2_SEED", k2Rows, ["date", "goose", "duck"]);
  fragment = replaceJsArray(fragment, "CN_HISTORY", cnRows, ["date", "ggd9010", "gdd9010", "ggd8020", "gdd8020"]);
  fragment = fragment.replace(/var FX = \{ date: "[^"]+", usdPerCny: [0-9.]+ \}/, `var FX = { date: "${fx.date}", usdPerCny: ${fx.usdPerCny} }`);
  fragment = fragment.replace(/(\/\/ 실측값 — en\.cfd\.com\.cn, GB\/T 14272-2021\.).*?(\n)/, `$1 ${cnRows.at(-1).date}까지 자동 수집.$2`);
  const index = buildIndex(fragment);
  validate(fragment, index, cnRows, k2Rows);

  const jsonRows = cnRows.map((row) => ({
    date: row.date,
    ggd9010_cny: row.ggd9010,
    gdd9010_cny: row.gdd9010,
    ggd8020_cny: row.ggd8020,
    gdd8020_cny: row.gdd8020,
  }));
  const json = `${JSON.stringify(jsonRows, null, 2)}\n`;
  const changed = fragment !== originalFragment || index !== (await readFile(INDEX_PATH, "utf8")).replace(/\r\n/g, "\n") || json !== (await readFile(CN_JSON_PATH, "utf8")).replace(/\r\n/g, "\n");

  if (!dryRun) {
    await Promise.all([
      writeFile(DOWN_PATH, fragment, "utf8"),
      writeFile(INDEX_PATH, index, "utf8"),
      writeFile(CN_JSON_PATH, json, "utf8"),
    ]);
  }

  console.log(JSON.stringify({
    mode: dryRun ? "dry-run" : "write",
    changed,
    excel: excelPath,
    k2: { rows: k2Rows.length, first: k2Rows[0].date, last: k2Rows.at(-1).date },
    china: { rows: cnRows.length, first: cnRows[0].date, last: cnRows.at(-1).date },
    fx,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[update-site] ${error.stack || error.message}`);
  process.exitCode = 1;
});
