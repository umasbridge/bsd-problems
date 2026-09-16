// Editor module for bridge problems.
//
// Single entry point: openEditor(problem | null, opts).
//   - problem === null → "Key in a problem" mode (first save = INSERT).
//   - problem === existing row → edit mode (save = UPDATE).
//
// Three tabs, each with its own Save button:
//   1. Problem — dealer, vulnerability, visible hands, hands, bidding, contract, lead, problem_text.
//   2. Solution — WYSIWYG editor: prose + inline diagram widgets. Insert/edit/delete diagrams.
//   3. Source / Tags / Level — book_title, author, chapter, problem_number, format, subcategory, tags, level.
//
// Diagrams in the solution editor are atomic contenteditable=false widgets.
// Click to open a small modal with 16 card inputs + 4 visibility toggles.
// Each widget is tied to the solution string by an invisible marker
//   `​[diag-<id>]​`
// which the viewer's renderer strips at render time.

import {
  insertProblem,
  updateProblem,
  resetToOriginal,
  readProblem,
  listTagsForCategory,
  addTagToRegistry,
} from './db.js';

// ─── Constants ───────────────────────────────────────────────────────────

const SUIT_ORDER = ['S', 'H', 'D', 'C'];
const SUIT_SYM   = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR = { S: 'black', H: '#c0241c', D: '#c0241c', C: 'black' };
const SEATS      = ['N', 'E', 'S', 'W'];
const SEAT_LABEL = { N: 'North', E: 'East', S: 'South', W: 'West' };

const MARKER_RE = /​\[diag-([a-z0-9]+)\]​/g;

function makeMarker(id) { return `​[diag-${id}]​`; }
function makeId() { return Math.random().toString(36).slice(2, 10); }

// ─── Empty / default values ──────────────────────────────────────────────

function emptyHand() { return { S: '', H: '', D: '', C: '' }; }
function emptyHands() { return { N: emptyHand(), E: emptyHand(), S: emptyHand(), W: emptyHand() }; }

function isEmptyHand(h) {
  if (!h) return true;
  return !h.S && !h.H && !h.D && !h.C;
}
function isEmptyHands(hands) {
  if (!hands) return true;
  return SEATS.every(s => isEmptyHand(hands[s]));
}

function defaultEmptyProblem() {
  return {
    book_title: 'Untitled',
    author: '',
    chapter: '',
    problem_number: '',
    subcategory: '',
    format: '',
    dealer: 'N',
    vulnerability: 'None',
    hands_structured: emptyHands(),
    problem_visible_hands: ['N', 'S'],
    bidding: { dealer: 'N', calls: [] },
    contract: '',
    lead: '',
    problem_text: '',
    solution: '',
    embedded_diagrams: [],
    tags: [],
    level: null,
  };
}

function withLinDeal(problem) {
  if (!problem?.lin || !globalThis.bpLin?.dealFromLin) return problem;
  const deal = globalThis.bpLin.dealFromLin(problem.lin);
  if (!deal) return problem;
  // Exclude contract/lead from the LIN-derived spread: for bidding problems
  // the auction is incomplete so dealFromLin returns '' for both. Use the
  // DB values (already on `problem`) instead, same as viewer.html does.
  const { contract: _c, lead: _l, ...rest } = deal;
  const merged = { ...problem, ...rest };
  if (!merged.contract && deal.contract) merged.contract = deal.contract;
  if (!merged.lead && deal.lead) merged.lead = deal.lead;
  return merged;
}

// ─── Module state ────────────────────────────────────────────────────────

let _modalEl       = null;   // root DOM
let _editor        = null;   // current problem (mutated as user types? no — read on save)
let _isNew         = false;
let _onSaveCb      = null;
let _onCloseCb     = null;
let _onPlayItOutCb = null;
let _activeTab     = 'problem';

// ─── DOM helpers ─────────────────────────────────────────────────────────

function makeDraggable(handle, panel) {
  let tx = 0, ty = 0;
  handle.style.cursor = 'grab';
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, a')) return;
    const startX = e.clientX - tx;
    const startY = e.clientY - ty;
    handle.style.cursor = 'grabbing';
    const onMove = mv => {
      tx = mv.clientX - startX;
      ty = mv.clientY - startY;
      panel.style.transform = `translate(${tx}px, ${ty}px)`;
    };
    const onUp = () => {
      handle.style.cursor = 'grab';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v === false || v == null) {/* skip */}
    else node.setAttribute(k, v);
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c == null || c === false) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ─── Styles (injected once) ──────────────────────────────────────────────

let _stylesInjected = false;
function ensureStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const css = `
    .editor-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.45);
      display: flex; align-items: flex-start; justify-content: center;
      padding: 24px 16px; overflow-y: auto; z-index: 9999;
    }
    .editor-modal {
      background: #fff; border-radius: 8px; width: 100%; max-width: 880px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.25);
      display: flex; flex-direction: column; max-height: calc(100vh - 48px);
    }
    .editor-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 20px; border-bottom: 1px solid #e5e7eb; user-select: none;
    }
    .editor-header h2 { margin: 0; font-size: 1.0625rem; font-weight: 700; }
    .editor-tabs {
      display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid #e5e7eb;
      background: #f9fafb;
    }
    .editor-tab {
      background: none; border: none; padding: 10px 14px;
      font: inherit; font-size: 0.9375rem; cursor: pointer; color: #6b7280;
      border-bottom: 2px solid transparent;
    }
    .editor-tab.active { color: #1f2937; border-bottom-color: #2563eb; font-weight: 600; }
    .editor-body {
      padding: 18px 20px; overflow-y: auto; flex: 1 1 auto;
    }
    .editor-footer {
      display: flex; gap: 8px; justify-content: flex-end;
      padding: 12px 20px; border-top: 1px solid #e5e7eb;
    }
    .editor-status {
      flex: 1 1 auto; align-self: center; font-size: 0.875rem; color: #6b7280;
    }
    .editor-status.error   { color: #dc2626; }
    .editor-status.success { color: #059669; }

    .editor-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .editor-field { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
    .editor-field label { font-size: 0.8125rem; color: #6b7280; }
    .editor-field input, .editor-field select, .editor-field textarea {
      font: inherit; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px;
    }
    .editor-field textarea { min-height: 80px; resize: vertical; }
    .editor-field-wide { flex: 1 1 100%; }

    .editor-section-title {
      font-size: 0.8125rem; font-weight: 600; color: #4b5563;
      margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0.04em;
    }

    .editor-checks { display: flex; gap: 12px; }
    .editor-checks label { display: flex; align-items: center; gap: 4px; font-size: 0.875rem; }

    .editor-hands-grid {
      display: grid; grid-template-columns: 60px repeat(4, 1fr); gap: 6px 8px;
      align-items: center;
    }
    .editor-hands-grid .seat-label { font-weight: 600; font-size: 0.875rem; text-align: right; padding-right: 4px; }
    .editor-hands-grid .suit-cell { display: flex; align-items: center; gap: 4px; }
    .editor-hands-grid .suit-sym { width: 14px; text-align: center; font-weight: 700; }
    .editor-hands-grid input { padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 3px; flex: 1; font: inherit; }

    .play-tricks { margin-bottom: 12px; }
    .play-tricks-rows { display: flex; flex-direction: column; gap: 8px; }
    .play-trick { display: flex; align-items: center; gap: 10px; }
    .play-trick-label { font-size: 0.8125rem; color: #6b7280; min-width: 150px; }
    .play-trick-cells { display: flex; gap: 6px; }
    .play-cell { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .play-cell .play-seat { font-size: 0.6875rem; color: #9ca3af; height: 12px; line-height: 12px; }
    .play-cell input.play-card { width: 54px; padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 3px; font: inherit; text-align: center; }
    .play-trick-remove { border: none; background: none; color: #9ca3af; cursor: pointer; font-size: 1.1rem; line-height: 1; padding: 0 4px; }
    .play-trick-remove:hover { color: #dc2626; }
    .play-add-trick { margin-top: 8px; border: 1px dashed #cbd5e1; background: #f8fafc; color: #334155; border-radius: 4px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 0.8125rem; }
    .play-add-trick:hover { background: #f1f5f9; }

    .solution-editor {
      min-height: 240px; max-height: 50vh; overflow-y: auto;
      border: 1px solid #d1d5db; border-radius: 4px; padding: 10px;
      background: #fff; font: inherit; line-height: 1.55;
    }
    .solution-editor:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
    .solution-editor .diagram-widget {
      display: inline-block; margin: 8px 4px; padding: 6px 8px;
      border: 1px solid #2563eb; border-radius: 4px; background: #eff6ff;
      cursor: pointer; user-select: none; vertical-align: middle;
      position: relative; font-size: 0.75rem; line-height: 1.3;
    }
    .solution-editor .diagram-widget:hover { background: #dbeafe; }
    .solution-editor .diagram-widget.empty { background: #fef3c7; border-color: #f59e0b; }
    .solution-editor .diagram-widget .dw-label { font-weight: 600; color: #1d4ed8; margin-bottom: 2px; }
    .solution-editor .diagram-widget.empty .dw-label { color: #92400e; }
    .solution-editor .diagram-widget .dw-hand-row { white-space: nowrap; }
    .solution-editor .diagram-widget .dw-suit { display: inline-block; min-width: 12px; }
    .solution-editor .diagram-widget .dw-empty-msg { font-style: italic; color: #6b7280; }

    .solution-editor-toolbar { margin-bottom: 6px; display: flex; gap: 8px; }
    .solution-editor-help { font-size: 0.8125rem; color: #6b7280; margin-bottom: 6px; }

    /* Edit-deal sub-modal */
    .deal-modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
      padding: 16px; z-index: 10001;
    }
    .deal-modal {
      background: #fff; border-radius: 8px; width: 100%; max-width: 560px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.25);
    }
    .deal-modal-header { padding: 12px 16px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; user-select: none; }
    .deal-modal-header h3 { margin: 0; font-size: 1rem; }
    .deal-modal-body { padding: 16px; }
    .deal-modal-footer { padding: 10px 16px; border-top: 1px solid #e5e7eb; display: flex; justify-content: flex-end; gap: 8px; }
    .suit-input-wrap { display: grid; }
    .suit-input-wrap > * { grid-column: 1; grid-row: 1; }
    .suit-input-overlay {
      pointer-events: none; z-index: 1; font: inherit; box-sizing: border-box;
      display: flex; align-items: center; white-space: pre;
      padding: 6px 8px; border: 1px solid transparent; border-radius: 4px;
      background: white;
    }
    .play-cell .suit-input-overlay { padding: 4px 6px; border-radius: 3px; justify-content: center; }
  `;
  document.head.appendChild(el('style', {}, [css]));
}

