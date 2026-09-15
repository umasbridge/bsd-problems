// play.js — interactive play engine for the bridge-problems "Play it out"
// table. Pure game logic plus DDS (double-dummy solver) encoding, shared by
// the viewer modal (classic <script src>, reads globalThis.bpPlay) and the
// headless acceptance test (Node ESM `import` runs the side effects).
//
// The trick engine mirrors bpLin.simulatePlay exactly — follow suit; the
// trick winner is the highest trump, else the highest card of the led suit —
// so user clicks and program plays obey one rule set. Program (hidden-seat)
// choices come from bridge-dds SolveBoardPBN on the CURRENT position
// (mid-trick included): the card maximising tricks for the SIDE TO MOVE,
// which is automatically correct whichever hidden seat plays (declarer's
// side maximises declarer's tricks; a defender maximises the defence).
// Among double-dummy-equivalent cards we play the lowest so play looks
// natural. lin.js must load first (globalThis.bpLin).

const L = globalThis.bpLin;

const SEATS = ['N', 'E', 'S', 'W'];       // clockwise; index matches DDS Direction
const SUITS = ['S', 'H', 'D', 'C'];       // index matches DDS suit encoding
const RVAL = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const IVAL = {}; for (const r in RVAL) IVAL[RVAL[r]] = r; // DDS int -> rank char
const DDS_TRUMP = { S: 0, H: 1, D: 2, C: 3 };            // NT -> 4

function partner(seat) { return SEATS[(SEATS.indexOf(seat) + 2) % 4]; }
function lho(seat) { return SEATS[(SEATS.indexOf(seat) + 1) % 4]; }
function sideOf(seat) { return (seat === 'N' || seat === 'S') ? 'NS' : 'EW'; }

// hands: { N:{S,H,D,C}, ... } with ten as "10". Returns each seat's holding
// as { suit: [rank chars, 'T' for ten, high→low] }.
function toRemaining(hands) {
  const rem = {};
  for (const s of SEATS) {
    rem[s] = {};
    for (const su of SUITS) {
      rem[s][su] = L.tokenizeSuit((hands[s] && hands[s][su]) || '')
        .map(r => (r === '10' ? 'T' : r))
        .sort((a, b) => RVAL[b] - RVAL[a]);
    }
  }
  return rem;
}

function initPlay({ hands, declarer, trump, contractLevel = null, contractDoubled = false, carding = null }) {
  const leader = lho(declarer);
  const remaining = toRemaining(hands);
  const originalRemaining = {};
  for (const seat of SEATS) {
    originalRemaining[seat] = {};
    for (const suit of SUITS) originalRemaining[seat][suit] = [...remaining[seat][suit]];
  }
  const selectedCarding = carding
    || globalThis.bpIps?.getCardingAgreements?.()
    || globalThis.bpCardingPreferences
    || { NS: 'UDCA', EW: 'UDCA' };
  return {
    declarer, dummy: partner(declarer), trump: trump || null, contractLevel,
    contractDoubled: !!contractDoubled, leader,
    carding: { NS: selectedCarding.NS || 'UDCA', EW: selectedCarding.EW || 'UDCA' },
    remaining, originalRemaining,
    turn: leader,
    trickLeader: leader,
    trick: [],           // current (incomplete) trick: [{ seat, suit, rank }]
    tricks: [],          // completed tricks: [{ cards, winner, leader }]
    playHistory: [],     // every card, including completed tricks, in play order
    discardCount: { N: 0, E: 0, S: 0, W: 0 },
    nsTricks: 0, ewTricks: 0,
  };
}

function cardsInHand(state, seat) {
  const out = [];
  for (const su of SUITS) for (const r of state.remaining[seat][su]) out.push({ suit: su, rank: r });
  return out;
}

