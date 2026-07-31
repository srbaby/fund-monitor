export const CORE_INDEX_DEFINITIONS = [
  { code: "000300", secid: "1.000300", qq: "sh000300", label: "沪深300" },
  { code: "000510", secid: "1.000510", qq: "sh000510", label: "中证A500" },
  { code: "000905", secid: "1.000905", qq: "sh000905", label: "中证500" },
  { code: "000832", secid: "1.000832", qq: "sh000832", label: "中证转债" },
  { code: "000012", secid: "1.000012", qq: "sh000012", label: "国债指数" },
  { code: "HSI", secid: "116.HSI", qq: "hkHSI", label: "恒生指数" },
];

export const HIDDEN_INDEX_DEFINITIONS = [
  { code: "159352", secid: "0.159352", qq: "sz159352", label: "南方A500ETF" },
  { code: "000013", secid: "1.000013", qq: "sh000013", label: "企债指数" },
  { code: "000688", secid: "1.000688", qq: "sh000688", label: "科创50" },
  { code: "399006", secid: "0.399006", qq: "sz399006", label: "创业板指" },
];

export const INDEX_DEFINITIONS = [
  ...CORE_INDEX_DEFINITIONS,
  ...HIDDEN_INDEX_DEFINITIONS,
];

const INDEX_CODES = new Set(INDEX_DEFINITIONS.map((item) => item.code));

// Mirrors SYS_CONFIG.IDX_PE: the index whose realtime PE anchors the board.
export const ANCHOR_INDEX = "000300";

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCode(value) {
  const code = String(value ?? "").trim();
  return /^\d{1,6}$/.test(code) ? code.padStart(6, "0") : null;
}

export function formatQuoteAt(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`;
  }
  if (/^\d{10,13}$/.test(text)) {
    const epoch = Number(text.length === 10 ? text + "000" : text);
    if (Number.isFinite(epoch)) {
      return new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
        .format(new Date(epoch))
        .replace(",", "");
    }
  }
  return /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(text)
    ? text
    : null;
}

function normalizeIndex(raw, expectedCode) {
  const code = raw?.f12 === "HSI" ? "HSI" : String(raw?.f12 ?? "");
  const price = finiteNumber(raw?.f2);
  const changePct = finiteNumber(raw?.f3);
  if (code !== expectedCode || price == null || price <= 0 || changePct == null) return null;
  return {
    code,
    name: raw?.f14 || INDEX_DEFINITIONS.find((item) => item.code === code)?.label || code,
    price,
    changePct,
    quoteAt: formatQuoteAt(raw?.f124),
    pe: finiteNumber(raw?.f115),
    marketCap: finiteNumber(raw?.f116),
  };
}

export function parseEastmoneyIndices(payload) {
  if (!Array.isArray(payload?.data?.diff)) return null;
  // Several HSI secids are queried for resilience. Keying by canonical code
  // deliberately collapses any multiple valid HSI responses to one record.
  const byCode = new Map(
    payload.data.diff
      .map((item) => [item?.f12 === "HSI" ? "HSI" : String(item?.f12 ?? ""), item])
      .filter(([code]) => INDEX_CODES.has(code)),
  );
  const coreData = CORE_INDEX_DEFINITIONS.map((definition) =>
    normalizeIndex(byCode.get(definition.code), definition.code),
  );
  if (!coreData.every(Boolean)) return null;
  const hiddenData = HIDDEN_INDEX_DEFINITIONS.map((definition) =>
    normalizeIndex(byCode.get(definition.code), definition.code),
  ).filter(Boolean);
  return [...coreData, ...hiddenData];
}

export function parseTencentAssignments(text) {
  const quotes = new Map();
  const pattern = /v_([^=\s]+)="([\s\S]*?)"\s*;/g;
  for (const match of text.matchAll(pattern)) quotes.set(match[1], match[2].split("~"));
  return quotes;
}

export function parseTencentIndices(text) {
  const quotes = parseTencentAssignments(text);
  const parseDefinition = (definition) => {
    const fields = quotes.get(definition.qq);
    if (!fields) return null;
    const price = finiteNumber(fields[3]);
    const changePct = finiteNumber(fields[32]);
    if (price == null || price <= 0 || changePct == null) return null;
    return {
      code: definition.code,
      name: fields[1] || definition.label,
      price,
      changePct,
      quoteAt: formatQuoteAt(fields[30]),
      pe: finiteNumber(fields[39]),
      marketCap: finiteNumber(fields[45]),
    };
  };
  const coreData = CORE_INDEX_DEFINITIONS.map(parseDefinition);
  if (!coreData.every(Boolean)) return null;
  const hiddenData = HIDDEN_INDEX_DEFINITIONS.map(parseDefinition).filter(Boolean);
  return [...coreData, ...hiddenData];
}

function normalizeOfficial(raw, code) {
  const officialNav = finiteNumber(raw?.NAV ?? raw?.DWJZ);
  const officialPct = finiteNumber(raw?.NAVCHGRT ?? raw?.JZZZL);
  const officialAt = formatQuoteAt(raw?.PDATE ?? raw?.FSRQ);
  if (officialNav == null || officialNav <= 0 || officialPct == null || !officialAt) return null;
  return { code, name: raw?.SHORTNAME || raw?.FCODE || null, officialNav, officialPct, officialAt };
}

export function parseOfficialPrimary(payload, codes) {
  if (!payload?.Success || !Array.isArray(payload?.Datas)) return null;
  const records = new Map();
  for (const raw of payload.Datas) {
    const code = normalizeCode(raw?.FCODE);
    if (code && codes.includes(code)) records.set(code, normalizeOfficial(raw, code));
  }
  const data = codes.map((code) => records.get(code));
  return data.every(Boolean) ? data : null;
}

export function parseOfficialSecondary(payload, code) {
  const raw = Array.isArray(payload?.Datas) ? payload.Datas[0] : null;
  return raw ? normalizeOfficial(raw, code) : null;
}

export function latestQuoteAt(data) {
  return data.map((item) => item.quoteAt).filter(Boolean).sort().at(-1) || null;
}