// ─── Public entry point ──────────────────────────────────────────────────

export async function openEditor(problem, opts = {}) {
  ensureStyles();
  // A problem without an id is a prefilled draft — opens in "key in a new
  // problem" mode (first save = INSERT) with the draft's fields filled in.
  _editor   = problem ? { ...defaultEmptyProblem(), ...structuredClone(withLinDeal(problem)) } : defaultEmptyProblem();
  _isNew    = !problem || !problem.id;
  _onSaveCb = opts.onSave  || null;
  _onCloseCb = opts.onClose || null;
  _onPlayItOutCb = opts.onPlayItOut || null;

  // Normalise fields that come from the DB in a different format than what the
  // editor widgets expect.

  // Vulnerability: extraction pipeline stores long-form strings; editor uses short codes.
  const VUL_NORM = { 'Both Vul': 'Both', 'N/S Vul': 'NS', 'E/W Vul': 'EW', 'None Vul': 'None' };
  if (_editor.vulnerability && VUL_NORM[_editor.vulnerability]) {
    _editor.vulnerability = VUL_NORM[_editor.vulnerability];
  }

  // Bidding: extraction pipeline stores {columns:[...], rows:[[...],...]}; editor
  // uses {dealer: 'S', calls: ['1♠','Pass',...]} internally.
  const bid = _editor.bidding;
  if (bid && Array.isArray(bid.columns) && Array.isArray(bid.rows)) {
    const SEAT_LETTER = { South: 'S', North: 'N', East: 'E', West: 'W' };
    const dealer = SEAT_LETTER[bid.columns[0]] || _editor.dealer || 'N';
    // Flatten rows and drop padding cells ('—', '', null/undefined).
    const calls = bid.rows.flat().filter(c => c && c !== '—');
    _editor.bidding = { dealer, calls };
  }

  if (_modalEl) _modalEl.remove();
  _modalEl = buildShell();
  document.body.appendChild(_modalEl);
  showTab('problem');
}

export function closeEditor(opts = {}) {
  if (_modalEl?.parentNode) _modalEl.parentNode.removeChild(_modalEl);
  _modalEl = null;
  if (_onCloseCb) _onCloseCb({ saved: !!opts.saved, problem: _editor });
  _editor = null;
  _isNew  = false;
}

// ─── Modal shell ─────────────────────────────────────────────────────────

function buildShell() {
  const headerTitle = _isNew
    ? 'Key in a new problem'
    : `Edit problem — ${_editor.book_title || 'Untitled'} ${_editor.problem_number || ''}`.trim();

  const tabsEl = el('div', { className: 'editor-tabs' }, [
    tabBtn('problem',  'Problem'),
    tabBtn('solution', 'Solution'),
    tabBtn('source',   'Source / Tags / Level'),
  ]);

  const bodyEl = el('div', { className: 'editor-body' });
  const statusEl = el('div', { className: 'editor-status' });

  const cancelBtn = el('button', {
    className: 'btn',
    onClick: () => closeEditor({ saved: false }),
  }, ['Cancel']);

  const saveBtn = el('button', {
    className: 'btn btn-primary',
    onClick: () => onSaveActiveTab(),
  }, ['Save tab']);

  // "Play it out" opens the position modal prefilled with the hands currently
  // being keyed in. Only shown when the opener supplied an onPlayItOut handler.
  const footerBtns = [statusEl, cancelBtn];
  if (_onPlayItOutCb) {
    footerBtns.push(el('button', {
      className: 'btn',
      onClick: () => _onPlayItOutCb && _onPlayItOutCb(collectAllTabState()),
    }, ['Play it out']));
  }
  footerBtns.push(saveBtn);

  const footerEl = el('div', { className: 'editor-footer' }, footerBtns);

  const modal = el('div', { className: 'editor-modal' }, [
    el('div', { className: 'editor-header' }, [
      el('h2', {}, [headerTitle]),
      el('button', {
        className: 'btn',
        title: 'Close',
        onClick: () => closeEditor({ saved: false }),
      }, ['×']),
    ]),
    tabsEl,
    bodyEl,
    footerEl,
  ]);

  makeDraggable(modal.querySelector('.editor-header'), modal);

  const overlay = el('div', { className: 'editor-overlay' }, [modal]);
  overlay.dataset.role = 'editor-overlay';
  overlay._refs = { bodyEl, statusEl, saveBtn, tabsEl, cancelBtn };
  return overlay;
}

function tabBtn(id, label) {
  return el('button', {
    className: 'editor-tab',
    'data-tab': id,
    onClick: () => showTab(id),
  }, [label]);
}

