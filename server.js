const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'crypto-dashboard/1.0', ...extraHeaders };
    https
      .get(url, { headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Bad JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

// Pepperstone publishes its order book over WebSocket, and the first frame can
// be partial (it fills in over the next ~second). To avoid under-representing
// depth, we collect frames for a short window after the first one and return
// the fullest single frame (most levels) — a consistent point-in-time book.
const PEPPERSTONE_COLLECT_MS = 1500;

function fetchPepperstoneOrderBook() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://nodes.pepperstonecrypto.com/ws');
    let best = null; // fullest frame seen (by total level count)
    let collectTimer = null;
    const finish = (result, err) => {
      clearTimeout(hardTimeout);
      clearTimeout(collectTimer);
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(result);
    };
    const hardTimeout = setTimeout(() => {
      best ? finish(best) : finish(null, new Error('Pepperstone WS timeout'));
    }, 8000);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({ method: 'subscribe', events: ['OB.BTC_AUD'] })
      );
    });
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (
          msg.method === 'stream' &&
          msg.event === 'OB.BTC_AUD' &&
          msg.data &&
          msg.data.bids?.length &&
          msg.data.asks?.length
        ) {
          const levels = msg.data.bids.length + msg.data.asks.length;
          if (!best || levels > best.bids.length + best.asks.length) {
            best = { bids: msg.data.bids, asks: msg.data.asks };
          }
          // Once the first frame arrives, keep the fullest for a short window.
          if (!collectTimer) {
            collectTimer = setTimeout(() => finish(best), PEPPERSTONE_COLLECT_MS);
          }
        }
      } catch {}
    });
    ws.addEventListener('error', () => {
      finish(null, new Error('Pepperstone WS error'));
    });
  });
}

async function fetchPepperstoneOneShot() {
  const { bids, asks } = await fetchPepperstoneOrderBook();
  const bid = Math.max(...bids.map((b) => +b[0]));
  const ask = Math.min(...asks.map((a) => +a[0]));
  return { bid, ask, last: (bid + ask) / 2 };
}

// Normalize a raw order book into sorted, cleaned [price, volume] ladders:
// bids high→low, asks low→high, capped to the top `cap` levels near the touch.
function normalizeDepth(bids, asks, cap = 200) {
  const clean = (rows) =>
    rows
      .map(([p, v]) => [+p, +v])
      .filter(([p, v]) => p > 0 && v > 0);
  return {
    bids: clean(bids)
      .sort((a, b) => b[0] - a[0])
      .slice(0, cap),
    asks: clean(asks)
      .sort((a, b) => a[0] - b[0])
      .slice(0, cap),
  };
}

// Kraken Pro and Kraken Instant Buy trade on the same XBTAUD book; both rows
// share this top-of-book quote and differ only in the fee applied on top.
async function fetchKrakenTicker() {
  const r = await fetchJSON(
    'https://api.kraken.com/0/public/Ticker?pair=XBTAUD'
  );
  const k = r.result[Object.keys(r.result)[0]];
  return { bid: +k.b[0], ask: +k.a[0], last: +k.c[0] };
}

// ---- USD-routed global venues --------------------------------------------
// You can't buy BTC/AUD directly on these; the modelled journey is
// AUD -> USDC (swap) -> move USDC to the venue -> BTC on its USD/USDC book.
// The AUD-per-USDC rate comes from CoinJar's real USDC/AUD book (cheapest AU
// swap). CONVERSION_SWAP_FEE_BPS is the ALL-IN conversion + routing cost — the
// ~0.10% swap fee PLUS withdrawing/transferring the USDC to the venue —
// modelled conservatively at ~0.5% for the order sizes tested.
const CONVERSION_SWAP_FEE_BPS = 50;

async function fetchAudPerUsdc() {
  const r = await fetchJSON(
    'https://data.exchange.coinjar.com/products/USDCAUD/ticker'
  );
  const ask = +r.ask; // AUD to buy 1 USDC
  return ask * (1 + CONVERSION_SWAP_FEE_BPS / 10_000);
}

// Wrap USD/USDC-quoted fetchers so they return AUD-converted values. rateFn
// supplies AUD-per-USDC (incl. swap fee); defaults to the CoinJar route.
function convertedQuote(usdFetch, rateFn = fetchAudPerUsdc) {
  return async () => {
    const [q, rate] = await Promise.all([usdFetch(), rateFn()]);
    return { bid: q.bid * rate, ask: q.ask * rate, last: q.last * rate };
  };
}
function convertedDepth(usdDepth, rateFn = fetchAudPerUsdc) {
  return async () => {
    const [d, rate] = await Promise.all([usdDepth(), rateFn()]);
    return normalizeDepth(
      d.bids.map(([p, v]) => [+p * rate, +v]),
      d.asks.map(([p, v]) => [+p * rate, +v])
    );
  };
}

