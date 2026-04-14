const fs = require('fs');
const path = require('path');
const { exchanges, runSample } = require('./server');

const CSV_PATH = path.join(__dirname, 'data', 'samples.csv');
const HEADER =
  'timestamp,exchange,bid,ask,last,taker_fee_bps,fee_baked_in,effective_ask';

async function main() {
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, HEADER + '\n');

  const ts = new Date().toISOString();
  const ids = Object.keys(exchanges);
  const results = await Promise.allSettled(ids.map(runSample));

  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      const d = r.value;
      rows.push(
        [
          ts,
          id,
          d.bid,
          d.ask,
          d.last,
          d.takerFeeBps,
          d.feeBakedIn,
          d.effectiveAsk.toFixed(4),
        ].join(',')
      );
      console.log(
        `${id.padEnd(20)} ask=${d.ask.toFixed(2).padStart(10)}  fee=${d.takerFeeBps}bps  eff=${d.effectiveAsk.toFixed(2)}`
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
