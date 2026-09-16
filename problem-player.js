// Bridge Problems adapter for the shared IPS play runtime.
//
// Bridge Problems owns problem navigation, source/solution display and attempt
// persistence. IPS owns the hand layout, bridge engine, DDS, controls and play
// lifecycle. Keeping this adapter small prevents the two modules from growing
// separate play implementations again.

let runtimePromise;

function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import('../bridge-lib/ips/ips-module.js'),
      import('../bridge-lib/ips/ips-bidding.js'),
    ]).then(([{ createIpsPlayerRuntime }, bidding]) => ({ runtime: createIpsPlayerRuntime(), bidding }));
  }
  return runtimePromise;
}

function normalizeLin(lin) {
  return String(lin || '')
    .replace(/mb\|ap\|/gi, 'mb|p|mb|p|mb|p|')
    .replace(/mb\|P\|/g, 'mb|p|');
}

function normalizeCard(card) {
  if (!card) return null;
  if (typeof card === 'object' && card.suit && card.rank) card = `${card.suit}${card.rank}`;
  const value = String(card).trim().toUpperCase().replace('10', 'T')
    .replace('♠', 'S').replace('♥', 'H').replace('♦', 'D').replace('♣', 'C')
    .replace(/\s+/g, '');
  return /^[SHDC][2-9TJQKA]$/.test(value) ? value : null;
}

function contractFromCalls(calls) {
  let bid = null;
  let doubled = '';
  for (const call of calls || []) {
    if (/^[1-7]/.test(call)) { bid = call; doubled = ''; }
    else if (call === 'X') doubled = 'X';
    else if (call === 'XX') doubled = 'XX';
  }
  return bid ? `${bid}${doubled}` : undefined;
}

function contractFromProblem(str) {
  const c = globalThis.bpLin?.parseContractStr?.(str);
  if (!c) return undefined;
  return c.level + c.denom + (c.x === 'xx' ? 'XX' : c.x === 'x' ? 'X' : '');
}

function rowFromProblem(problem, linData) {
  const lin = normalizeLin(problem.lin);
  const parsed = globalThis.bpPlay?.parseLin?.(lin);
  let declarer = String(parsed?.declarer || '').toUpperCase();
  if (!declarer) {
    const m = (problem.contract || '').match(/\s([NESW])\s*$/i);
    if (m) declarer = m[1].toUpperCase();
  }
  const dummy = declarer ? globalThis.bpPlay?.partner?.(declarer) : null;
  const sourceVisible = (problem.problem_visible_hands || ['S']).map(seat => String(seat).toUpperCase());
  const userSeat = sourceVisible.find(seat => seat !== dummy) || declarer || 'S';
  const declarerSide = declarer && globalThis.bpPlay?.sideOf?.(declarer);
  const userIsDeclarerSide = declarerSide && globalThis.bpPlay?.sideOf?.(userSeat) === declarerSide;
  const playFromLin = linData.play.map(normalizeCard).filter(Boolean);
  // Fall back to the DB lead column so the lead is always in the script even
  // when the LIN has no pc| tokens. Bridge-problems always pre-plays the
  // opening lead before handing control to the user (regardless of seat).
  const leadCard = playFromLin[0] || normalizeCard(problem.lead) || undefined;
  return {
    lin,
    play: playFromLin.length ? playFromLin : (leadCard ? [leadCard] : []),
    problem_visible_hands: [userIsDeclarerSide ? declarer : userSeat],
    problem_user_hands: userIsDeclarerSide && dummy ? [declarer, dummy] : [userSeat],
    contract: contractFromCalls(linData.bids?.map(entry => entry.bid)) || contractFromProblem(problem.contract),
    declarer: declarer || undefined,
    lead: leadCard || undefined,
    vul: linData.vul,
    alwaysPrePlayScript: true,
  };
}

export async function mountProblemPlayer(container, problem, options = {}) {
  if (!container) throw new Error('ProblemPlayer requires a container');
  if (!problem.lin) throw new Error('Problem has no canonical LIN');
  const { runtime, bidding } = await loadRuntime();
  const lin = normalizeLin(problem.lin);
  const linData = bidding.parseLinMetadata(lin);
  const row = rowFromProblem({ ...problem, lin }, linData);

  return runtime.mountIpsPlayer(container, {
    row,
    mode: 'play',
    ddsPath: '/bridge-lib/ips/dds/dds-api.js',
    format: options.format || problem.format || null,
    cardingNS: options.cardingNS || 'UDCA',
    cardingEW: options.cardingEW || 'UDCA',
    onComplete: options.onComplete,
    biddingHtml: bidding.buildAuctionHtml(linData),
  });
}
