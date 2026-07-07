const fs = require('fs');
const path = require('path');
const { exchanges, runSample, effectiveForSize } = require('./server');

const CSV_PATH = path.join(__dirname, 'data', 'samples.csv');
// Order sizes (AUD) for the walk-the-book effective price, matching the
// dashboard's slippage tiles. effective_ask stays as the top-of-book value.
const SIZES = [1000, 10000, 100000];
const HEADER =
  'timestamp,exchange,bid,ask,last,taker_fee_bps,fee_baked_in,effective_ask,eff_1k,eff_10k,eff_100k';

// One sample: top-of-book quote + (for order-book venues) the ask ladder.
async function sampleOne(id) {
  const ex = exchanges[id];
  const quote = await runSample(id);
  let depthAsks = null;
  if (ex.depthFetch) {
    try {
      depthAsks = (await ex.depthFetch()).asks;
    } catch {
      /* keep depthAsks null → size columns fall back to top-of-book */
    }
  }
  return { quote, depthAsks };
}

// Rewrite only the header line if the schema changed, preserving all data rows
// (older rows simply lack the trailing size columns).
function ensureHeader() {
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, HEADER + '\n');
    return;
  }
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const nl = content.indexOf('\n');
  if (content.slice(0, nl) !== HEADER) {
    fs.writeFileSync(CSV_PATH, HEADER + content.slice(nl));
  }
}

async function main() {
  ensureHeader();

  const ts = new Date().toISOString();
  const ids = Object.keys(exchanges);
  const results = await Promise.allSettled(ids.map(sampleOne));

  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      const { quote, depthAsks } = r.value;
      const ex = exchanges[id];
      const effs = SIZES.map((s) =>
        effectiveForSize(ex, quote, depthAsks, s).toFixed(4)
      );
      rows.push(
        [
          ts,
          id,
          quote.bid,
          quote.ask,
          quote.last,
          quote.takerFeeBps,
          quote.feeBakedIn,
          quote.effectiveAsk.toFixed(4),
          ...effs,
        ].join(',')
      );
      console.log(
        `${id.padEnd(20)} ask=${quote.ask.toFixed(2).padStart(10)}  fee=${quote.takerFeeBps}bps  eff@1k=${effs[0]}  eff@100k=${effs[2]}`
      );
    } else {
      console.error(`${id}: FAILED — ${r.reason.message}`);
    }
  }

  if (rows.length) fs.appendFileSync(CSV_PATH, rows.join('\n') + '\n');
  console.log(`\nWrote ${rows.length}/${ids.length} rows to ${CSV_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