function showTab(id) {
  _activeTab = id;
  const refs = _modalEl._refs;
  refs.tabsEl.querySelectorAll('.editor-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === id);
  });
  setStatus('', '');
  clearChildren(refs.bodyEl);
  if (id === 'problem')  refs.bodyEl.appendChild(buildProblemTab());
  if (id === 'solution') refs.bodyEl.appendChild(buildSolutionTab());
  if (id === 'source')   refs.bodyEl.appendChild(buildSourceTab());
}

function setStatus(text, kind = '') {
  const s = _modalEl._refs.statusEl;
  s.textContent = text;
  s.className = 'editor-status' + (kind ? ' ' + kind : '');
}

// ─── Problem tab ─────────────────────────────────────────────────────────

function buildProblemTab() {
  const wrap = el('div');

  // Normalize the stored dealer to a single-letter seat: some rows persist it
  // as a full word ("South"), which wouldn't match the letter options and would
  // silently fall back to 'N' — throwing off the live leader labels below.
  const dealerSel = selectField('Dealer', SEATS, globalThis.bpLin.parseDealerLetter(_editor.dealer));
  const vulnSel   = selectField('Vulnerability', ['None', 'NS', 'EW', 'Both'], _editor.vulnerability || 'None');
  const formatSel = textField('Format (e.g., IMP, MP)', _editor.format || '');

  // Visible hands
  const visBoxes = SEATS.map(s => {
    const checked = (_editor.problem_visible_hands || []).includes(s);
    const cb = el('input', { type: 'checkbox', 'data-vis': s });
    if (checked) cb.checked = true;
    return el('label', {}, [cb, ' ' + SEAT_LABEL[s]]);
  });
  const visField = el('div', { className: 'editor-field editor-field-wide' }, [
    el('label', {}, ['Hands visible to solver']),
    el('div', { className: 'editor-checks', 'data-role': 'visible-hands' }, visBoxes),
  ]);

  // Hands grid
  const handsGrid = el('div', { className: 'editor-hands-grid', 'data-role': 'hands-grid' });
  // Header row
  handsGrid.appendChild(el('div'));
  for (const s of SUIT_ORDER) {
    handsGrid.appendChild(el('div', { className: 'suit-cell' }, [
      el('span', { className: 'suit-sym', style: { color: SUIT_COLOR[s] } }, [SUIT_SYM[s]]),
    ]));
  }
  // Seat rows
  for (const seat of ['N', 'E', 'S', 'W']) {
    handsGrid.appendChild(el('div', { className: 'seat-label' }, [SEAT_LABEL[seat]]));
    const hand = (_editor.hands_structured && _editor.hands_structured[seat]) || emptyHand();
    for (const suit of SUIT_ORDER) {
      const inp = el('input', {
        type: 'text',
        'data-seat': seat,
        'data-suit': suit,
        value: hand[suit] || '',
        placeholder: '—',
      });
      inp.addEventListener('input', () => {
        const pos = inp.selectionStart;
        inp.value = inp.value.toUpperCase();
        inp.setSelectionRange(pos, pos);
      });
      handsGrid.appendChild(el('div', { className: 'suit-cell' }, [inp]));
    }
  }

  // Bidding
  const biddingDealerSel = selectField(
    'Bidding starts with',
    SEATS,
    globalThis.bpLin.parseDealerLetter((_editor.bidding && _editor.bidding.dealer) || _editor.dealer)
  );
  biddingDealerSel.dataset.role = 'bidding-dealer';
  const callsField = textField(
    'Calls (space-separated, e.g., "1S P 2H P 4H AP")',
    Array.isArray(_editor.bidding?.calls) ? _editor.bidding.calls.join(' ') : ''
  );
  callsField.querySelector('input').dataset.role = 'bidding-calls';

  const biddingNotesField = textField(
    'Bidding notes (e.g., "(1) 15-17, (2) Transfer")',
    _editor.bidding?.notes
      ? Object.entries(_editor.bidding.notes).sort(([a],[b]) => a - b).map(([k,v]) => `(${k}) ${v}`).join(', ')
      : ''
  );
  biddingNotesField.querySelector('input').dataset.role = 'bidding-notes';

  const contractField = textField('Contract', _editor.contract || '');
  const contractInp = contractField.querySelector('input');
  contractInp.dataset.role = 'contract';
  addSuitColorPreview(contractField, contractInp);
  const leadField = textField('Lead', _editor.lead || '');
  const leadInp = leadField.querySelector('input');
  leadInp.dataset.role = 'lead';
  addSuitColorPreview(leadField, leadInp);

  // Cards played to the decision point (populates the `play` array).
  const playTricks = buildPlayTricks();

  // Problem text
  const problemTextField = textareaField('Problem text', _editor.problem_text || '');
  problemTextField.querySelector('textarea').dataset.role = 'problem-text';

  wrap.appendChild(el('div', { className: 'editor-row' }, [dealerSel, vulnSel, formatSel]));
  wrap.appendChild(el('div', { className: 'editor-row' }, [visField]));
  const handsStatus = el('div', { 'data-role': 'hands-status', style: 'font-size:0.8rem;margin-top:4px;min-height:1.2em' });
  function refreshHandsStatus() {
    const h = emptyHands();
    handsGrid.querySelectorAll('input[data-seat]').forEach(i => {
      h[i.dataset.seat][i.dataset.suit] = i.value.trim().toUpperCase();
    });
    const err = validateHandsForSave(h);
    if (err) {
      handsStatus.textContent = '⚠️ ' + err;
      handsStatus.style.color = '#c00';
    } else {
      const filled = SEATS.filter(s => SUIT_ORDER.some(su => h[s][su])).length;
      if (filled === 4) {
        handsStatus.textContent = '✓ Deal checks out';
        handsStatus.style.color = '#15803d';
      } else {
        handsStatus.textContent = '';
      }
    }
  }

  wrap.appendChild(el('div', { className: 'editor-section-title' }, ['Hands']));
  wrap.appendChild(handsGrid);
  wrap.appendChild(handsStatus);
  wrap.appendChild(el('div', { className: 'editor-section-title' }, ['Bidding']));
  wrap.appendChild(el('div', { className: 'editor-row' }, [biddingDealerSel, callsField]));
  wrap.appendChild(el('div', { className: 'editor-row' }, [biddingNotesField]));
  wrap.appendChild(el('div', { className: 'editor-row' }, [contractField, leadField]));
  wrap.appendChild(el('div', { className: 'editor-section-title' }, ['Cards played (to the decision point)']));
  wrap.appendChild(playTricks);
  wrap.appendChild(el('div', { className: 'editor-section-title' }, ['Problem text']));
  wrap.appendChild(problemTextField);

  // Leader/seat labels depend on dealer, auction, contract, lead and hands, so
  // refresh them whenever anything on the Problem tab changes (cheap + guarded).
  const refresh = () => { updatePlayLabels(playTricks); refreshHandsStatus(); };
  wrap.addEventListener('input', refresh);
  wrap.addEventListener('change', refresh);
  setTimeout(refresh, 0);   // initial pass once the tab is mounted in the DOM

  return wrap;
}

