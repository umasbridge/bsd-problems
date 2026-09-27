// Bridge Problems adapter for the standalone table components in bsd-app's
// /bridge-lib: BridgePlayer (the user plays, the computer plays the other
// seats) and DealViewer (display only).
//
// Bridge Problems owns problem navigation, source/solution display and attempt
// persistence; the components own the table, the card play and the solver.

function normalizeLin(lin) {
  return String(lin || '')
    .replace(/mb\|ap\|/gi, 'mb|p|mb|p|mb|p|')
    .replace(/mb\|P\|/g, 'mb|p|');
}

function contractFromProblem(str) {
  const c = globalThis.bpLin?.parseContractStr?.(str);
  if (!c) return undefined;
  return c.level + c.denom + (c.x === 'xx' ? 'XX' : c.x === 'x' ? 'X' : '');
}

// ── BridgePlayer ────────────────────────────────────────────────────────────
// Maps a problem onto BridgePlayer's generic seat options. Returns null for
// problems that aren't played out (the caller shows mountProblemDisplay).
//   Declarer Play: you see and play declarer + dummy; the computer plays both defenders.
//   Defense / Defensive Play: you see your hand + dummy and play your hand; the
//                  computer plays dummy, declarer and your partner.
function bridgePlayerSeats(problem, lin) {
  let type = String(problem.subcategory || '').trim().toLowerCase();
  if (type === 'defensive play') type = 'defense';
  if (type !== 'declarer play' && type !== 'defense') return null;
  const P = globalThis.bpPlay;
  let declarer = String(P?.parseLin?.(lin)?.declarer || '').toUpperCase();
  if (!declarer) {
    const m = (problem.contract || '').match(/\s([NESW])\s*$/i);
    if (m) declarer = m[1].toUpperCase();
  }
  if (!declarer) return null;
  const dummy = P.partner(declarer);
  if (type === 'declarer play') {
    return { declarer, visibleSeats: [declarer, dummy], userSeats: [declarer, dummy] };
  }
  const visible = (problem.problem_visible_hands || []).map(seat => String(seat).toUpperCase());
  const mySeat = visible.find(seat => seat !== dummy && seat !== declarer);
  if (!mySeat) return null;
  return { declarer, visibleSeats: [mySeat, dummy], userSeats: [mySeat] };
}

// Returns the BridgePlayer controller ({ unmount }), or null when the problem
// isn't an interactive-play problem (caller shows mountProblemDisplay instead).
export async function mountBridgePlayerForProblem(container, problem, options = {}) {
  if (!container) throw new Error('BridgePlayer requires a container');
  if (!problem.lin) return null;
  const lin = normalizeLin(problem.lin);
  const seats = bridgePlayerSeats(problem, lin);
  if (!seats) return null;
  const { mountBridgePlayer } = await import('/bridge-lib/bridge-player/BridgePlayer.js');
  const userSide = globalThis.bpPlay.sideOf(seats.userSeats[0]);
  const userIsDeclarer = userSide === globalThis.bpPlay.sideOf(seats.declarer);

  return mountBridgePlayer(container, {
    lin,
    userSeats: seats.userSeats,
    visibleSeats: seats.visibleSeats,
    // Many problem LINs have no auction; the contract column then supplies
    // the strain (trumps!) and level.
    contract: contractFromProblem(problem.contract) || null,
    declarer: seats.declarer,
    showAuction: true,
    // Show the lead, then step through the book's play to the decision point.
    preplayLead: true,
    autoplay: true,
    cardingNS: options.cardingNS || 'UDCA',
    cardingEW: options.cardingEW || 'UDCA',
    // Convert BridgePlayer's { state, contractData } into the attempt row the
    // viewer records (optimal needs a DD
    // target BridgePlayer doesn't report yet).
    onComplete: ({ state, contractData }) => {
      const made = userSide === 'NS' ? state.nsTricks : state.ewTricks;
      const target = contractData?.level ? contractData.level + 6 : null;
      options.onComplete?.({
        interactive: true,
        gaveUp: false,
        solved: target == null ? null : made >= (userIsDeclarer ? target : 14 - target),
        retries: [],
        tricksMade: made,
        optimal: null,
        timestamp: new Date().toISOString(),
      });
    },
  });
}

// Display-only table (no play) for problems that aren't played out: bidding,
// suit combinations, double dummy, etc. Shows hands_structured as stored, so
// partial hands and 'x' spot cards display as they do in the static deal.
export async function mountProblemDisplay(container, problem, options = {}) {
  if (!container) throw new Error('Display requires a container');
  const { mountDealViewer } = await import('/bridge-lib/deal-viewer/DealViewer.js');
  return mountDealViewer(container, {
    // Stored hands as-is; without them DealViewer draws the LIN's deal.
    hands: problem.hands_structured || null,
    lin: problem.lin ? normalizeLin(problem.lin) : '',
    visibleSeats: (problem.problem_visible_hands || ['N', 'S']).map(seat => String(seat).toUpperCase()),
    bottomLeftHtml: options.bottomLeftHtml || '',
  });
}