// Fees are TAKER fees in basis points (1 bp = 0.01%).
// feeBakedIn = true means the quoted ask already includes the venue's markup,
// so we should NOT add taker fee on top — doing so would double-count.
// Values below reflect public rate cards; update as needed.
const exchanges = {
  coinspot: {
    label: 'CoinSpot Instant Buy',
    note: 'Retail one-click — 1% fee',
    takerFeeBps: 100,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://www.coinspot.com.au/pubapi/v2/latest/btc'
      );
      const p = r.prices;
      return { bid: +p.bid, ask: +p.ask, last: +p.last };
    },
  },
  digitalsurge: {
    label: 'Digital Surge',
    note: 'Retail broker — spread baked into price, + 0.5% trading fee on top (standard tier)',
    takerFeeBps: 50,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://digitalsurge.com.au/api/public/broker/ticker/'
      );
      const btc = r.BTC;
      // buy = what you pay (ask), sell = what you receive (bid); spread is already in these.
      return { bid: +btc.sell, ask: +btc.buy, last: +btc.last };
    },
  },
  independentreserve: {
    label: 'Independent Reserve',
    note: 'Order book top',
    takerFeeBps: 50,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://api.independentreserve.com/Public/GetMarketSummary?primaryCurrencyCode=Xbt&secondaryCurrencyCode=Aud'
      );
      return {
        bid: +r.CurrentHighestBidPrice,
        ask: +r.CurrentLowestOfferPrice,
        last: +r.LastPrice,
      };
    },
    depthFetch: async () => {
      const r = await fetchJSON(
        'https://api.independentreserve.com/Public/GetOrderBook?primaryCurrencyCode=Xbt&secondaryCurrencyCode=Aud'
      );
      return normalizeDepth(
        r.BuyOrders.map((o) => [o.Price, o.Volume]),
        r.SellOrders.map((o) => [o.Price, o.Volume])
      );
    },
  },
  btcmarkets: {
    label: 'BTC Markets',
    note: 'Order book top',
    takerFeeBps: 85,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://api.btcmarkets.net/v3/markets/BTC-AUD/ticker'
      );
      return { bid: +r.bestBid, ask: +r.bestAsk, last: +r.lastPrice };
    },
    depthFetch: async () => {
      const r = await fetchJSON(
        'https://api.btcmarkets.net/v3/markets/BTC-AUD/orderbook?level=2'
      );
      return normalizeDepth(r.bids, r.asks);
    },
  },
  coinjar: {
    label: 'CoinJar Exchange',
    note: 'Order book top — 0.10% taker',
    takerFeeBps: 10,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://data.exchange.coinjar.com/products/BTCAUD/ticker'
      );
      return { bid: +r.bid, ask: +r.ask, last: +r.last };
    },
    depthFetch: async () => {
      const r = await fetchJSON(
        'https://data.exchange.coinjar.com/products/BTCAUD/book?level=2'
      );
      return normalizeDepth(r.bids, r.asks);
    },
  },
  kraken: {
    label: 'Kraken Pro',
    note: 'Order book top — 0.40% base taker',
    takerFeeBps: 40,
    feeBakedIn: false,
    fetch: fetchKrakenTicker,
    depthFetch: async () => {
      const r = await fetchJSON(
        'https://api.kraken.com/0/public/Depth?pair=XBTAUD&count=100'
      );
      const k = r.result[Object.keys(r.result)[0]];
      return normalizeDepth(k.bids, k.asks);
    },
  },
  krakeninstant: {
    label: 'Kraken (Instant Buy)',
    note: 'Retail one-click — 1% fee on top (plus an unshown spread)',
    takerFeeBps: 100,
    feeBakedIn: false,
    // No order book of its own: uses the Pro book price + the Instant Buy fee.
    // Real Instant Buy also bakes in a spread we can't see, so this is a floor.
    fetch: fetchKrakenTicker,
  },
  okx: {
    label: 'OKX',
    note: 'Order book top — 0.70% taker (AU regular tier)',
    takerFeeBps: 70,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://www.okx.com/api/v5/market/ticker?instId=BTC-AUD'
      );
      const d = r.data[0];
      return { bid: +d.bidPx, ask: +d.askPx, last: +d.last };
    },
    depthFetch: async () => {
      const r = await fetchJSON(
        'https://www.okx.com/api/v5/market/books?instId=BTC-AUD&sz=100'
      );
      const d = r.data[0];
      return normalizeDepth(d.bids, d.asks);
    },
  },
  binance: {
    label: 'Binance',
    note: 'Global — BTC-USDC book',
    takerFeeBps: 10,
    feeBakedIn: false,
    conversion: true,
    fetch: convertedQuote(async () => {
      const r = await fetchJSON(
        'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDC'
      );
      const bid = +r.bidPrice,
        ask = +r.askPrice;
      return { bid, ask, last: (bid + ask) / 2 };
    }),
    depthFetch: convertedDepth(async () => {
      const r = await fetchJSON(
        'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDC&limit=100'
      );
      return { bids: r.bids, asks: r.asks };
    }),
  },
  kucoin: {
    label: 'KuCoin',
    note: 'Global — BTC-USDC book',
    takerFeeBps: 10,
    feeBakedIn: false,
    conversion: true,
    fetch: convertedQuote(async () => {
      const r = await fetchJSON(
        'https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BTC-USDC'
      );
      const d = r.data;
      return { bid: +d.bestBid, ask: +d.bestAsk, last: +d.price };
    }),
    depthFetch: convertedDepth(async () => {
      const r = await fetchJSON(
        'https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=BTC-USDC'
      );
      return { bids: r.data.bids, asks: r.data.asks };
    }),
  },
  cryptocom: {
    label: 'Crypto.com',
    note: 'Global — BTC-USD book',
    takerFeeBps: 50,
    feeBakedIn: false,
    conversion: true,
    fetch: convertedQuote(async () => {
      const r = await fetchJSON(
        'https://api.crypto.com/exchange/v1/public/get-book?instrument_name=BTC_USD&depth=10'
      );
      const d = r.result.data[0];
      const bid = +d.bids[0][0],
        ask = +d.asks[0][0];
      return { bid, ask, last: (bid + ask) / 2 };
    }),
    depthFetch: convertedDepth(async () => {
      const r = await fetchJSON(
        'https://api.crypto.com/exchange/v1/public/get-book?instrument_name=BTC_USD&depth=50'
      );
      const d = r.result.data[0];
      return { bids: d.bids, asks: d.asks };
    }),
  },
  coinbase: {
    label: 'Coinbase',
    note: 'Global — BTC-USD book',
    takerFeeBps: 60,
    feeBakedIn: false,
    conversion: true,
    fetch: convertedQuote(async () => {
      const r = await fetchJSON(
        'https://api.exchange.coinbase.com/products/BTC-USD/ticker'
      );
      return { bid: +r.bid, ask: +r.ask, last: +r.price };
    }),
    depthFetch: convertedDepth(async () => {
      const r = await fetchJSON(
        'https://api.exchange.coinbase.com/products/BTC-USD/book?level=2'
      );
      return { bids: r.bids, asks: r.asks };
    }),
  },
  pepperstone: {
    label: 'Pepperstone Crypto',
    note: 'Order book top (WebSocket)',
    takerFeeBps: 10,
    feeBakedIn: false,
    // Launch promo: 0% trading fee through end of July 2026 (AEST), then the
    // standard 0.10% taker resumes automatically.
    promo: {
      label: 'Special offer',
      note: '0% trading fee until 31 Jul 2026',
      feeBps: 0,
      untilIso: '2026-07-31T23:59:59+10:00',
    },
    fetch: fetchPepperstoneOneShot,
    depthFetch: async () => {
      const { bids, asks } = await fetchPepperstoneOrderBook();
      return normalizeDepth(bids, asks);
    },
  },
  swyftx: {
    label: 'Swyftx (Standard)',
    note: 'Retail broker — spread in quote, + 0.6% trading fee on top (standard tier)',
    takerFeeBps: 60,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://api.swyftx.com.au/markets/info/basic/BTC/'
      );
      const btc = Array.isArray(r) ? r[0] : r;
      return {
        bid: +btc.sell,
        ask: +btc.buy,
        last: (+btc.sell + +btc.buy) / 2,
      };
    },
  },
};

