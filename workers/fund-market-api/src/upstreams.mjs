import {
  ANCHOR_INDEX,
  INDEX_DEFINITIONS,
  parseEastmoneyIndices,
  parseFundGz,
  parseOfficialPrimary,
  parseOfficialSecondary,
  parseTencentEstimates,
  parseTencentIndices,
} from "./parsers.mjs";

const TIMEOUT_MS = 5_000;

async function fetchWithTimeout(fetcher, url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://quote.eastmoney.com/",
        "User-Agent": "Mozilla/5.0 (compatible; fund-market-api/1.0)",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTencentText(fetcher, query) {
  const response = await fetchWithTimeout(fetcher, `https://qt.gtimg.cn/q=${query}`);
  const buffer = await response.arrayBuffer();
  return new TextDecoder("gbk").decode(buffer);
}

// The HS300 bypass PE engine anchors on realtime market cap, so an index group
// without it would silently freeze the PE bar at yesterday's close. Only
// Tencent serves pe/marketCap; the Eastmoney mirrors return points only.
export async function fetchPrimaryIndices(fetcher) {
  const data = parseTencentIndices(
    await fetchTencentText(fetcher, INDEX_DEFINITIONS.map((item) => item.qq).join(",")),
  );
  const anchor = data?.find((item) => item.code === ANCHOR_INDEX);
  return anchor?.pe > 0 && anchor?.marketCap > 0 ? data : null;
}

export async function fetchBackupIndices(fetcher) {
  const secids = [
    ...INDEX_DEFINITIONS.filter((item) => item.code !== "HSI").map((item) => item.secid),
    // Eastmoney's HSI market identifier varies by route; accept whichever
    // response resolves to f12 === "HSI", while still requiring all six indices.
    "116.HSI",
    "124.HSI",
    "100.HSI",
  ];
  const params = new URLSearchParams({
    fltt: "2",
    fields: "f2,f3,f12,f14,f124,f115,f116",
    secids: secids.join(","),
  });
  for (const host of [
    "push2delay.eastmoney.com",
    "push2his.eastmoney.com",
    "push2.eastmoney.com",
  ]) {
    try {
      const response = await fetchWithTimeout(fetcher, `https://${host}/api/qt/ulist.np/get?${params}`);
      const data = parseEastmoneyIndices(await response.json());
      if (data) return data;
    } catch {
      // Keep the complete Eastmoney backup group intact by trying its mirrors
      // before the router reports the whole index group as unavailable.
    }
  }
  return null;
}

export async function fetchPrimaryEstimates(fetcher, codes) {
  const records = await Promise.all(
    codes.map(async (code) => {
      const response = await fetchWithTimeout(fetcher, `https://fundgz.1234567.com.cn/js/${code}.js`, 5_000);
      return parseFundGz(await response.text(), code);
    }),
  );
  return records.every(Boolean) ? records : null;
}

export async function fetchBackupEstimates(fetcher, codes) {
  return parseTencentEstimates(await fetchTencentText(fetcher, codes.map((code) => `jj${code}`).join(",")), codes);
}

export async function fetchPrimaryOfficial(fetcher, codes) {
  const params = new URLSearchParams({
    pageIndex: "1",
    pageSize: "200",
    plat: "Android",
    appType: "ttjj",
    product: "EFund",
    Version: "1",
    deviceid: "fund-market-api",
    Fcodes: codes.join(","),
  });
  const response = await fetchWithTimeout(
    fetcher,
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?${params}`,
    2_000,
  );
  return parseOfficialPrimary(await response.json(), codes);
}

export async function fetchBackupOfficial(fetcher, codes) {
  const records = await Promise.all(
    codes.map(async (code) => {
      const params = new URLSearchParams({
        FCODE: code,
        IsShareNet: "true",
        MobileKey: "1",
        appType: "ttjj",
        appVersion: "6.2.8",
        cToken: "1",
        deviceid: "1",
        pageIndex: "1",
        pageSize: "1",
        plat: "Iphone",
        product: "EFund",
        serverVersion: "6.2.8",
        uToken: "1",
        version: "6.2.8",
      });
      const response = await fetchWithTimeout(fetcher, `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?${params}`);
      return parseOfficialSecondary(await response.json(), code);
    }),
  );
  return records.every(Boolean) ? records : null;
}