function readProblemTab() {
  const body = _modalEl._refs.bodyEl;
  const dealer       = body.querySelector('select[data-field="Dealer"]')?.value || 'N';
  const vulnerability = body.querySelector('select[data-field="Vulnerability"]')?.value || 'None';
  const format       = body.querySelector('input[data-field="Format (e.g., IMP, MP)"]')?.value.trim() || '';

  const visible = Array.from(body.querySelectorAll('input[data-vis]:checked')).map(cb => cb.dataset.vis);

  const hands = emptyHands();
  body.querySelectorAll('.editor-hands-grid input[data-seat]').forEach(inp => {
    hands[inp.dataset.seat][inp.dataset.suit] = inp.value.trim().toUpperCase();
  });

  const biddingDealer = body.querySelector('[data-role="bidding-dealer"] select')?.value || dealer;
  const callsRaw = (body.querySelector('input[data-role="bidding-calls"]')?.value || '')
    .replace(/\ball\s*pass(?:es)?\b/gi, 'P P P')  // "All pass" / "All passes" → 3 passes
    .replace(/\bap\b/gi, 'P P P');                 // "AP" shorthand
  const calls = callsRaw.split(/\s+/).filter(Boolean);
  const notesRaw = body.querySelector('input[data-role="bidding-notes"]')?.value || '';
  const notes = {};
  for (const m of notesRaw.matchAll(/\((\d+)\)\s*([^,(]+(?:\([^)]*\))?[^,]*)/g)) {
    notes[m[1]] = m[2].trim();
  }
  const bidding = { dealer: biddingDealer, calls };
  if (Object.keys(notes).length) bidding.notes = notes;

  return {
    dealer,
    vulnerability,
    format,
    problem_visible_hands: visible,
    hands_structured: hands,
    bidding,
    contract: body.querySelector('input[data-role="contract"]')?.value.trim() || '',
    lead:     body.querySelector('input[data-role="lead"]')?.value.trim()     || '',
    problem_text: body.querySelector('textarea[data-role="problem-text"]')?.value || '',
    play:     readPlayTricks(body),
  };
}

// ─── Cards-played (play array) capture ────────────────────────────────────
// The `play` column is a flat, play-order list of cards from trick 1 to the
// decision point. lin.js/simulatePlay validate it and encode it as pc| tokens;
// play.js auto-steps through it. Here we just capture it as "Trick N" rows of
// four play-order boxes, with leader/seat labels derived live.

// Read the contiguous prefix of entered cards (stop at the first empty box),
// normalized to suit+rank tokens (e.g. "D3", "HT"). Returns null if empty.
function readPlayTricks(body) {
  const rowsEl = body.querySelector('[data-role="play-tricks"] .play-tricks-rows');
  if (!rowsEl) return null;
  const cards = [];
  for (const row of rowsEl.querySelectorAll('.play-trick')) {
    for (const inp of row.querySelectorAll('input.play-card')) {
      const v = inp.value.trim();
      if (!v) { return cards.length ? cards : null; }
      // Store in suit-symbol form ("♥A", "♦10") — the only form parseLeadCard /
      // simulatePlay accept, matching the existing `lead` field and play arrays.
      const pc = globalThis.bpLin.parseLeadCard(v);
      cards.push(pc ? SUIT_SYM[pc.suit] + (pc.rank === 'T' ? '10' : pc.rank) : v);
    }
  }
  return cards.length ? cards : null;
}

function cardToDisplay(tok) {
  const pc = globalThis.bpLin.parseLeadCard(tok);
  if (!pc) return tok;
  return SUIT_SYM[pc.suit] + (pc.rank === 'T' ? '10' : pc.rank);
}

function renderTrickRow(cards) {
  const cells = [0, 1, 2, 3].map(s => {
    const cardVal = (cards && cards[s]) || '';
    const inp = el('input', {
      type: 'text', className: 'play-card', placeholder: '—',
      autocomplete: 'off', spellcheck: 'false',
      value: cardVal,
    });
    const cellEl = el('div', { className: 'play-cell' }, [
      el('span', { className: 'play-seat' }, ['']),
      inp,
    ]);
    wrapWithSuitOverlay(inp);
    return cellEl;
  });
  const removeBtn = el('button', {
    type: 'button', className: 'play-trick-remove', title: 'Remove this trick',
    onClick: (e) => {
      const rowsEl = e.currentTarget.closest('.play-tricks-rows');
      e.currentTarget.closest('.play-trick').remove();
      if (!rowsEl.querySelector('.play-trick')) rowsEl.appendChild(renderTrickRow());
      updatePlayLabels(rowsEl.closest('[data-role="play-tricks"]'));
    },
  }, ['×']);
  return el('div', { className: 'play-trick' }, [
    el('span', { className: 'play-trick-label' }, ['Trick']),
    el('div', { className: 'play-trick-cells' }, cells),
    removeBtn,
  ]);
}

function buildPlayTricks() {
  const container = el('div', { className: 'play-tricks', 'data-role': 'play-tricks' });
  const rowsEl = el('div', { className: 'play-tricks-rows' });
  const play = Array.isArray(_editor.play) ? _editor.play : [];
  const chunks = [];
  for (let i = 0; i < play.length; i += 4) chunks.push(play.slice(i, i + 4).map(cardToDisplay));
  if (!chunks.length) chunks.push([]);
  for (const c of chunks) rowsEl.appendChild(renderTrickRow(c));
  const addBtn = el('button', {
    type: 'button', className: 'play-add-trick',
    onClick: () => { rowsEl.appendChild(renderTrickRow()); updatePlayLabels(container); },
  }, ['+ Add trick']);
  container.appendChild(rowsEl);
  container.appendChild(addBtn);
  return container;
}

// ── Live leader/seat labels (advisory; never throw) ──
function seatAt(seat, offset) {
  const S = globalThis.bpLin.LIN_SEATS;
  return S[(S.indexOf(seat) + offset) % 4];
}

function currentTrump() {
  const body = _modalEl?._refs.bodyEl;
  const c = body?.querySelector('input[data-role="contract"]')?.value.trim() || '';
  const pc = globalThis.bpLin.parseContractStr(c);
  return (!pc || pc.denom === 'N') ? null : pc.denom;
}

// Best-effort declarer: prefer the auction, else infer from the opening lead
// (its holder is the opening leader, and declarer is that seat's RHO). May be
// null when neither is available yet — labels simply stay unseated then.
function currentDeclarer() {
  const L = globalThis.bpLin;
  const body = _modalEl?._refs.bodyEl;
  if (!body) return null;
  const dealer = body.querySelector('[data-role="bidding-dealer"] select')?.value
              || body.querySelector('select[data-field="Dealer"]')?.value || 'N';
  const calls = (body.querySelector('input[data-role="bidding-calls"]')?.value || '').split(/\s+/).filter(Boolean);
  let d = null;
  try { d = L.declarerFromCalls(calls, dealer); } catch (_) {}
  if (!d) {
    const leadVal = body.querySelector('input[data-role="lead"]')?.value.trim()
                 || body.querySelector('[data-role="play-tricks"] input.play-card')?.value.trim();
    const lc = leadVal ? L.parseLeadCard(leadVal) : null;
    if (lc) {
      const hands = emptyHands();
      body.querySelectorAll('.editor-hands-grid input[data-seat]').forEach(inp => {
        hands[inp.dataset.seat][inp.dataset.suit] = inp.value.trim();
      });
      const holder = L.seatHoldingLead(hands, lc);
      if (holder) d = L.nominalDeclarer(holder);
    }
  }
  return d;
}

function trickWinnerSeat(cards, leader, trump) {
  const RANK = globalThis.bpLin.RANK_ORDER;
  const ri = r => RANK.indexOf(r === 'T' ? '10' : r);
  const led = cards[0].suit;
  let best = 0;
  for (let i = 1; i < cards.length; i++) {
    const c = cards[i], b = cards[best];
    const cT = trump && c.suit === trump, bT = trump && b.suit === trump;
    if (cT && !bT) best = i;
    else if (cT && bT && ri(c.rank) > ri(b.rank)) best = i;
    else if (!cT && !bT && c.suit === led && (b.suit !== led || ri(c.rank) > ri(b.rank))) best = i;
  }
  return seatAt(leader, best);
}

