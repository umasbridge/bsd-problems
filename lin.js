// Shared LIN builder for bridge problems — single source of truth used by
// the viewer (classic <script src>), the editor module (via window.bpLin),
// and the backfill script (Node ESM import reads globalThis.bpLin).
//
// Builds a BBO handviewer LIN from a bp_problems row: deal (md), dealer,
// vulnerability, auction (stored one when it reaches the contract cleanly,
// else synthesized passes → contract with declarer inferred from the
// opening lead), and the lead as the first played card.

const SUIT_ORDER = ['S', 'H', 'D', 'C'];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const LIN_SEATS = ['N', 'E', 'S', 'W']; // clockwise
const SUIT_LETTER = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };
const SEAT_FULL = { N: 'North', E: 'East', S: 'South', W: 'West' };
const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function sideOfSeat(seat) { return seat === 'N' || seat === 'S' ? 'NS' : 'EW'; }
function nominalDeclarer(leader) { return LIN_SEATS[(LIN_SEATS.indexOf(leader) + 3) % 4]; }

function tokenizeSuit(s) {
  const tokens = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '1' && s[i + 1] === '0') { tokens.push('10'); i++; }
    else tokens.push(s[i]);
  }
  return tokens;
}

function parseVulToLin(v) {
  const s = (v || '').toLowerCase();
  if (/love|none|neither|nil/.test(s)) return 'o';
  if (/(^|[^a-z])(n[\s\/\-–.]*s)([^a-z]|$)|north.{0,3}south/.test(s)) return 'n';
  if (/(^|[^a-z])(e[\s\/\-–.]*w)([^a-z]|$)|east.{0,3}west/.test(s)) return 'e';
  if (/both|all|game/.test(s)) return 'b';
  return 'o';
}

function parseDealerLetter(d) {
  const m = (d || '').trim().charAt(0).toUpperCase();
  return LIN_SEATS.includes(m) ? m : 'N';
}

// "4♠" / "3NT" / "5♦X" / "4♥ doubled" → { level, denom, x } | null
function parseContractStr(c) {
  const s = (c || '').trim();
  const m = s.match(/^([1-7])\s*(NT|[♠♥♦♣SHDCN])/i);
  if (!m) return null;
  let denom = m[2].toUpperCase();
  denom = SUIT_LETTER[m[2]] || (denom === 'NT' || denom === 'N' ? 'N' : denom);
  const rest = s.slice(m.index + m[0].length);
  const x = /xx|redoubl/i.test(rest) ? 'xx' : /x|doubl/i.test(rest) ? 'x' : '';
  return { level: m[1], denom, x };
}

// "♥Q", "Q♥", "♦10", or ASCII "HQ", "D10", "SA", "HX" → { suit: 'H', rank: 'Q' } | null
// Lowercase ranks (e.g. "hq") and 'x'/'X' (small card) are accepted.
function parseLeadCard(lead) {
  const s = (lead || '').trim().toUpperCase();
  // Unicode suit symbol: ♥Q or Q♥
  let m = s.match(/([♠♥♦♣])\s*(10|[AKQJT2-9X])/) || s.match(/(10|[AKQJT2-9X])\s*([♠♥♦♣])/);
  if (m) {
    const suit = SUIT_LETTER[m[1]] || SUIT_LETTER[m[2]];
    const rank = SUIT_LETTER[m[1]] ? m[2] : m[1];
    return suit ? { suit, rank: rank === '10' ? 'T' : rank } : null;
  }
  // ASCII suit prefix: HQ, D10, SA, C2, HX (the format users type in the play grid)
  m = s.match(/^([SHDC])(10|[AKQJT2-9X])$/);
  if (m) {
    return { suit: m[1], rank: m[2] === '10' ? 'T' : m[2] };
  }
  return null;
}

function seatHoldingLead(hands, card) {
  if (!card) return null;
  const needle = card.rank === 'T' ? '10' : card.rank;
  const found = LIN_SEATS.filter(s => {
    const suit = (hands[s] && hands[s][card.suit]) || '';
    return needle === '10' ? suit.includes('10') : suit.replace(/10/g, '').includes(needle);
  });
  return found.length === 1 ? found[0] : null; // ambiguous 10 vs T impossible, but be safe
}

