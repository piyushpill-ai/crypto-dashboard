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

// One-shot Pepperstone order-book snapshot over WebSocket. Resolves with the
// full { bids, asks } arrays (each entry [price, size]); callers derive either
// the top-of-book quote or the whole depth ladder from it.
function fetchPepperstoneOrderBook() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://nodes.pepperstonecrypto.com/ws');
    const to = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('Pepperstone WS timeout'));
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
          clearTimeout(to);
          try {
            ws.close();
          } catch {}
          resolve({ bids: msg.data.bids, asks: msg.data.asks });
        }
      } catch {}
    });
    ws.addEventListener('error', () => {
      clearTimeout(to);
      reject(new Error('Pepperstone WS error'));
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
    note: 'Order book top',
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
  pepperstone: {
    label: 'Pepperstone Crypto',
    note: 'Order book top (WebSocket)',
    takerFeeBps: 10,
    feeBakedIn: false,
    fetch: fetchPepperstoneOneShot,
    depthFetch: async () => {
      const { bids, asks } = await fetchPepperstoneOrderBook();
      return normalizeDepth(bids, asks);
    },
  },
  swyftx: {
    label: 'Swyftx (Standard)',
    note: 'Retail price — ~1% spread baked in. Pro tier needs auth.',
    takerFeeBps: 0,
    feeBakedIn: true,
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

function effectivePrice(ex, ask) {
  return ex.feeBakedIn ? ask : ask * (1 + ex.takerFeeBps / 10_000);
}

async function runSample(id) {
  const ex = exchanges[id];
  if (!ex) throw new Error(`unknown exchange: ${id}`);
  const data = await ex.fetch();
  return {
    ...data,
    takerFeeBps: ex.takerFeeBps,
    feeBakedIn: ex.feeBakedIn,
    effectiveAsk: effectivePrice(ex, data.ask),
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }

  if (req.url === '/api/exchanges') {
    const list = Object.entries(exchanges).map(([id, v]) => ({
      id,
      label: v.label,
      note: v.note,
      takerFeeBps: v.takerFeeBps,
      feeBakedIn: v.feeBakedIn,
      orderBook: !!v.depthFetch,
    }));
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

  res.statusCode = 404;
  res.end();
});

module.exports = { exchanges, runSample, effectivePrice };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Crypto dashboard running: http://localhost:${PORT}`);
  });
}