// Returns the exchange's promo if one is defined and still within its window.
function activePromo(ex) {
  if (!ex.promo) return null;
  return Date.now() <= Date.parse(ex.promo.untilIso) ? ex.promo : null;
}

// The fee actually charged right now — the promo rate while live, else standard.
function currentFeeBps(ex) {
  const p = activePromo(ex);
  return p ? p.feeBps : ex.takerFeeBps;
}

function effectivePrice(ex, ask) {
  return ex.feeBakedIn ? ask : ask * (1 + currentFeeBps(ex) / 10_000);
}

async function runSample(id) {
  const ex = exchanges[id];
  if (!ex) throw new Error(`unknown exchange: ${id}`);
  const data = await ex.fetch();
  if (!Number.isFinite(data.bid) || !Number.isFinite(data.ask)) {
    throw new Error('no valid price (venue API may be geo-restricted or down)');
  }
  return {
    ...data,
    takerFeeBps: currentFeeBps(ex),
    feeBakedIn: ex.feeBakedIn,
    effectiveAsk: effectivePrice(ex, data.ask),
  };
}

// Volume-weighted average ask price to fill `sizeAud` of AUD by walking the
// ask ladder; null if the provided levels can't fill it. Mirrors the frontend.
function walkBookAvg(asks, sizeAud) {
  let spent = 0,
    btc = 0;
  for (const [p, v] of asks) {
    const cost = p * v;
    if (spent + cost >= sizeAud) {
      btc += (sizeAud - spent) / p;
      spent = sizeAud;
      break;
    }
    spent += cost;
    btc += v;
  }
  return spent >= sizeAud - 0.5 ? sizeAud / btc : null;
}