// "1♠" → "1S", "Pass" → "p", "Dbl"/"X" → "d", "Rdbl"/"XX" → "r"; null if unrecognized
function callToLin(call) {
  const s = (call || '').replace(/\(.*?\)|[*!]/g, '').trim().replace(/[.,;:]+$/, '').trim();
  if (/^p(ass)?$/i.test(s)) return 'p';
  if (/^(rdbl|redbl|redouble|xx)$/i.test(s)) return 'r';
  if (/^(dbl|dble|double|x)$/i.test(s)) return 'd';
  const m = s.match(/^([1-7])\s*(NT|[♠♥♦♣SHDCN])$/i);
  if (!m) return null;
  const denom = SUIT_LETTER[m[2]] || (m[2].toUpperCase() === 'NT' ? 'N' : m[2].toUpperCase());
  return m[1] + denom;
}

function finalContractFromCalls(calls) {
  let bid = null;
  let doubled = '';
  for (const call of calls || []) {
    if (/^[1-7]/.test(call)) { bid = call; doubled = ''; }
    else if (call === 'd' && bid) doubled = 'd';
    else if (call === 'r' && bid) doubled = 'r';
  }
  return { bid, doubled };
}

// Problem imports use two auction shapes. Normalize both without changing the
// stored compatibility column: {dealer,calls:[...]} and
// {dealer,columns:[...],rows:[[...], ...]}. A terminal "All Pass" shorthand
// represents the three closing passes in canonical LIN.
function storedAuctionCalls(bidding) {
  if (!bidding) return null;
  let raw = Array.isArray(bidding.calls) ? bidding.calls : null;
  if ((!raw || !raw.length) && Array.isArray(bidding.rows)) {
    raw = bidding.rows.flat().filter(call => call && call !== '—');
  }
  if (!raw?.length) return null;
  const expanded = [];
  for (const call of raw) {
    if (/^\(?\s*(?:all\s*pass|ap|end)\s*\)?[.]?$/i.test(String(call || ''))) expanded.push('Pass', 'Pass', 'Pass');
    else expanded.push(call);
  }
  return expanded;
}

// Replace 'X' (small-card placeholder) with actual available ranks, high-to-low.
// X's in the same suit across different hands each get a distinct rank.
// Returns original hands if no X's present; new hands object otherwise.
function resolveXCards(hands) {
  if (!hands) return hands;
  const hasX = LIN_SEATS.some(s =>
    SUIT_ORDER.some(su => ((hands[s]?.[su]) || '').toUpperCase().replace(/10/g, 'T').includes('X'))
  );
  if (!hasX) return hands;
  const usedPerSuit = {};
  for (const su of SUIT_ORDER) usedPerSuit[su] = new Set();
  for (const seat of LIN_SEATS) {
    for (const su of SUIT_ORDER) {
      for (const tok of tokenizeSuit(((hands[seat]?.[su]) || '').toUpperCase().replace(/10/g, 'T'))) {
        if (tok !== 'X') usedPerSuit[su].add(tok);
      }
    }
  }
  const availPerSuit = {};
  for (const su of SUIT_ORDER) {
    // available ranks high-to-low; prefer small cards (below J) but use any available
    availPerSuit[su] = [...RANK_ORDER].reverse().filter(r => !usedPerSuit[su].has(r));
  }
  const resolved = {};
  for (const seat of LIN_SEATS) {
    resolved[seat] = {};
    for (const su of SUIT_ORDER) {
      const toks = tokenizeSuit(((hands[seat]?.[su]) || '').toUpperCase().replace(/10/g, 'T'));
      resolved[seat][su] = toks.map(tok => (tok === 'X' ? (availPerSuit[su].shift() || tok) : tok)).join('');
    }
  }
  return resolved;
}

// A fair number of book extractions have corrupt deals (duplicated cards,
// 14-card hands). Only offer the handviewer for a verifiably consistent
// deal: no duplicate cards and all four hands the same size. Hands smaller
// than 13 are fine — end positions play out the same way (verified: the
// handviewer renders, plays and DD-analyses partial deals).
function isValidDeck(hands) {
  hands = resolveXCards(hands);
  const seen = new Set();
  const sizes = [];
  for (const seat of LIN_SEATS) {
    let n = 0;
    for (const su of SUIT_ORDER) {
      const v = ((hands[seat] && hands[seat][su]) || '').replace(/10/g, 'T');
      for (const c of v) {
        if (!'AKQJT98765432'.includes(c)) return false;
        if (seen.has(su + c)) return false;
        seen.add(su + c);
        n++;
      }
    }
    sizes.push(n);
  }
  return sizes[0] >= 1 && sizes[0] <= 13 && sizes.every(n => n === sizes[0]);
}

