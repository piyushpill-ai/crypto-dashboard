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

const exchanges = {
  coinspot: {
    label: 'CoinSpot',
    note: 'Retail price (spread baked in)',
    fetch: async () => {
      const r = await fetchJSON('https://www.coinspot.com.au/pubapi/v2/latest/btc');
      const p = r.prices;
      return { bid: +p.bid, ask: +p.ask, last: +p.last };
    },
  },
  independentreserve: {
    label: 'Independent Reserve',
    note: 'Order book top',
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
    fetch: async () => {
      const r = await fetchJSON('https://api.kraken.com/0/public/Ticker?pair=XBTAUD');
      const k = r.result[Object.keys(r.result)[0]];
      return { bid: +k.b[0], ask: +k.a[0], last: +k.c[0] };
    },
  },
  okx: {
    label: 'OKX',
    note: 'Order book top',
    fetch: async () => {
      const r = await fetchJSON('https://www.okx.com/api/v5/market/ticker?instId=BTC-AUD');
      const d = r.data[0];
      return { bid: +d.bidPx, ask: +d.askPx, last: +d.last };
    },
  },
  pepperstone: {
    label: 'Pepperstone Crypto',
    note: 'Order book top (WebSocket)',
    fetch: async () => {
      const book = await getPepperstoneBook();
      const bid = Math.max(...book.bids.map((b) => b[0]));
      const ask = Math.min(...book.asks.map((a) => a[0]));
      return { bid, ask, last: (bid + ask) / 2 };
    },
  },
  swyftx: {
    label: 'Swyftx',
    note: 'Retail price (spread baked in)',
    fetch: async () => {
      const r = await fetchJSON('https://api.swyftx.com.au/markets/info/basic/BTC/');
      const btc = Array.isArray(r) ? r[0] : r;
      return {
        bid: +btc.sell,
        ask: +btc.buy,
        last: (+btc.sell + +btc.buy) / 2,
      };
    },
  },
};

let pepperstoneBook = null;
let pepperstoneWs = null;

function connectPepperstoneWs() {
  const ws = new WebSocket('wss://nodes.pepperstonecrypto.com/ws');
  pepperstoneWs = ws;
  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        method: 'subscribe',
        events: ['OB.BTC_AUD'],
      })
    );
  });
  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (
        msg.method === 'stream' &&
        msg.event === 'OB.BTC_AUD' &&
        msg.data &&
        Array.isArray(msg.data.bids) &&
        Array.isArray(msg.data.asks)
      ) {
        pepperstoneBook = {
          bids: msg.data.bids,
          asks: msg.data.asks,
          ts: Date.now(),
        };
      }
    } catch {}
  });
  ws.addEventListener('close', () => {
    pepperstoneWs = null;
    setTimeout(connectPepperstoneWs, 2000);
  });
  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {}
  });
}

function getPepperstoneBook() {
  if (pepperstoneBook && Date.now() - pepperstoneBook.ts < 10_000) {
    return Promise.resolve(pepperstoneBook);
  }
  if (!pepperstoneWs || pepperstoneWs.readyState > 1) connectPepperstoneWs();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pepperstoneBook && pepperstoneBook.ts >= start) {
        clearInterval(iv);
        resolve(pepperstoneBook);
      } else if (Date.now() - start > 5000) {
        clearInterval(iv);
        reject(new Error('Pepperstone WS timeout'));
      }
    }, 100);
  });
}

connectPepperstoneWs();

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
    }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(list));
    return;
  }

  const m = req.url.match(/^\/api\/spread\/([\w-]+)$/);
  if (m) {
    const ex = exchanges[m[1]];
    res.setHeader('Content-Type', 'application/json');
    if (!ex) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unknown exchange' }));
      return;
    }
    try {
      const data = await ex.fetch();
      res.end(JSON.stringify({ ...data, ts: Date.now() }));
    } catch (e) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.statusCode = 404;
  res.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Crypto dashboard running: http://localhost:${PORT}`);
});
