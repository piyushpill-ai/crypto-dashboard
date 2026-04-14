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

function fetchPepperstoneOneShot() {
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
          const bid = Math.max(...msg.data.bids.map((b) => b[0]));
          const ask = Math.min(...msg.data.asks.map((a) => a[0]));
          clearTimeout(to);
          try {
            ws.close();
          } catch {}
          resolve({ bid, ask, last: (bid + ask) / 2 });
        }
      } catch {}
    });
    ws.addEventListener('error', () => {
      clearTimeout(to);
      reject(new Error('Pepperstone WS error'));
    });
  });
}

// Fees are TAKER fees in basis points (1 bp = 0.01%).
// feeBakedIn = true means the quoted ask already includes the venue's markup,
// so we should NOT add taker fee on top — doing so would double-count.
// Values below reflect public rate cards; update as needed.
const exchanges = {
  coinspot: {
    label: 'CoinSpot Markets',
    note: 'Order book top (Markets product, not Instant Buy)',
    takerFeeBps: 10,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://www.coinspot.com.au/pubapi/v2/latest/btc'
      );
      const p = r.prices;
      return { bid: +p.bid, ask: +p.ask, last: +p.last };
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
  },
  kraken: {
    label: 'Kraken',
    note: 'Order book top',
    takerFeeBps: 26,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://api.kraken.com/0/public/Ticker?pair=XBTAUD'
      );
      const k = r.result[Object.keys(r.result)[0]];
      return { bid: +k.b[0], ask: +k.a[0], last: +k.c[0] };
    },
  },
  okx: {
    label: 'OKX',
    note: 'Order book top',
    takerFeeBps: 10,
    feeBakedIn: false,
    fetch: async () => {
      const r = await fetchJSON(
        'https://www.okx.com/api/v5/market/ticker?instId=BTC-AUD'
      );
      const d = r.data[0];
      return { bid: +d.bidPx, ask: +d.askPx, last: +d.last };
    },
  },
  pepperstone: {
    label: 'Pepperstone Crypto',
    note: 'Order book top (WebSocket)',
    takerFeeBps: 10,
    feeBakedIn: false,
    fetch: fetchPepperstoneOneShot,
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