// Source books/sites misprint deals so that a card appears in two seats
// while a card of the SAME suit is missing (documented for Martens VEC in
// the extraction's BOOK_TYPOS.md; verified rampant on kantarbridge.com).
// Repairable when every duplicated card and every missing card is a
// non-honor (2..10) and, suit by suit, dupes pair off with missing ranks.
// Each dupe's later-seat instance (N,E,S,W order) becomes the paired
// missing rank. Honor misprints (J+) stay unrepaired — an honor in the
// wrong seat materially changes the analysis (e.g. VEC Board 48's ♣J).
// The DB row stays verbatim; only the derived LIN uses the repair.
// Returns { hands, note } or null.
function repairKnownMisprint(hands) {
  if (!hands || !LIN_SEATS.every(s => hands[s])) return null;
  const holders = {}; // card -> seats holding it
  const sizes = [];
  for (const seat of LIN_SEATS) {
    let n = 0;
    for (const su of SUIT_ORDER) {
      for (const tok of tokenizeSuit((hands[seat] && hands[seat][su]) || '')) {
        if (!RANK_ORDER.includes(tok)) return null;
        const card = su + tok;
        (holders[card] = holders[card] || []).push(seat);
        n++;
      }
    }
    sizes.push(n);
  }
  // Misprints of this shape only occur in full-deal books; partial deals
  // can't distinguish "missing" from "not part of the position".
  if (sizes.some(s => s !== 13)) return null;

  const isSpot = r => /^(10|[2-9])$/.test(r);
  const repaired = {};
  for (const s of LIN_SEATS) repaired[s] = { ...hands[s] };
  const notes = [];
  for (const su of SUIT_ORDER) {
    const dupes = Object.keys(holders)
      .filter(c => c[0] === su && holders[c].length === 2)
      .map(c => c.slice(1));
    if (Object.keys(holders).some(c => c[0] === su && holders[c].length > 2)) return null;
    const present = new Set(Object.keys(holders).filter(c => c[0] === su).map(c => c.slice(1)));
    const missing = RANK_ORDER.filter(r => !present.has(r));
    if (dupes.length !== missing.length) return null;
    if (!dupes.length) continue;
    if (!dupes.every(isSpot) || !missing.every(isSpot)) return null;
    // pair off in rank order; replace the later seat's instance
    const byRank = r => RANK_ORDER.indexOf(r);
    dupes.sort((a, b) => byRank(a) - byRank(b));
    missing.sort((a, b) => byRank(a) - byRank(b));
    for (let i = 0; i < dupes.length; i++) {
      const seat = holders[su + dupes[i]][1];
      const toks = tokenizeSuit(repaired[seat][su] || '');
      toks[toks.indexOf(dupes[i])] = missing[i]; // exactly one instance
      toks.sort((a, b) => byRank(b) - byRank(a)); // display high-to-low
      repaired[seat][su] = toks.join('');
      notes.push(`${SUIT_SYM[su]}${dupes[i]} printed in two seats; ${SUIT_SYM[su]}${missing[i]} assigned to ${SEAT_FULL[seat]}`);
    }
  }
  if (!notes.length) return null;
  return { hands: repaired, note: 'misprint: ' + notes.join('; ') };
}

