// play.js — seat helpers and LIN deal/auction parsing for the problems viewer
// (globalThis.bpPlay). Card play itself lives in bsd-app's /bridge-lib
// BridgePlayer. lin.js must load first (globalThis.bpLin).

const L = globalThis.bpLin;

const SEATS = ['N', 'E', 'S', 'W'];       // clockwise

function partner(seat) { return SEATS[(SEATS.indexOf(seat) + 2) % 4]; }
function sideOf(seat) { return (seat === 'N' || seat === 'S') ? 'NS' : 'EW'; }

// Parse the hands / dealer / auction out of a canonical LIN.
// md| format from problemToLin: `<dealerDigit><S>,<W>,<N>,<E>` with each hand
// `S..H..D..C..` and ten as 'T'. Returns { hands, dealer, calls, declarer,
// trump } or null.
function parseLin(lin) {
  if (!lin) return null;
  const m = lin.match(/(^|\|)md\|(\d)([^|]*)/);
  if (!m) return null;
  const dealer = { '1': 'S', '2': 'W', '3': 'N', '4': 'E' }[m[2]];
  const order = ['S', 'W', 'N', 'E'];
  const parts = m[3].split(',');
  if (parts.length < 4) return null;
  const hands = {};
  order.forEach((seat, i) => {
    const h = { S: '', H: '', D: '', C: '' };
    let su = null;
    for (const ch of parts[i]) {
      if ('SHDC'.includes(ch)) { su = ch; continue; }
      if (!su) return;
      h[su] += (ch === 'T' ? '10' : ch);
    }
    hands[seat] = h;
  });
  const calls = [...lin.matchAll(/mb\|([^|]+)\|/g)].map(x => x[1]);
  const declarer = L.declarerFromCalls(calls, dealer);
  const finalBid = [...calls].reverse().find(c => /^[1-7]/.test(c));
  const denom = finalBid ? finalBid.slice(1) : null;
  const trump = (!denom || denom === 'N') ? null : denom;
  return { hands, dealer, calls, declarer, trump };
}

const bpPlay = { SEATS, partner, sideOf, parseLin };
globalThis.bpPlay = bpPlay;
if (typeof module !== 'undefined' && module.exports) module.exports = bpPlay;