function updatePlayLabels(container) {
  if (!container) return;
  try {
    const L = globalThis.bpLin;
    const rowsEl = container.querySelector('.play-tricks-rows');
    const rows = [...rowsEl.querySelectorAll('.play-trick')];
    const parsed = readPlayTricks(_modalEl._refs.bodyEl);
    const cards = (parsed || []).map(t => L.parseLeadCard(t)).filter(Boolean);
    const declarer = currentDeclarer();
    const trump = currentTrump();
    let leaders = null;
    if (declarer) {
      leaders = [seatAt(declarer, 1)];   // opening leader = declarer's LHO
      for (let t = 0; t * 4 + 4 <= cards.length; t++) {
        leaders[t + 1] = trickWinnerSeat(cards.slice(t * 4, t * 4 + 4), leaders[t], trump);
      }
    }
    rows.forEach((row, t) => {
      const labelEl = row.querySelector('.play-trick-label');
      const seatSpans = [...row.querySelectorAll('.play-seat')];
      const leader = leaders ? leaders[t] : null;
      if (leader) {
        labelEl.textContent = `Trick ${t + 1} — ${SEAT_LABEL[leader]} leads`;
        seatSpans.forEach((sp, s) => { sp.textContent = seatAt(leader, s); });
      } else {
        labelEl.textContent = `Trick ${t + 1}`;
        seatSpans.forEach(sp => { sp.textContent = ''; });
      }
    });
  } catch (_) { /* labels are advisory */ }
}

// On save: reconcile the opening lead with Trick 1, and require the played
// sequence to be legal (every card encoded as a pc| token in the canonical
// LIN). Throws with a user-facing message to abort the save.
function validatePlayForSave(obj, canonLin) {
  if (!Array.isArray(obj.play) || !obj.play.length) return;
  const L = globalThis.bpLin;
  const first = L.parseLeadCard(obj.play[0]);
  if (!first) throw new Error('Trick 1: the first card is not a valid card.');
  const firstTok = first.suit + first.rank;
  const leadParsed = obj.lead ? L.parseLeadCard(obj.lead) : null;
  if (leadParsed) {
    if (leadParsed.suit + leadParsed.rank !== firstTok) {
      throw new Error('Opening lead must match the first card of Trick 1.');
    }
  } else {
    obj.lead = firstTok;   // no separate lead entered → derive it from Trick 1
  }
  if (!obj.contract) throw new Error('Enter the contract before adding played cards.');
  const pcCount = (canonLin.match(/pc\|/g) || []).length;
  if (pcCount < obj.play.length) {
    // Try to name the expected leader so the user knows what went wrong.
    const L2 = globalThis.bpLin;
    const mbCalls = [...canonLin.matchAll(/mb\|([^|]+)\|/g)].map(x => x[1]);
    const dealerM = canonLin.match(/md\|(\d)/);
    const dealerSeat = dealerM ? ({ 1:'S',2:'W',3:'N',4:'E' }[dealerM[1]] || 'N') : 'N';
    const linDeclarer = L2.declarerFromCalls(mbCalls, dealerSeat);
    const linLeader = linDeclarer ? SEAT_LABEL[seatAt(linDeclarer, 1)] : null;
    const hint = linLeader
      ? ` The bidding implies ${linLeader} is on lead — re-enter the play cards in that order.`
      : ' If you changed the bidding, the leading seat may have changed — re-enter the play cards.';
    throw new Error('Cards played are not a legal sequence.' + hint);
  }
}

// ─── Source / Tags / Level tab ───────────────────────────────────────────

function buildSourceTab() {
  const wrap = el('div', { 'data-tab-content': 'source' });

  const f = (label, role, value, type = 'text') => {
    const node = type === 'textarea' ? textareaField(label, value) : textField(label, value, type);
    const inp = node.querySelector('input,textarea');
    inp.dataset.role = role;
    return node;
  };

  wrap.appendChild(el('div', { className: 'editor-row' }, [
    f('Book title', 'book_title', _editor.book_title || ''),
    f('Author',     'author',     _editor.author     || ''),
  ]));
  wrap.appendChild(el('div', { className: 'editor-row' }, [
    f('Chapter',        'chapter',        _editor.chapter        || ''),
    f('Problem number', 'problem_number', _editor.problem_number || ''),
  ]));
  const SUBCATEGORIES = ['','Bidding','Declarer Play','Defend or Play','Defense','Double Dummy','Suit Combinations'];
  const subcategoryNode = selectField('Subcategory', SUBCATEGORIES, _editor.subcategory || '');
  subcategoryNode.querySelector('select').dataset.role = 'subcategory';
  wrap.appendChild(el('div', { className: 'editor-row' }, [
    f('Format (IMP, MP)', 'format', _editor.format || ''),
    subcategoryNode,
  ]));

  // Tags picker: multi-select dropdown scoped to the current category, with
  // a "+ New tag" entry that prompts for a name and registers it. Initially
  // populates from listTagsForCategory + the problem's existing tags.
  const tagsField = el('div', { className: 'editor-field editor-field-wide' }, [
    el('label', {}, ['Tags']),
    el('div', { 'data-role': 'tags-host', className: 'multi-filter-host' }),
  ]);
  const tagsPicker = createTagsPicker({
    host: tagsField.querySelector('[data-role="tags-host"]'),
    initialSelected: Array.isArray(_editor.tags) ? _editor.tags.slice() : [],
    initialCategory: _editor.subcategory || '',
  });
  // Refresh tag pool when subcategory changes.
  const subInput = subcategoryNode.querySelector('select');
  if (subInput) {
    subInput.addEventListener('change', () => tagsPicker.setCategory(subInput.value.trim()));
  }

  wrap.appendChild(el('div', { className: 'editor-row' }, [
    tagsField,
    f('Level (1–10, blank = unset)', 'level',
      _editor.level == null ? '' : String(_editor.level), 'number'),
  ]));

  // Stash a reader on the wrap so readSourceTab can pull current selection.
  wrap._tagsPicker = tagsPicker;

  return wrap;
}

// ─── Tags picker (editor-only multi-select with "+ New tag") ─────────────