// Effective (fee-inclusive) price to buy `sizeAud` worth: walk the book when
// depth is available, otherwise fall back to the top-of-book effective price.
function effectiveForSize(ex, quote, depthAsks, sizeAud) {
  if (ex.feeBakedIn) return quote.effectiveAsk; // spread-inclusive; size-agnostic
  if (depthAsks && depthAsks.length) {
    const avg = walkBookAvg(depthAsks, sizeAud);
    if (avg) return avg * (1 + currentFeeBps(ex) / 10_000);
  }
  return quote.effectiveAsk;
}

// Exchange logo filenames, served from the /logos directory.
const LOGOS = {
  coinspot: 'coinspot.png',
  digitalsurge: 'digital surge.png',
  independentreserve: 'independent reserve.svg',
  btcmarkets: 'btc markets.png',
  coinjar: 'coinjar.png',
  kraken: 'kraken pro.png',
  krakeninstant: 'kraken.png',
  okx: 'okx.png',
  pepperstone: 'pepperstone.png',
  swyftx: 'swyftx.png',
  binance: 'binance.png',
  kucoin: 'kucoin.webp',
  cryptocom: 'crypto.com.png',
  coinbase: 'coinbase.png',
};

const LOGO_TYPES = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }

  if (req.url === '/api/exchanges') {
    const list = Object.entries(exchanges).map(([id, v]) => {
      // Expose the promo whenever one is DEFINED (not only while live), plus
      // whether it is currently active, so the UI can toggle it either way.
      const p = v.promo;
      return {
        id,
        label: v.label,
        note: v.note,
        takerFeeBps: currentFeeBps(v),
        standardFeeBps: v.takerFeeBps,
        feeBakedIn: v.feeBakedIn,
        orderBook: !!v.depthFetch,
        conversion: !!v.conversion,
        conversionNote: v.conversionNote || null,
        logo: LOGOS[id] || null,
        promo: p
          ? {
              label: p.label,
              note: p.note,
              untilIso: p.untilIso,
              feeBps: p.feeBps,
            }
          : null,
        promoActive: !!activePromo(v),
      };
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(list));
    return;
  }

  if (req.url === '/api/history') {
    const csvPath = path.join(__dirname, 'data', 'samples.csv');
    res.setHeader('Content-Type', 'application/json');
    if (!fs.existsSync(csvPath)) {
      res.end(JSON.stringify({ samples: [] }));
      return;
    }
    const rows = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
    const header = rows.shift().split(',');
    const samples = rows.map((line) => {
      const cols = line.split(',');
      const obj = {};
      header.forEach((h, i) => (obj[h] = cols[i]));
      return obj;
    });
    res.end(JSON.stringify({ samples }));
    return;
  }

  const dm = req.url.match(/^\/api\/depth\/([\w-]+)$/);
  if (dm) {
    const id = dm[1];
    const ex = exchanges[id];
    res.setHeader('Content-Type', 'application/json');
    if (!ex) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `unknown exchange: ${id}` }));
      return;
    }
    if (!ex.depthFetch) {
      res.end(JSON.stringify({ orderBook: false }));
      return;
    }
    try {
      const d = await ex.depthFetch();
      res.end(JSON.stringify({ orderBook: true, ...d, ts: Date.now() }));
    } catch (e) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const m = req.url.match(/^\/api\/spread\/([\w-]+)$/);
  if (m) {
    res.setHeader('Content-Type', 'application/json');
    try {
      const data = await runSample(m[1]);
      res.end(JSON.stringify({ ...data, ts: Date.now() }));
    } catch (e) {
      res.statusCode = m[1] in exchanges ? 502 : 404;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const lm = req.url.match(/^\/logos\/(.+)$/);
  if (lm) {
    const file = decodeURIComponent(lm[1].split('?')[0]);
    if (file.includes('..') || file.includes('/')) {
      res.statusCode = 400;
      res.end();
      return;
    }
    try {
      const data = fs.readFileSync(path.join(__dirname, 'logos', file));
      const ext = path.extname(file).toLowerCase();
      res.setHeader('Content-Type', LOGO_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end();
    }
    return;
  }

  res.statusCode = 404;
  res.end();
});

module.exports = {
  exchanges,
  runSample,
  effectivePrice,
  walkBookAvg,
  effectiveForSize,
};

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Crypto dashboard running: http://localhost:${PORT}`);
  });
}