// p.play holds the narrated play-so-far as cards from trick 1 in play
// order (e.g. ["♦3","♦K","♦A","♦6","♥2",...]). Validate it by simulation:
// the opening leader is declarer's LHO; each card must be in the seat's
// remaining hand; players follow suit when able; the trick winner (highest
// trump, else highest card of the led suit) leads the next trick. An
// incomplete final trick is fine — that's the decision point. Returns the
// cards as LIN tokens ("D3","DK",...) or null if the narration doesn't
// simulate cleanly against this deal.
function simulatePlay(play, hands, declarer, trumpSuit) {
  if (!Array.isArray(play) || !play.length || !declarer) return null;
  const remaining = {};
  for (const seat of LIN_SEATS) {
    remaining[seat] = {};
    for (const su of SUIT_ORDER) {
      remaining[seat][su] = tokenizeSuit((hands[seat] && hands[seat][su]) || '')
        .map(r => (r === '10' ? 'T' : r));
    }
  }
  const rankVal = r => 'AKQJT98765432'.indexOf(r); // lower = higher
  let turn = LIN_SEATS[(LIN_SEATS.indexOf(declarer) + 1) % 4];
  const out = [];
  let trick = [];
  let ledSuit = null;
  for (const raw of play) {
    const card = parseLeadCard(raw);
    if (!card) return null;
    const hand = remaining[turn];
    // 'X' = small card placeholder: resolve to the lowest available card of that suit
    let rank = card.rank;
    if (rank === 'X') {
      if (!hand[card.suit].length) return null;
      rank = hand[card.suit].reduce((a, b) => rankVal(a) > rankVal(b) ? a : b);
    }
    const idx = hand[card.suit].indexOf(rank);
    if (idx < 0) return null;
    if (ledSuit && card.suit !== ledSuit && hand[ledSuit].length) return null;
    hand[card.suit].splice(idx, 1);
    trick.push({ seat: turn, suit: card.suit, rank });
    out.push(card.suit + rank);
    if (!ledSuit) ledSuit = card.suit;
    if (trick.length === 4) {
      let best = trick[0];
      for (const t of trick.slice(1)) {
        const bestTrump = trumpSuit && best.suit === trumpSuit;
        const tTrump = trumpSuit && t.suit === trumpSuit;
        if ((tTrump && !bestTrump) ||
            (tTrump === bestTrump && t.suit === best.suit && rankVal(t.rank) < rankVal(best.rank))) {
          best = t;
        }
      }
      turn = best.seat;
      trick = [];
      ledSuit = null;
    } else {
      turn = LIN_SEATS[(LIN_SEATS.indexOf(turn) + 1) % 4];
    }
  }
  return out;
}

// First player of the winning side to name the final denomination.
function declarerFromCalls(calls, dealer) {
  let lastBid = null, lastIdx = -1;
  calls.forEach((c, i) => { if (/^[1-7]/.test(c)) { lastBid = c; lastIdx = i; } });
  if (!lastBid) return null;
  const dealerIdx = LIN_SEATS.indexOf(dealer);
  for (let i = 0; i < calls.length; i++) {
    if (/^[1-7]/.test(calls[i]) && calls[i][1] === lastBid[1] && (i % 2) === (lastIdx % 2)) {
      return LIN_SEATS[(dealerIdx + i) % 4];
    }
  }
  return null;
}

function problemToLin(p, hands) {
  hands = resolveXCards(hands);
  if (!hands || !LIN_SEATS.every(s => hands[s]) || !isValidDeck(hands)) return null;
  const contract = parseContractStr(p.contract);
  if (!contract) return null;

  const lead = parseLeadCard(p.lead);
  let dealer = parseDealerLetter(p.bidding && p.bidding.dealer || p.dealer);

  // Never invent an auction. If stored bidding exists, it must parse and agree
  // with the compatibility contract column before it can become playable LIN.
  // Otherwise canonicalize() falls back to display LIN containing the stored
  // calls verbatim, preserving the integrity issue for review.
  const storedCalls = storedAuctionCalls(p.bidding);
  if (!storedCalls) return null;
  const parsed = storedCalls.map(callToLin);
  if (parsed.includes(null)) return null;
  const finalContract = finalContractFromCalls(parsed);
  const wantX = contract.x === 'xx' ? 'r' : contract.x === 'x' ? 'd' : '';
  if (finalContract.bid !== contract.level + contract.denom || finalContract.doubled !== wantX) return null;
  const calls = [...parsed];
  const callExplanations = storedCalls.map((_, index) => {
    const value = p.bidding?.notes?.[index];
    return typeof value === 'string' ? value.trim() : '';
  });
  while (calls.length && calls[calls.length - 1] === 'p') calls.pop();
  calls.push('p', 'p', 'p');

  const dealerDigit = { S: '1', W: '2', N: '3', E: '4' }[dealer];
  const md = ['S', 'W', 'N', 'E'].map(seat =>
    SUIT_ORDER.map(su => su + ((hands[seat] && hands[seat][su]) || '').replace(/10/g, 'T')).join('')
  ).join(',');
  const num = (String(p.problem_number || '').match(/\d+/) || ['1'])[0];
  const vul = parseVulToLin(p.vulnerability);

  let lin = `qx|o${num}|md|${dealerDigit}${md}|rh||ah|Board ${num}|sv|${vul}|`;
  lin += calls.map((c, index) => {
    const explanation = callExplanations[index]?.replace(/\|/g, '/');
    return `mb|${c}|${explanation ? `an|${explanation}|` : ''}`;
  }).join('');
  const declarer = declarerFromCalls(calls, dealer);
  const leader = declarer && LIN_SEATS[(LIN_SEATS.indexOf(declarer) + 1) % 4];
  // Narrated play-so-far, only when it simulates cleanly and starts with
  // the stored lead (a mismatch means the extraction is suspect).
  let played = null;
  if (p.play) {
    played = simulatePlay(p.play, hands, declarer, contract.denom === 'N' ? null : contract.denom);
    if (played && lead && played[0] !== lead.suit + lead.rank) played = null;
    if (Array.isArray(p.play) && p.play.length && !played) return null;
  }
  if (played) {
    lin += played.map(c => `pc|${c}|`).join('');
  } else if (lead && leader && seatHoldingLead(hands, lead) === leader) {
    // Pre-play the lead only when it really sits in the leader's hand —
    // otherwise (auction/lead mismatch in the source) let the user play it.
    lin += `pc|${lead.suit}${lead.rank}|`;
  }
  return lin + 'pg||';
}