function createTagsPicker({ host, initialSelected, initialCategory }) {
  const state = {
    category: initialCategory || '',
    options: [],                                  // string[]
    selected: new Set(initialSelected || []),
    pendingNewTags: [],                           // tags to register on save
  };

  host.innerHTML = '';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'multi-filter-button';
  const summary = document.createElement('span');
  summary.className = 'mf-summary';
  const caret = document.createElement('span');
  caret.className = 'mf-caret';
  caret.textContent = '▾';
  button.appendChild(summary);
  button.appendChild(caret);

  const panel = document.createElement('div');
  panel.className = 'multi-filter-panel hidden';
  panel.addEventListener('click', e => e.stopPropagation());

  button.addEventListener('click', e => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
  });
  document.addEventListener('click', () => panel.classList.add('hidden'));

  host.appendChild(button);
  host.appendChild(panel);

  function updateSummary() {
    const n = state.selected.size;
    if (n === 0) { summary.textContent = 'Select tags…'; return; }
    if (n <= 2) { summary.textContent = [...state.selected].join(', '); return; }
    summary.textContent = `${n} selected`;
  }

  function renderPanel() {
    panel.innerHTML = '';
    // Show every option in the pool plus any selected tags that aren't in
    // the pool (e.g. cross-category leftovers) — those still render checked
    // so the user can deliberately uncheck them.
    const all = new Set([...state.options, ...state.selected]);
    const sorted = [...all].sort((a, b) => a.localeCompare(b));
    for (const tag of sorted) {
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.value = tag;
      if (state.selected.has(tag)) cb.checked = true;
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(tag);
        else state.selected.delete(tag);
        updateSummary();
      });
      const labelSpan = document.createElement('span');
      labelSpan.className = 'mf-label';
      labelSpan.textContent = tag;
      lbl.appendChild(cb);
      lbl.appendChild(labelSpan);
      panel.appendChild(lbl);
    }
    // "+ New tag" entry at the bottom.
    const newRow = document.createElement('label');
    newRow.style.borderTop = '1px solid var(--border)';
    newRow.style.marginTop = '4px';
    newRow.style.paddingTop = '8px';
    newRow.style.cursor = 'pointer';
    const newSpan = document.createElement('span');
    newSpan.className = 'mf-label';
    newSpan.style.color = 'var(--text-muted)';
    newSpan.textContent = '+ New tag';
    newRow.appendChild(newSpan);
    newRow.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cat = state.category;
      if (!cat) {
        alert('Choose a problem category first — tags are scoped per category.');
        return;
      }
      const name = (prompt(`New tag name (will be added under category "${cat}")`) || '').trim();
      if (!name) return;
      if (!state.options.includes(name)) state.options.push(name);
      state.selected.add(name);
      // Queue for registry insert on save (and persist now, fire-and-forget,
      // so the tag is durably registered even if the user cancels save).
      addTagToRegistry(name, cat).catch(err => console.warn('addTagToRegistry failed', err));
      updateSummary();
      renderPanel();
    });
    panel.appendChild(newRow);
  }

  async function loadPoolForCategory() {
    if (!state.category) {
      state.options = [];
      renderPanel();
      return;
    }
    try {
      state.options = await listTagsForCategory(state.category);
    } catch (err) {
      console.warn('listTagsForCategory failed', err);
      state.options = [];
    }
    renderPanel();
  }

  loadPoolForCategory();
  updateSummary();

  return {
    setCategory(cat) {
      const next = (cat || '').trim();
      if (next === state.category) return;
      state.category = next;
      loadPoolForCategory();
    },
    getSelected() { return [...state.selected]; },
  };
}

function readSourceTab() {
  const b = _modalEl._refs.bodyEl;
  const get = role => b.querySelector(`[data-role="${role}"]`)?.value ?? '';
  const levelRaw = get('level').trim();
  let level = null;
  if (levelRaw !== '') {
    const n = parseInt(levelRaw, 10);
    if (!isNaN(n)) level = Math.max(1, Math.min(10, n));
  }
  // The Source tab's wrapper carries the live picker on _tagsPicker.
  const sourceWrap = b.querySelector('[data-tab-content="source"]') || b;
  const tagsPicker = sourceWrap._tagsPicker
    || b.querySelector('[data-role="tags-host"]')?.closest('[data-tab-content="source"]')?._tagsPicker;
  const tags = tagsPicker ? tagsPicker.getSelected() : [];
  return {
    book_title:     get('book_title').trim() || 'Untitled',
    author:         get('author').trim()     || null,
    chapter:        get('chapter').trim()    || null,
    problem_number: get('problem_number').trim() || null,
    format:         get('format').trim()     || null,
    subcategory:    get('subcategory').trim()|| null,
    tags,
    level,
  };
}

// ─── Solution tab (WYSIWYG) ──────────────────────────────────────────────

function buildSolutionTab() {
  const wrap = el('div');

  const help = el('div', { className: 'solution-editor-help' }, [
    'Type freely. Click ',
    el('strong', {}, ['Insert deal']),
    ' to add a diagram at the cursor. Click an existing diagram to edit it; the editor has a Delete button.',
  ]);

  const insertBtn = el('button', {
    className: 'btn',
    onClick: () => onInsertDeal(),
  }, ['Insert deal']);

  const toolbar = el('div', { className: 'solution-editor-toolbar' }, [insertBtn]);

  const editor = el('div', {
    className: 'solution-editor',
    contenteditable: 'true',
    spellcheck: 'true',
    'data-role': 'solution-editor',
  });
  loadSolutionContent(editor, _editor.solution || '', _editor.embedded_diagrams || []);

  wrap.appendChild(help);
  wrap.appendChild(toolbar);
  wrap.appendChild(editor);
  return wrap;
}

function loadSolutionContent(editor, solution, embeds) {
  clearChildren(editor);

  // Build a map by anchor → embed entry. Anchors that match the marker
  // pattern get spliced as widgets; legacy prose anchors render as plain
  // text (the user can edit/delete them as text), and their diagrams are
  // appended as widgets at the original anchor position.
  const byAnchor = new Map();
  for (const em of embeds) {
    if (em && em.anchor != null) byAnchor.set(em.anchor, em);
  }

  // We iterate the solution string, finding anchors (in order of appearance).
  const sol = solution || '';
  const matches = []; // { idx, len, embed }
  for (const em of embeds) {
    if (!em || em.anchor == null) continue;
    const idx = sol.indexOf(em.anchor);
    if (idx < 0) continue;
    matches.push({ idx, len: em.anchor.length, embed: em });
  }
  matches.sort((a, b) => a.idx - b.idx);

  // Walk solution, emit text nodes between matches and widgets in place.
  let pos = 0;
  for (const m of matches) {
    if (m.idx > pos) editor.appendChild(document.createTextNode(sol.substring(pos, m.idx)));
    // If anchor is a marker, drop it (no visible text); otherwise keep the
    // anchor text in the editor — the user will see it as plain text.
    const isMarker = MARKER_RE.test(m.embed.anchor);
    MARKER_RE.lastIndex = 0;
    if (!isMarker) editor.appendChild(document.createTextNode(m.embed.anchor));
    editor.appendChild(buildWidget(m.embed.hands || emptyHands(), m.embed.visible_seats || ['N','S']));
    pos = m.idx + m.len;
  }
  if (pos < sol.length) editor.appendChild(document.createTextNode(sol.substring(pos)));

  // Trailing diagrams whose anchors weren't found in the text: append them
  // at the end so they're not lost on save.
  for (const em of embeds) {
    if (!em || em.anchor == null) continue;
    if (sol.indexOf(em.anchor) < 0) {
      editor.appendChild(document.createTextNode('\n'));
      editor.appendChild(buildWidget(em.hands || emptyHands(), em.visible_seats || ['N','S']));
    }
  }
}

function buildWidget(hands, visibleSeats) {
  const id = makeId();
  const widget = el('span', {
    className: 'diagram-widget',
    contenteditable: 'false',
    'data-diag-id': id,
    'data-hands': JSON.stringify(hands || emptyHands()),
    'data-visible': JSON.stringify(visibleSeats || []),
    onClick: ev => { ev.stopPropagation(); openDealModal(widget); },
  });
  refreshWidgetInner(widget);
  return widget;
}

function refreshWidgetInner(widget) {
  const hands = JSON.parse(widget.dataset.hands || '{}');
  const visible = JSON.parse(widget.dataset.visible || '[]');
  clearChildren(widget);
  widget.classList.toggle('empty', isEmptyHands(hands));

  if (isEmptyHands(hands)) {
    widget.appendChild(el('span', { className: 'dw-label' }, ['(empty diagram — won\'t render)']));
    widget.appendChild(el('div', { className: 'dw-empty-msg' }, ['Click to add cards, or open and click Delete deal.']));
    return;
  }

  widget.appendChild(el('div', { className: 'dw-label' }, ['Diagram']));
  for (const seat of visible.length ? visible : SEATS) {
    const h = hands[seat] || emptyHand();
    const row = el('div', { className: 'dw-hand-row' });
    row.appendChild(el('span', { style: { fontWeight: 600, marginRight: '4px' } }, [seat + ':']));
    for (const suit of SUIT_ORDER) {
      const txt = h[suit] || '—';
      row.appendChild(el('span', { className: 'dw-suit', style: { color: SUIT_COLOR[suit], marginRight: '4px' } }, [
        SUIT_SYM[suit] + (txt && txt !== '—' ? ' ' + txt : ' —'),
      ]));
    }
    widget.appendChild(row);
  }
}