// Cards `seat` may legally play now (follow the led suit if able).
function legalMoves(state, seat) {
  seat = seat || state.turn;
  const all = cardsInHand(state, seat);
  if (!state.trick.length) return all;
  const led = state.trick[0].suit;
  const inSuit = all.filter(c => c.suit === led);
  return inSuit.length ? inSuit : all;
}

function isLegal(state, card, seat) {
  seat = seat || state.turn;
  return legalMoves(state, seat).some(c => c.suit === card.suit && c.rank === card.rank);
}

function trickWinner(trick, trump) {
  let best = trick[0];
  for (const t of trick.slice(1)) {
    const bT = trump && best.suit === trump, tT = trump && t.suit === trump;
    if ((tT && !bT) || (tT === bT && t.suit === best.suit && RVAL[t.rank] > RVAL[best.rank])) best = t;
  }
  return best.seat;
}

// Play `card` for the seat on turn. Mutates and returns state. Throws on an
// illegal card. Resolves the trick (winner, counts, next leader) on the 4th.
function applyCard(state, card) {
  const seat = state.turn;
  if (!isLegal(state, card, seat)) throw new Error(`illegal card ${card.suit}${card.rank} by ${seat}`);
  const ledSuit = state.trick.length ? state.trick[0].suit : null;
  const isDiscard = !!(ledSuit && card.suit !== ledSuit);
  if (!state.playHistory) state.playHistory = [];
  if (!state.discardCount) state.discardCount = { N: 0, E: 0, S: 0, W: 0 };
  state.playHistory.push({
    seat, suit: card.suit, rank: card.rank,
    trickIndex: state.tricks.length, position: state.trick.length,
    leader: state.trickLeader, isDiscard,
  });
  if (isDiscard) state.discardCount[seat]++;
  const arr = state.remaining[seat][card.suit];
  arr.splice(arr.indexOf(card.rank), 1);
  state.trick.push({ seat, suit: card.suit, rank: card.rank });
  if (state.trick.length === 4) {
    const winner = trickWinner(state.trick, state.trump);
    state.tricks.push({ cards: state.trick, winner, leader: state.trickLeader });
    if (sideOf(winner) === 'NS') state.nsTricks++; else state.ewTricks++;
    state.trick = [];
    state.trickLeader = winner;
    state.turn = winner;
  } else {
    state.turn = lho(seat);
  }
  return state;
}

function isComplete(state) {
  return state.trick.length === 0 && cardsInHand(state, 'N').length === 0;
}

// ---- DDS bridge ----------------------------------------------------------

// Current position as a bridge-dds DealPbn. remainCards holds only the cards
// still IN HAND (cards on the current trick are removed as they are played),
// which is exactly what DDS expects alongside currentTrick*/first.
function toDealPbn(state) {
  const remain = 'N:' + SEATS.map(s => SUITS.map(su => state.remaining[s][su].join('')).join('.')).join(' ');
  const cts = [0, 0, 0], ctr = [0, 0, 0];
  state.trick.forEach((t, i) => { cts[i] = DDS_TRUMP[t.suit]; ctr[i] = RVAL[t.rank]; });
  return {
    trump: state.trump == null ? 4 : DDS_TRUMP[state.trump],
    first: SEATS.indexOf(state.trickLeader),
    currentTrickSuit: cts,
    currentTrickRank: ctr,
    remainCards: remain,
  };
}

// DDS returns one representative per equivalence class (the highest of the
// class) plus a bitmask of the equal lower ranks. To play "the lowest" we
// drop to the lowest card of that class.
function lowestEqual(rankInt, equalsMask) {
  for (let r = 2; r < rankInt; r++) if ((equalsMask >> r) & 1) return r;
  return rankInt;
}