// Best-effort display LIN for rows without a playable deal (bidding
// problems, suit combinations, partial play problems): whatever hands are
// known (unknown seats left empty), dealer, vulnerability, and the stored
// auction verbatim — even when it is incomplete (bidding problems stop at
// the decision point) or never reaches a contract. Not playable; the
// viewer decides what to offer via linIsPlayable().
function buildDisplayLin(p, hands) {
  hands = resolveXCards(hands || {}) || {};
  const dealer = parseDealerLetter((p.bidding && p.bidding.dealer) || p.dealer);
  const dealerDigit = { S: '1', W: '2', N: '3', E: '4' }[dealer];
  const md = ['S', 'W', 'N', 'E'].map(seat =>
    SUIT_ORDER.map(su => su + ((hands[seat] && hands[seat][su]) || '').replace(/10/g, 'T')).join('')
  ).join(',');
  if (!/[AKQJT2-9]/.test(md)) return null; // no cards known at all
  const num = (String(p.problem_number || '').match(/\d+/) || ['1'])[0];
  let lin = `qx|o${num}|md|${dealerDigit}${md}|rh||ah|Board ${num}|sv|${parseVulToLin(p.vulnerability)}|`;
  const storedCalls = storedAuctionCalls(p.bidding);
  if (storedCalls) {
    const parsed = storedCalls.map(callToLin);
    if (!parsed.includes(null)) {
      lin += parsed.map((c, index) => {
        const explanation = p.bidding?.notes?.[index];
        return `mb|${c}|${explanation ? `an|${String(explanation).replace(/\|/g, '/')}|` : ''}`;
      }).join('');
    }
  }
  if (Array.isArray(p.play)) {
    for (const value of p.play) {
      const card = parseLeadCard(value);
      if (card) lin += `pc|${card.suit}${card.rank}|`;
    }
  } else {
    const card = parseLeadCard(p.lead);
    if (card) lin += `pc|${card.suit}${card.rank}|`;
  }
  return lin + 'pg||';
}