function readSolutionTab() {
  const editorEl = _modalEl._refs.bodyEl.querySelector('[data-role="solution-editor"]');
  return walkSolution(editorEl);
}

function walkSolution(rootEl) {
  let solution = '';
  const embeds = [];
  const recurse = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      solution += node.nodeValue;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.classList && node.classList.contains('diagram-widget')) {
      const hands   = JSON.parse(node.dataset.hands   || '{}');
      const visible = JSON.parse(node.dataset.visible || '[]');
      const anchor  = makeMarker(node.dataset.diagId || makeId());
      solution += anchor;
      embeds.push({ anchor, hands, visible_seats: visible });
      return;
    }
    if (node.tagName === 'BR') { solution += '\n'; return; }
    if (node.tagName === 'DIV' && solution && !solution.endsWith('\n')) solution += '\n';
    for (const child of Array.from(node.childNodes)) recurse(child);
    if (node.tagName === 'DIV' && !solution.endsWith('\n')) solution += '\n';
  };
  for (const child of Array.from(rootEl.childNodes)) recurse(child);
  return { solution: solution.replace(/\n{3,}/g, '\n\n'), embedded_diagrams: embeds };
}

// ─── Insert deal flow ─────────────────────────────────────────────────────

function onInsertDeal() {
  const editorEl = _modalEl._refs.bodyEl.querySelector('[data-role="solution-editor"]');
  if (!editorEl) return;
  editorEl.focus();
  // Capture the insertion point now, before opening the modal. The widget
  // itself is only created/inserted on Save — Cancel leaves the editor as-is.
  const sel = window.getSelection();
  let savedRange = null;
  if (sel && sel.rangeCount > 0 && editorEl.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
  openDealModal(null, { editorEl, savedRange });
}

// ─── Edit-deal sub-modal ──────────────────────────────────────────────────
// widget=null means "create" mode (called from onInsertDeal). createCtx
// carries the editor element + saved insertion range used on Save.
function openDealModal(widget, createCtx) {
  const isCreating = !widget;
  const hands = isCreating
    ? emptyHands()
    : JSON.parse(widget.dataset.hands || JSON.stringify(emptyHands()));
  const visible = new Set(isCreating
    ? ['N', 'S']
    : JSON.parse(widget.dataset.visible || '[]'));

  const grid = el('div', { className: 'editor-hands-grid' });
  grid.appendChild(el('div'));
  for (const s of SUIT_ORDER) {
    grid.appendChild(el('div', { className: 'suit-cell' }, [
      el('span', { className: 'suit-sym', style: { color: SUIT_COLOR[s] } }, [SUIT_SYM[s]]),
    ]));
  }
  for (const seat of ['N', 'E', 'S', 'W']) {
    grid.appendChild(el('div', { className: 'seat-label' }, [SEAT_LABEL[seat]]));
    for (const suit of SUIT_ORDER) {
      const inp = el('input', {
        type: 'text',
        'data-seat': seat,
        'data-suit': suit,
        value: hands[seat]?.[suit] || '',
        placeholder: '—',
      });
      grid.appendChild(el('div', { className: 'suit-cell' }, [inp]));
    }
  }

  const visBoxes = el('div', { className: 'editor-checks' }, SEATS.map(s => {
    const cb = el('input', { type: 'checkbox', 'data-vis': s });
    if (visible.has(s)) cb.checked = true;
    return el('label', {}, [cb, ' ' + SEAT_LABEL[s]]);
  }));

  const overlay = el('div', { className: 'deal-modal-overlay' });
  const modal = el('div', { className: 'deal-modal' }, [
    el('div', { className: 'deal-modal-header' }, [
      el('h3', {}, ['Edit deal']),
      el('button', {
        className: 'btn',
        onClick: () => overlay.remove(),
      }, ['×']),
    ]),
    el('div', { className: 'deal-modal-body' }, [
      el('div', { className: 'editor-section-title' }, ['Cards']),
      grid,
      el('div', { className: 'editor-section-title' }, ['Visible to solver']),
      visBoxes,
    ]),
    el('div', { className: 'deal-modal-footer' }, [
      // Delete button only when editing an existing widget. Pinned to the
      // left via margin-right:auto on the Cancel button group.
      ...(isCreating ? [] : [
        el('button', {
          className: 'btn btn-danger',
          style: { marginRight: 'auto' },
          onClick: () => {
            if (widget && widget.parentNode) widget.parentNode.removeChild(widget);
            overlay.remove();
          },
        }, ['Delete deal']),
      ]),
      el('button', { className: 'btn', onClick: () => overlay.remove() }, ['Cancel']),
      el('button', {
        className: 'btn btn-primary',
        onClick: () => {
          const newHands = emptyHands();
          grid.querySelectorAll('input[data-seat]').forEach(inp => {
            newHands[inp.dataset.seat][inp.dataset.suit] = inp.value.trim();
          });
          const newVisible = Array.from(visBoxes.querySelectorAll('input[data-vis]:checked')).map(cb => cb.dataset.vis);
          if (isCreating) {
            const newWidget = buildWidget(newHands, newVisible);
            const { editorEl, savedRange } = createCtx || {};
            if (savedRange && editorEl && editorEl.contains(savedRange.startContainer)) {
              savedRange.deleteContents();
              savedRange.insertNode(newWidget);
              const after = document.createRange();
              after.setStartAfter(newWidget);
              after.collapse(true);
              const winSel = window.getSelection();
              winSel.removeAllRanges();
              winSel.addRange(after);
            } else if (editorEl) {
              editorEl.appendChild(newWidget);
            }
          } else {
            widget.dataset.hands   = JSON.stringify(newHands);
            widget.dataset.visible = JSON.stringify(newVisible);
            refreshWidgetInner(widget);
          }
          overlay.remove();
        },
      }, ['Save deal']),
    ]),
  ]);
  makeDraggable(modal.querySelector('.deal-modal-header'), modal);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  setTimeout(() => grid.querySelector('input')?.focus(), 0);
}

// ─── Hands validation ────────────────────────────────────────────────────
// Returns an error string if the deal has problems, null if ok.
// Only enforced when all 4 seats are filled (partial entry is fine).
function validateHandsForSave(hands) {
  const filledSeats = SEATS.filter(s => SUIT_ORDER.some(su => (hands[s]?.[su] || '').trim()));
  if (filledSeats.length < 4) return null;
  const seen = {};
  const counts = {};
  for (const seat of filledSeats) {
    let n = 0;
    for (const su of SUIT_ORDER) {
      const v = ((hands[seat]?.[su]) || '').toUpperCase().replace(/10/g, 'T');
      for (const c of v) {
        if (!'AKQJT98765432X'.includes(c)) {
          return `${seat} ${su}: invalid card '${c}'. Use A K Q J T 10 9–2 x.`;
        }
        if (c === 'X') { n++; continue; } // x = small card placeholder; skip duplicate check
        const key = su + c;
        if (seen[key]) {
          return `Duplicate card: ${SUIT_SYM[su]}${c === 'T' ? '10' : c} in both ${seen[key]} and ${seat}.`;
        }
        seen[key] = seat;
        n++;
      }
    }
    counts[seat] = n;
  }
  const sizes = filledSeats.map(s => counts[s]);
  if (!sizes.every(n => n === sizes[0])) {
    return `Unequal card counts: ${filledSeats.map(s => `${s}=${counts[s]}`).join(', ')}. Each hand must have the same number of cards.`;
  }
  return null;
}

// ─── Save coordinator ────────────────────────────────────────────────────

async function onSaveActiveTab() {
  const refs = _modalEl._refs;
  refs.saveBtn.disabled = true;
  setStatus('Saving...', '');

  try {
    let patch;
    if (_activeTab === 'problem')  patch = readProblemTab();
    if (_activeTab === 'solution') patch = readSolutionTab();
    if (_activeTab === 'source')   patch = readSourceTab();

    // Validate hands whenever they're being saved (either the problem tab is
    // active, or this is the first save and all tabs are collected together).
    const handsToCheck = patch?.hands_structured;
    if (handsToCheck) {
      const handsErr = validateHandsForSave(handsToCheck);
      if (handsErr) throw new Error('Deal error: ' + handsErr);
    }

    let result;
    if (_isNew) {
      // First save on a brand-new problem: read all three tab states (whatever
      // is currently in the form) so we don't lose fields the user filled on
      // tabs other than the active one.
      const allTabs = collectAllTabState();
      const newHandsErr = validateHandsForSave(allTabs.hands_structured);
      if (newHandsErr) throw new Error('Deal error: ' + newHandsErr);
      // Correct any repairable misprint at source so hands_structured and lin
      // stay in sync (see bpLin.canonicalize).
      const canon = globalThis.bpLin.canonicalize(allTabs);
      allTabs.hands_structured = canon.hands;
      allTabs.lin = canon.lin;
      validatePlayForSave(allTabs, canon.lin);
      // A keyed-in problem's "source" is its book title; default it when the
      // user left it blank ('Untitled' is the app's blank-source sentinel).
      const bt = (allTabs.book_title || '').trim();
      allTabs.book_title = (!bt || bt === 'Untitled') ? 'User Input' : bt;
      result = await insertProblem({ ...defaultEmptyProblem(), ...allTabs });
      _editor = withLinDeal(result);
      _isNew  = false;
      // Rebuild header to drop "Key in" wording.
      rebuildShellHeader();
    } else {
      const canon = globalThis.bpLin.canonicalize({ ..._editor, ...patch });
      validatePlayForSave(patch, canon.lin);
      if (_activeTab === 'problem') {
        patch = {
          problem_text: patch.problem_text,
          problem_visible_hands: patch.problem_visible_hands,
          format: patch.format,
          lin: canon.lin,
        };
      }
      result = await updateProblem(_editor.id, patch);
      _editor = withLinDeal(result);
    }
    setStatus('Saved.', 'success');
    if (_onSaveCb) _onSaveCb(_editor);
  } catch (e) {
    console.error(e);
    setStatus('Save failed: ' + (e.message || e), 'error');
  } finally {
    refs.saveBtn.disabled = false;
  }
}

// Canonical LIN is derived data, regenerated on every save so it never
// drifts from the source fields: playable when possible, display-only
// (partial hands / incomplete auction) otherwise. lin.js is loaded by
// viewer.html before this module; the guard covers any other embedding.
function derivedLin(p) {
  const L = globalThis.bpLin;
  if (!L) return null;
  let lin = L.problemToLin(p, p.hands_structured);
  if (!lin) {
    const fix = L.repairKnownMisprint(p.hands_structured);
    if (fix) lin = L.problemToLin(p, fix.hands);
  }
  return lin || L.buildDisplayLin(p, p.hands_structured);
}

function collectAllTabState() {
  // The active tab's form is in the DOM right now. For the inactive tabs we
  // fall back to whatever's in _editor (which represents either pristine
  // defaults for a new problem or the last loaded values for an existing one).
  const acc = { ...defaultEmptyProblem(), ..._editor };
  if (_activeTab === 'problem')  Object.assign(acc, readProblemTab());
  if (_activeTab === 'solution') Object.assign(acc, readSolutionTab());
  if (_activeTab === 'source')   Object.assign(acc, readSourceTab());
  // Strip nullable empties Postgres won't accept as defaults.
  return acc;
}

function rebuildShellHeader() {
  const h2 = _modalEl.querySelector('.editor-header h2');
  if (h2) h2.textContent = `Edit problem — ${_editor.book_title || 'Untitled'} ${_editor.problem_number || ''}`.trim();
}

// ─── Reset to original (called from outside) ──────────────────────────────

export async function revertProblem(id) {
  return await resetToOriginal(id);
}

export async function reloadProblem(id) {
  return await readProblem(id);
}

// ─── Field helpers ────────────────────────────────────────────────────────

function selectField(label, options, value) {
  const sel = el('select', { 'data-field': label });
  for (const opt of options) {
    const o = el('option', { value: opt }, [opt]);
    if (opt === value) o.setAttribute('selected', '');
    sel.appendChild(o);
  }
  return el('div', { className: 'editor-field' }, [el('label', {}, [label]), sel]);
}

function colorizeSuitsLocal(text) {
  if (!text) return '';
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const R = 'style="color:#c00"';
  return esc
    .replace(/♥/g, `<span ${R}>♥</span>`)
    .replace(/♦/g, `<span ${R}>♦</span>`)
    // bid format: 4H → 4♥
    .replace(/([1-7])([Ss])\b/g, '$1♠')
    .replace(/([1-7])([Hh])\b/g, `$1<span ${R}>♥</span>`)
    .replace(/([1-7])([Dd])\b/g, `$1<span ${R}>♦</span>`)
    .replace(/([1-7])([Cc])\b/g, '$1♣')
    // card format: HK → ♥K (only at word boundary, not after a digit)
    .replace(/(?<![0-9])([Hh])(10|[AKQJTakqjt2-9xX])(?![0-9])/g, `<span ${R}>♥</span>$2`)
    .replace(/(?<![0-9])([Dd])(10|[AKQJTakqjt2-9xX])(?![0-9])/g, `<span ${R}>♦</span>$2`)
    .replace(/(?<![0-9])([Ss])(10|[AKQJTakqjt2-9xX])(?![0-9])/g, '♠$2')
    .replace(/(?<![0-9])([Cc])(10|[AKQJTakqjt2-9xX])(?![0-9])/g, '♣$2');
}

function wrapWithSuitOverlay(inp) {
  const wrap = el('div', { className: 'suit-input-wrap' });
  inp.parentNode.replaceChild(wrap, inp);
  wrap.appendChild(inp);
  const overlay = el('div', { className: 'suit-input-overlay', 'aria-hidden': 'true' });
  overlay.innerHTML = colorizeSuitsLocal(inp.value);
  wrap.appendChild(overlay);
  function refresh() { overlay.innerHTML = colorizeSuitsLocal(inp.value); }
  function showOverlay() { overlay.style.display = ''; refresh(); }
  function hideOverlay() { overlay.style.display = 'none'; }
  if (inp.value) showOverlay(); else overlay.style.display = 'none';
  inp.addEventListener('focus', hideOverlay);
  inp.addEventListener('blur', () => { if (inp.value) showOverlay(); else overlay.style.display = 'none'; });
  inp.addEventListener('input', refresh);
  return wrap;
}

function addSuitColorPreview(fieldEl, inp) {
  wrapWithSuitOverlay(inp);
}

function textField(label, value, type = 'text') {
  const inp = el('input', { type, 'data-field': label, value: value ?? '' });
  return el('div', { className: 'editor-field' }, [el('label', {}, [label]), inp]);
}

function textareaField(label, value) {
  const ta = el('textarea', { 'data-field': label }, [value || '']);
  return el('div', { className: 'editor-field editor-field-wide' }, [el('label', {}, [label]), ta]);
}