// Best card for the side to move. dds: a bridge-dds Dds instance.
// Returns { suit, rank, score } (score = DD tricks for the side to move).
function ddSuggest(dds, state) {
  // solutions=3 (all cards with real DD scores), mode=0 (no transposition-
  // table reuse — every solve is self-contained, so switching between deals
  // or replaying a position can never carry stale state; mode=2 faults).
  const ft = dds.SolveBoardPBN(toDealPbn(state), -1, 3, 0);
  let best = null;
  for (let i = 0; i < ft.cards; i++) {
    const suit = SUITS[ft.suit[i]];
    const rankVal = lowestEqual(ft.rank[i], ft.equals[i]);
    const cand = { suit, rank: IVAL[rankVal], score: ft.score[i], rankVal, suitIdx: ft.suit[i] };
    if (!best
      || cand.score > best.score
      || (cand.score === best.score && cand.rankVal < best.rankVal)
      || (cand.score === best.score && cand.rankVal === best.rankVal && cand.suitIdx < best.suitIdx)) {
      best = cand;
    }
  }
  return best && { suit: best.suit, rank: best.rank, score: best.score };
}

// Double-dummy trick counts for the side to move, from ONE solve of the
// current position: `best` = the most tricks that side can still win against
// best defense (over all legal cards), and `played` = the tricks that side
// wins if it commits to `card` now (found by matching card against the
// equivalence class DDS returns — its representative rank plus the `equals`
// bitmask of equal lower ranks). `played` is null if `card` isn't legal here.
// Same solve params as ddSuggest (solutions=3 all cards, mode=0 self-contained).
function ddScores(dds, state, card) {
  const ft = dds.SolveBoardPBN(toDealPbn(state), -1, 3, 0);
  let best = null, played = null;
  for (let i = 0; i < ft.cards; i++) {
    if (best == null || ft.score[i] > best) best = ft.score[i];
    if (card && SUITS[ft.suit[i]] === card.suit) {
      const rv = RVAL[card.rank];
      if (ft.rank[i] === rv || ((ft.equals[i] >> rv) & 1)) played = ft.score[i];
    }
  }
  return { best, played };
}

// Deep clone of game state for lookahead (minimax and partner-signal preview).
function cloneState(state) {
  const rem = {};
  for (const s of SEATS) {
    rem[s] = {};
    for (const su of SUITS) rem[s][su] = [...state.remaining[s][su]];
  }
  return {
    declarer: state.declarer, dummy: state.dummy, trump: state.trump,
    contractLevel: state.contractLevel ?? null, contractDoubled: !!state.contractDoubled,
    carding: { ...(state.carding || { NS: 'UDCA', EW: 'UDCA' }) }, leader: state.leader,
    remaining: rem, turn: state.turn, trickLeader: state.trickLeader,
    originalRemaining: Object.fromEntries(SEATS.map(seat => [seat,
      Object.fromEntries(SUITS.map(suit => [suit, [...(state.originalRemaining?.[seat]?.[suit] || state.remaining[seat][suit])]]))
    ])),
    playHistory: (state.playHistory || []).map(play => ({ ...play })),
    discardCount: { ...(state.discardCount || { N: 0, E: 0, S: 0, W: 0 }) },
    trick: state.trick.map(t => ({ ...t })),
    tricks: state.tricks.map(t => ({ cards: t.cards.map(c => ({ ...c })), winner: t.winner, leader: t.leader })),
    nsTricks: state.nsTricks, ewTricks: state.ewTricks,
  };
}

// Play one program (DDS) card for the seat on turn. Returns { seat, suit, rank, score }.
// When userSeats + declarer are supplied, delegates to bpIps.selectCard for
// role-aware, naturalness-filtered selection. Omitting userSeats/declarer falls
// back to plain cheapest-of-equals (used by autoAdvance and claim validation).
function programMove(dds, state, userSeats, declarer) {
  const seat = state.turn;
  const s = (userSeats && declarer && globalThis.bpIps)
    ? globalThis.bpIps.selectCard(dds, state, userSeats, declarer)
    : ddSuggest(dds, state);
  applyCard(state, { suit: s.suit, rank: s.rank });
  return { seat, ...s };
}

