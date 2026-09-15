// playset.js — loads bsd_game_analyses boards for the play-set viewer
import { supabase } from './db.js';

export async function loadPlaySetBoards(analysisId) {
  const { data: analysis, error: aErr } = await supabase
    .from('bsd_game_analyses')
    .select('id, name, filters, participant_id')
    .eq('id', analysisId)
    .single();
  if (aErr || !analysis) throw new Error('Play set not found');

  const filters = analysis.filters || {};
  const stageIds = filters.stage_ids || (filters.stage_id ? [filters.stage_id] : []);
  if (!stageIds.length) throw new Error('No stages in this play set');

  const { data: boards, error: bErr } = await supabase
    .from('bg_boards')
    .select(`id, board_number, dealer, vulnerability,
      n_spades, n_hearts, n_diamonds, n_clubs,
      s_spades, s_hearts, s_diamonds, s_clubs,
      e_spades, e_hearts, e_diamonds, e_clubs,
      w_spades, w_hearts, w_diamonds, w_clubs`)
    .in('stage_id', stageIds)
    .order('board_number');
  if (bErr) throw new Error(bErr.message);
  if (!boards?.length) return [];

  const boardIds = boards.map(b => b.id);
  let rq = supabase
    .from('bg_board_results')
    .select('id, board_id, contract_level, contract_denom, contract_x, declarer, lead_suit, lead_rank, lin, passed_out')
    .in('board_id', boardIds);
  if (analysis.participant_id) {
    rq = rq.or(`ns_participant_id.eq.${analysis.participant_id},ew_participant_id.eq.${analysis.participant_id}`);
  }
  const { data: results } = await rq;

  const resultsByBoard = {};
  for (const r of (results || [])) {
    if (!resultsByBoard[r.board_id]) resultsByBoard[r.board_id] = r;
  }

  return boards.map(b => boardToItem(b, resultsByBoard[b.id], analysisId, analysis.name));
}

const DEALER_DIGIT = { N: '3', E: '4', S: '1', W: '2' };
const VUL_LIN      = { none: 'o', ns: 'n', ew: 'e', both: 'b', NS: 'n', EW: 'e' };

function handsToMd(b) {
  return ['s', 'w', 'n', 'e'].map(d =>
    `S${(b[`${d}_spades`]||'').replace(/10/g,'T')}` +
    `H${(b[`${d}_hearts`]||'').replace(/10/g,'T')}` +
    `D${(b[`${d}_diamonds`]||'').replace(/10/g,'T')}` +
    `C${(b[`${d}_clubs`]||'').replace(/10/g,'T')}`
  ).join(',');
}

function buildLin(b, result) {
  const dealer = DEALER_DIGIT[b.dealer] || '3';
  const vul    = VUL_LIN[b.vulnerability] || 'o';
  const bn     = b.board_number || '';
  let lin = `qx|o${bn}|md|${dealer}${handsToMd(b)}|rh||ah|Board ${bn}|sv|${vul}|`;

  if (!result || result.passed_out || !result.contract_level || !result.contract_denom) {
    return lin + 'pg||';
  }
  const seats = ['N', 'E', 'S', 'W'];
  const dealerIdx   = Math.max(0, seats.indexOf(b.dealer));
  const declarerIdx = seats.indexOf(result.declarer);
  if (declarerIdx < 0) return lin + 'pg||';

  const passesBefore = (declarerIdx - dealerIdx + 4) % 4;
  for (let i = 0; i < passesBefore; i++) lin += 'mb|p|';
  const denom = result.contract_denom === 'NT' ? 'N' : result.contract_denom;
  lin += `mb|${result.contract_level}${denom}|`;
  const x = (result.contract_x || '').toLowerCase();
  if (x === 'xx') lin += 'mb|d|mb|r|';
  else if (x === 'x') lin += 'mb|d|';
  lin += 'mb|p|mb|p|mb|p|';
  if (result.lead_suit && result.lead_rank) {
    lin += `pc|${result.lead_suit}${String(result.lead_rank).replace('10', 'T')}|`;
  }
  return lin + 'pg||';
}

function buildBiddingObj(b, result) {
  if (!result || result.passed_out || !result.contract_level || !result.contract_denom || !result.declarer) return null;
  const seats = ['N', 'E', 'S', 'W'];
  const dealerIdx   = Math.max(0, seats.indexOf(b.dealer));
  const declarerIdx = seats.indexOf(result.declarer);
  if (declarerIdx < 0) return null;
  const passesBefore = (declarerIdx - dealerIdx + 4) % 4;
  const denom = result.contract_denom === 'NT' ? 'N' : result.contract_denom;
  const x = (result.contract_x || '').toLowerCase();
  const calls = [
    ...Array(passesBefore).fill('p'),
    `${result.contract_level}${denom}`,
    ...(x === 'xx' ? ['d', 'r'] : x === 'x' ? ['d'] : []),
    'p', 'p', 'p',
  ];
  return { dealer: b.dealer, calls };
}

function boardToItem(b, result, analysisId, setName) {
  const hands_structured = {
    N: { S: b.n_spades || '', H: b.n_hearts || '', D: b.n_diamonds || '', C: b.n_clubs || '' },
    S: { S: b.s_spades || '', H: b.s_hearts || '', D: b.s_diamonds || '', C: b.s_clubs || '' },
    E: { S: b.e_spades || '', H: b.e_hearts || '', D: b.e_diamonds || '', C: b.e_clubs || '' },
    W: { S: b.w_spades || '', H: b.w_hearts || '', D: b.w_diamonds || '', C: b.w_clubs || '' },
  };

  // Prefer a stored LIN that already has a complete auction (mb|...|p|p|p|);
  // otherwise build one from the result columns.
  const storedLin = result?.lin;
  const linHasAuction = storedLin && /mb\|[^|]+\|mb\|p\|mb\|p\|mb\|p\|/.test(storedLin);
  const lin = linHasAuction ? storedLin : buildLin(b, result);

  const contract = result && !result.passed_out && result.contract_level && result.contract_denom
    ? `${result.contract_level}${result.contract_denom}${result.contract_x || ''}`
    : null;
  const lead = result?.lead_suit && result?.lead_rank
    ? `${result.lead_suit}${String(result.lead_rank).replace('10', 'T')}`
    : null;

  return {
    problem_id: `playset-${b.id}`,
    _boardId: b.id,
    _analysisId: analysisId,
    _setName: setName,
    board_number: b.board_number,
    dealer: b.dealer,
    vulnerability: b.vulnerability,
    hands_structured,
    problem_visible_hands: ['N', 'S', 'E', 'W'], // overridden to [dir] when user picks direction
    contract,
    lead,
    lin,
    declarer: result?.declarer || null,
    bidding: buildBiddingObj(b, result),
    is_play_set: true,
  };
}