// Parse the deal facts represented by LIN.  Consumers use this projection for
// forms and rendering; the database LIN remains the single stored authority.
function dealFromLin(lin) {
  if (!lin || typeof lin !== 'string') return null;
  const tokens = lin.split('|');
  const values = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    values.push({ key: tokens[i].toLowerCase(), value: tokens[i + 1] });
  }
  const md = values.find(x => x.key === 'md')?.value;
  if (!md || !/^[1-4]/.test(md)) return null;
  const dealer = ({ '1': 'S', '2': 'W', '3': 'N', '4': 'E' })[md[0]];
  const hands = {};
  const seats = ['S', 'W', 'N', 'E'];
  for (const [index, holding] of md.slice(1).split(',').entries()) {
    if (!seats[index]) break;
    const hand = { S: '', H: '', D: '', C: '' };
    let suit = null;
    for (const ch of holding.toUpperCase()) {
      if (SUIT_ORDER.includes(ch)) suit = ch;
      else if (suit && ch === 'T') hand[suit] += '10';
      else if (suit && RANK_ORDER.includes(ch)) hand[suit] += ch;
    }
    hands[seats[index]] = hand;
  }
  for (const seat of seats) hands[seat] ||= { S: '', H: '', D: '', C: '' };

  const vulCode = values.find(x => x.key === 'sv')?.value?.toLowerCase();
  const vulnerability = ({ o: 'None', n: 'NS', e: 'EW', b: 'Both' })[vulCode] || 'None';
  const calls = [];
  const notes = {};
  const play = [];
  let lastBidIndex = -1;
  for (const item of values) {
    if (item.key === 'mb') {
      const raw = item.value.toLowerCase();
      let call;
      if (raw === 'p') call = 'P';
      else if (raw === 'd') call = 'X';
      else if (raw === 'r') call = 'XX';
      else call = raw.toUpperCase().replace(/N$/, 'NT');
      calls.push(call);
      lastBidIndex = calls.length - 1;
    } else if (item.key === 'an' && lastBidIndex >= 0) {
      notes[lastBidIndex] = item.value;
    } else if (item.key === 'pc') {
      const card = parseLeadCard(item.value);
      if (card) play.push(SUIT_SYM[card.suit] + (card.rank === 'T' ? '10' : card.rank));
    }
  }
  const final = finalContractFromCalls(calls.map(callToLin).filter(Boolean));
  const contract = final?.bid
    ? final.bid.replace(/N$/, 'NT') + (final.doubled === 'd' ? 'X' : final.doubled === 'r' ? 'XX' : '')
    : '';
  return {
    dealer,
    vulnerability,
    hands_structured: hands,
    bidding: { dealer, calls, ...(Object.keys(notes).length ? { notes } : {}) },
    contract,
    lead: play[0] || '',
    play: play.length ? play : null,
  };
}

// Build canonical LIN from an editable deal model. `hands` is returned so
// callers can display any deterministic repair before saving; only `lin` is
// persisted as the deal's source of truth.
function canonicalize(p) {
  let hands = (p && p.hands_structured) || {};
  let repaired = null;
  let lin = problemToLin(p, hands);
  if (!lin) {
    const fix = repairKnownMisprint(hands);
    if (fix) { hands = fix.hands; repaired = fix.note; lin = problemToLin(p, hands); }
  }
  if (!lin) lin = buildDisplayLin(p, hands);
  return { hands, lin, repaired };
}

// A stored LIN supports "play it out" when its deal is consistent (four
// equal-sized hands, no duplicates) and its auction is complete with a
// final contract. Display-only LINs fail one of these.
function linIsPlayable(lin) {
  if (!lin) return false;
  const m = lin.match(/(^|\|)md\|\d([^|]*)/);
  if (!m) return false;
  const handsStr = m[2].split(',');
  if (handsStr.length !== 4) return false;
  const seen = new Set();
  const sizes = [];
  for (const h of handsStr) {
    let n = 0;
    let su = null;
    for (const ch of h) {
      if ('SHDC'.includes(ch)) { su = ch; continue; }
      if (!su || !'AKQJT98765432'.includes(ch) || seen.has(su + ch)) return false;
      seen.add(su + ch);
      n++;
    }
    sizes.push(n);
  }
  if (sizes[0] < 1 || !sizes.every(n => n === sizes[0])) return false;
  const calls = [...lin.matchAll(/mb\|([^|]+)\|/g)].map(x => x[1]);
  const hasBid = calls.some(c => /^[1-7]/.test(c));
  const closed = calls.length >= 4 && calls.slice(-3).every(c => c === 'p');
  return hasBid && closed;
}

const bpLin = {
  SUIT_ORDER, SUIT_SYM, LIN_SEATS, SUIT_LETTER, SEAT_FULL, RANK_ORDER,
  sideOfSeat, nominalDeclarer, tokenizeSuit,
  parseVulToLin, parseDealerLetter, parseContractStr, parseLeadCard,
  seatHoldingLead, callToLin, finalContractFromCalls, storedAuctionCalls, isValidDeck, repairKnownMisprint,
  simulatePlay, declarerFromCalls, problemToLin, buildDisplayLin, dealFromLin, canonicalize, linIsPlayable,
};
globalThis.bpLin = bpLin;
if (typeof module !== 'undefined' && module.exports) module.exports = bpLin;