// Let DDS play every seat NOT in userSeats until it is a user seat's turn or
// the deal ends. Returns the moves played, in order.
function autoAdvance(dds, state, userSeats) {
  const moves = [];
  while (!isComplete(state) && !userSeats.has(state.turn)) moves.push(programMove(dds, state));
  return moves;
}

// Replay an exact sequence of cards (LIN tokens like "D3"/"HT", card symbols
// like "♦3", or { suit, rank }). Used for the stored play-so-far prefix and
// the pre-played opening lead.
function replaySequence(state, cards) {
  for (const raw of cards) {
    const c = typeof raw === 'string' ? L.parseLeadCard(raw) : raw;
    if (!c) throw new Error(`cannot parse card ${raw}`);
    applyCard(state, { suit: c.suit, rank: c.rank });
  }
  return state;
}

// ---- setup from a stored row --------------------------------------------

// Parse the hands / dealer / auction out of a canonical LIN (the same string
// linIsPlayable() gates on, so misprint repairs are already baked in).
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

// Which seats the human controls: declarer + dummy for a declarer-play
// problem (the solver seat is on declarer's side), else the single defender.
function computeUserSeats(declarer, visibleHands) {
  const dummy = partner(declarer);
  const solver = (visibleHands || []).find(s => s !== dummy);
  if (solver && sideOf(solver) === sideOf(declarer)) return new Set([declarer, dummy]);
  if (solver) return new Set([solver]);
  return new Set([declarer, dummy]);
}

// Build the opening state for a bp_problems row. Returns a FRESH position
// (nothing played) plus `script`: the exact cards from the original position
// up to the book's decision point, for the UI to step through one at a time.
// The script is the stored narrated play when it simulates cleanly, else just
// the opening lead when it sits in the leader's hand, else empty.
// Returns { state, hands, declarer, dummy, trump, leader, solver, visible,
// userSeats, script, usedPlayPrefix } or null if the row is not playable.
function setupFromRow(row) {
  if (!L.linIsPlayable(row.lin)) return null;   // the modal button gates on this too
  const parsed = parseLin(row.lin);
  if (!parsed || !parsed.declarer) return null;
  const { hands, declarer, trump } = parsed;
  const dummy = partner(declarer);
  const leader = lho(declarer);
  const visible = row.problem_visible_hands || [];
  const solver = visible.find(s => s !== dummy) || null;
  const userSeats = computeUserSeats(declarer, visible);

  const contractLevel = Number.parseInt(row.contract, 10) || null;
  const contractDoubled = /x/i.test(row.contract || '');
  const state = initPlay({ hands, declarer, trump, contractLevel, contractDoubled }); // fresh: nothing played yet
  const lead = L.parseLeadCard(row.lead);

  let script = [], usedPlayPrefix = false;
  if (Array.isArray(row.play) && row.play.length) {
    const sim = L.simulatePlay(row.play, hands, declarer, trump);
    if (sim && (!lead || sim[0] === lead.suit + lead.rank)) {
      script = row.play.map(c => { const pc = L.parseLeadCard(c); return { suit: pc.suit, rank: pc.rank }; });
      usedPlayPrefix = true;
    }
  }
  if (!script.length && lead && L.seatHoldingLead(hands, lead) === leader) {
    script = [{ suit: lead.suit, rank: lead.rank }];
  }

  return { state, hands, declarer, dummy, trump, leader, solver, visible, userSeats, script, usedPlayPrefix };
}

const bpPlay = {
  SEATS, SUITS, RVAL, IVAL,
  partner, lho, sideOf,
  initPlay, cardsInHand, legalMoves, isLegal, trickWinner, applyCard, isComplete,
  toDealPbn, ddSuggest, ddScores, cloneState, lowestEqual, programMove, autoAdvance, replaySequence,
  parseLin, computeUserSeats, setupFromRow,
};
globalThis.bpPlay = bpPlay;
if (typeof module !== 'undefined' && module.exports) module.exports = bpPlay;
