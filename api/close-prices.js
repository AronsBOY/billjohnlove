const MAX_REQUESTS = 120;
const CONCURRENCY = 6;

function taipeiDate(epochSeconds) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1000));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return map.year + "-" + map.month + "-" + map.day;
}

function epoch(date, extraDays) {
  const d = new Date(date + "T00:00:00+08:00");
  d.setUTCDate(d.getUTCDate() + extraDays);
  return Math.floor(d.getTime() / 1000);
}

async function fetchYahoo(symbol, startDate, endDate) {
  const period1 = epoch(startDate, -3);
  const period2 = epoch(endDate, 4);
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    "?period1=" + period1 +
    "&period2=" + period2 +
    "&interval=1d&events=history&includeAdjustedClose=false";

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*",
    },
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) return null;
  const closes = result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0] &&
    result.indicators.quote[0].close;
  if (!Array.isArray(closes)) return null;

  const byDate = {};
  result.timestamp.forEach(function (ts, i) {
    const close = Number(closes[i]);
    if (Number.isFinite(close)) byDate[taipeiDate(ts)] = close;
  });
  return byDate;
}

async function resolveCode(code, dates) {
  const sorted = dates.slice().sort();
  const startDate = sorted[0];
  const endDate = sorted[sorted.length - 1];
  const candidates = [code + ".TW", code + ".TWO"];
  let best = null;

  for (const symbol of candidates) {
    try {
      const byDate = await fetchYahoo(symbol, startDate, endDate);
      if (!byDate) continue;
      const hitCount = dates.filter(function (d) {
        return Number.isFinite(Number(byDate[d]));
      }).length;
      if (!best || hitCount > best.hitCount) best = { symbol, byDate, hitCount };
      if (hitCount === dates.length) break;
    } catch (err) {}
  }
  return best || { symbol: null, byDate: {}, hitCount: 0 };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const requests = Array.isArray(body.requests) ? body.requests : [];
    if (!requests.length) return res.status(400).json({ error: "requests_required" });
    if (requests.length > MAX_REQUESTS) return res.status(400).json({ error: "too_many_requests" });

    const clean = requests
      .map(function (r) {
        return {
          code: String(r.code || "").trim(),
          date: String(r.date || "").trim().slice(0, 10),
        };
      })
      .filter(function (r) {
        return /^\d{4}$/.test(r.code) && /^\d{4}-\d{2}-\d{2}$/.test(r.date);
      });

    const grouped = {};
    for (const r of clean) {
      if (!grouped[r.code]) grouped[r.code] = new Set();
      grouped[r.code].add(r.date);
    }

    const codes = Object.keys(grouped);
    const resolved = await mapLimit(codes, CONCURRENCY, async function (code) {
      const dates = Array.from(grouped[code]);
      const hit = await resolveCode(code, dates);
      return { code, symbol: hit.symbol, byDate: hit.byDate };
    });

    const codeMap = {};
    resolved.forEach(function (x) { codeMap[x.code] = x; });

    const prices = clean.map(function (r) {
      const found = codeMap[r.code];
      const close = found && found.byDate ? Number(found.byDate[r.date]) : NaN;
      return {
        code: r.code,
        date: r.date,
        close: Number.isFinite(close) ? close : null,
        status: Number.isFinite(close) ? "OK" : "MISSING",
        source: Number.isFinite(close) ? "Yahoo Finance" : null,
        symbol: found ? found.symbol : null,
      };
    });

    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({
      prices,
      ok: prices.filter(function (x) { return x.status === "OK"; }).length,
      missing: prices.filter(function (x) { return x.status !== "OK"; }).length,
    });
  } catch (err) {
    return res.status(500).json({ error: "price_fetch_failed", message: err.message });
  }
};
