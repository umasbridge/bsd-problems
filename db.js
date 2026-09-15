// Supabase client + auth/data helpers for the bridge-problems viewer/editor.
// Same-origin with bsd-app, so the existing logged-in session is picked up
// from localStorage automatically (default storage key
// `sb-<project-ref>-auth-token`).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://fwvbjmntuersvhvqxuxq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3dmJqbW50dWVyc3ZodnF4dXhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyMTA5MjQsImV4cCI6MjA3OTc4NjkyNH0.GuNM7nSYMcPx6mWTywCVpOMF_tYlx1Y6iHYUk3LX4Hc';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function getCurrentUserEmail() {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.email || null;
}

let _canEditCache = null;
export async function canEdit() {
  if (_canEditCache !== null) return _canEditCache;
  const email = await getCurrentUserEmail();
  if (!email) { _canEditCache = false; return false; }
  const { data, error } = await supabase
    .from('bp_collaborators')
    .select('email')
    .eq('email', email)
    .maybeSingle();
  _canEditCache = !error && !!data;
  return _canEditCache;
}

// Fields that are part of the "source problem" — captured into
// original_snapshot on the very first edit so the row can be reverted later.
export const SNAPSHOT_FIELDS = [
  'lin',
  'problem_visible_hands',
  'problem_text',
  'solution',
  'embedded_diagrams',
  'book_title',
  'author',
  'chapter',
  'problem_number',
];

// Fields that are post-source metadata — NOT snapshotted, NOT reverted.
export const META_FIELDS = ['subcategory', 'format', 'tags', 'level'];

// Tags/level-only quick path used by the legacy modals during Phase 1.
// (Phase 2 keeps it for any callers that still rely on it.)
export async function updateProblemTagsLevel(id, { tags, level }) {
  const patch = { updated_at: new Date().toISOString() };
  if (tags !== undefined) patch.tags = tags;
  if (level !== undefined) patch.level = level;
  const { data, error } = await supabase
    .from('bp_problems')
    .update(patch)
    .eq('id', id)
    .select('id, tags, level')
    .single();
  if (error) throw error;
  return data;
}

export async function readProblemTagsLevel(id) {
  const { data, error } = await supabase
    .from('bp_problems')
    .select('id, tags, level')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

// Update an existing problem with arbitrary fields.
// If the patch touches any SNAPSHOT_FIELDS and the row's original_snapshot
// is currently NULL, the *current* (pre-edit) values of those fields are
// captured into original_snapshot first, so the edit is reversible.
export async function updateProblem(id, patch) {
  const touchesSnapshotField = Object.keys(patch).some(k => SNAPSHOT_FIELDS.includes(k));
  const finalPatch = { ...patch, updated_at: new Date().toISOString() };

  if (touchesSnapshotField) {
    const selectCols = ['id', 'original_snapshot', ...SNAPSHOT_FIELDS].join(', ');
    const { data: row, error: readErr } = await supabase
      .from('bp_problems')
      .select(selectCols)
      .eq('id', id)
      .single();
    if (readErr) throw readErr;
    if (!row.original_snapshot) {
      const snapshot = {};
      for (const k of SNAPSHOT_FIELDS) snapshot[k] = row[k] ?? null;
      finalPatch.original_snapshot = snapshot;
    }
  }

  const { data, error } = await supabase
    .from('bp_problems')
    .update(finalPatch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function insertProblem(payload) {
  const canonicalPayload = { ...payload };
  if (globalThis.bpLin) {
    const canon = globalThis.bpLin.canonicalize(canonicalPayload);
    canonicalPayload.lin = canon.lin;
  }
  for (const key of ['hands_structured', 'dealer', 'vulnerability', 'bidding', 'contract', 'lead', 'play']) {
    delete canonicalPayload[key];
  }
  const { data, error } = await supabase
    .from('bp_problems')
    .insert({ ...canonicalPayload, updated_at: new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// Restore a problem to the values captured in original_snapshot, then clear
// original_snapshot. No-op if the row was never edited.
export async function resetToOriginal(id) {
  const { data: row, error: readErr } = await supabase
    .from('bp_problems')
    .select('id, original_snapshot')
    .eq('id', id)
    .single();
  if (readErr) throw readErr;
  if (!row.original_snapshot) {
    throw new Error('Nothing to reset — this problem has no original_snapshot.');
  }
  const patch = {
    ...row.original_snapshot,
    original_snapshot: null,
    updated_at: new Date().toISOString(),
  };
  // Snapshots made before LIN became authoritative contain the former deal
  // columns. Convert those once during restore, then never write them back.
  if (!patch.lin && globalThis.bpLin) patch.lin = globalThis.bpLin.canonicalize(patch).lin;
  for (const key of ['hands_structured', 'dealer', 'vulnerability', 'bidding', 'contract', 'lead', 'play']) {
    delete patch[key];
  }
  const { data, error } = await supabase
    .from('bp_problems')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function readProblem(id) {
  const { data, error } = await supabase
    .from('bp_problems')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

// ─── Problem-set CRUD ────────────────────────────────────────────────────

let _userIdCache = null;
async function currentUserId() {
  if (_userIdCache) return _userIdCache;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  _userIdCache = user.id;
  return _userIdCache;
}

// Returns sets owned by the current user, shaped to match the legacy
// localStorage format: { id, name, problemIds, createdAt, updatedAt }.
export async function listMySets() {
  const userId = await currentUserId();
  const { data, error } = await supabase
    .from('bp_problem_sets')
    .select('id, name, created_at, updated_at, items:bp_problem_set_items(problem_id, position)')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(s => ({
    id: s.id,
    name: s.name,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    problemIds: (s.items || []).slice().sort((a, b) => a.position - b.position).map(it => it.problem_id),
  }));
}

export async function createSet(name, problemIds) {
  const userId = await currentUserId();
  const { data: setRow, error: setErr } = await supabase
    .from('bp_problem_sets')
    .insert({ name, user_id: userId })
    .select('id, name, created_at, updated_at')
    .single();
  if (setErr) throw setErr;
  if (problemIds && problemIds.length) {
    const items = problemIds.map((pid, i) => ({ set_id: setRow.id, problem_id: pid, position: i }));
    const { error: itemsErr } = await supabase.from('bp_problem_set_items').insert(items);
    if (itemsErr) throw itemsErr;
  }
  return {
    id: setRow.id,
    name: setRow.name,
    createdAt: setRow.created_at,
    updatedAt: setRow.updated_at,
    problemIds: problemIds || [],
  };
}

export async function updateSetMeta(setId, patch) {
  const update = { updated_at: new Date().toISOString() };
  if ('name' in patch) update.name = patch.name;
  const { data, error } = await supabase
    .from('bp_problem_sets')
    .update(update)
    .eq('id', setId)
    .select('id, name, created_at, updated_at')
    .single();
  if (error) throw error;
  return data;
}

// Replace the items of a set with the given ordered list of problem ids.
// Used for add/remove/reorder. Single-shot semantics — pass the full new list.
export async function replaceSetItems(setId, problemIds) {
  const { error: delErr } = await supabase
    .from('bp_problem_set_items')
    .delete()
    .eq('set_id', setId);
  if (delErr) throw delErr;
  if (problemIds && problemIds.length) {
    const items = problemIds.map((pid, i) => ({ set_id: setId, problem_id: pid, position: i }));
    const { error: insErr } = await supabase.from('bp_problem_set_items').insert(items);
    if (insErr) throw insErr;
  }
  await supabase.from('bp_problem_sets')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', setId);
}

// ─── Interactive library — recently-opened books ────────────────────────
// Per-user "Reading Now" list. One row per (user, book_title); opening a book
// upserts its last_opened_at so the two most-recent bubble to the top.
export async function listRecentBooks(limit = 2) {
  const { data, error } = await supabase
    .from('bp_recent_books')
    .select('book_title, last_opened_at')
    .order('last_opened_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(r => ({ bookTitle: r.book_title, lastOpenedAt: r.last_opened_at }));
}

export async function recordBookOpen(bookTitle) {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('bp_recent_books')
    .upsert(
      { user_id: userId, book_title: bookTitle, last_opened_at: new Date().toISOString() },
      { onConflict: 'user_id,book_title' },
    );
  if (error) throw error;
}

export async function removeRecentBook(bookTitle) {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('bp_recent_books')
    .delete()
    .eq('user_id', userId)
    .eq('book_title', bookTitle);
  if (error) throw error;
}

// ─── Review attempts (per user, per problem) ─────────────────────────────
// Attempts are keyed by problem, not by set, so a problem's review history
// follows it across sets, books, and devices. One row per (user, problem);
// the whole attempts array is stored as jsonb and replaced on each write.
export async function listMyAttempts() {
  const { data, error } = await supabase
    .from('bp_problem_attempts')
    .select('problem_id, attempts')
    .limit(10000);
  if (error) throw error;
  return (data || []).map(r => ({ problemId: r.problem_id, attempts: Array.isArray(r.attempts) ? r.attempts : [] }));
}

export async function saveProblemAttempts(problemId, attempts) {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('bp_problem_attempts')
    .upsert(
      { user_id: userId, problem_id: problemId, attempts, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,problem_id' },
    );
  if (error) throw error;
}

// ─── Tag registry ────────────────────────────────────────────────────────
// Tag pool for a category = (tags in bp_tag_registry for that category) ∪
// (distinct tags actually attached to problems in that category). Editor
// uses this to populate the multi-select tag picker.
export async function listTagsForCategory(category) {
  if (!category) return [];
  const [{ data: regRows, error: regErr }, { data: probRows, error: probErr }] = await Promise.all([
    supabase.from('bp_tag_registry').select('tag').eq('category', category),
    supabase.from('bp_problems').select('tags').eq('subcategory', category),
  ]);
  if (regErr)  throw regErr;
  if (probErr) throw probErr;
  const set = new Set();
  for (const r of regRows || []) if (r.tag) set.add(r.tag);
  for (const p of probRows || []) for (const t of (p.tags || [])) if (t) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Insert a tag into the registry. Idempotent — ignores unique-violation if
// the (tag, category) pair already exists.
export async function addTagToRegistry(tag, category) {
  if (!tag || !category) return;
  const { error } = await supabase
    .from('bp_tag_registry')
    .insert({ tag, category });
  if (error && error.code !== '23505') throw error;
}

export async function deleteSetById(setId) {
  // Items first, then the set row (FK).
  const { error: itemsErr } = await supabase
    .from('bp_problem_set_items')
    .delete()
    .eq('set_id', setId);
  if (itemsErr) throw itemsErr;
  const { error: setErr } = await supabase
    .from('bp_problem_sets')
    .delete()
    .eq('id', setId);
  if (setErr) throw setErr;
}

// ─── Problem-set sharing ─────────────────────────────────────────────────

// Set ids that have any share involving the current user (either I shared them
// out, or they were shared with me). RLS limits rows to the current user, so a
// bare select returns exactly the sets that are "shared" from my perspective.
// Used to decide whether to show the per-problem Discussion button.
export async function listSharedSetIds() {
  const { data, error } = await supabase
    .from('bp_problem_set_shares')
    .select('set_id');
  if (error) throw error;
  return [...new Set((data || []).map(r => r.set_id))];
}

export async function listSharedSets() {
  const userId = await currentUserId();
  const { data: shares, error: sharesErr } = await supabase
    .from('bp_problem_set_shares')
    .select('set_id, show_solution, shared_by')
    .eq('shared_with_user_id', userId);
  if (sharesErr) throw sharesErr;
  if (!shares || !shares.length) return [];

  const setIds = shares.map(s => s.set_id);
  const { data: sets, error: setsErr } = await supabase
    .from('bp_problem_sets')
    .select('id, name, created_at, updated_at, items:bp_problem_set_items(problem_id, position)')
    .in('id', setIds)
    .order('updated_at', { ascending: false });
  if (setsErr) throw setsErr;

  const shareMap = Object.fromEntries(shares.map(s => [s.set_id, s]));

  const ownerIds = [...new Set(shares.map(s => s.shared_by))];
  let emailMap = {};
  if (ownerIds.length) {
    const { data: profiles } = await supabase.rpc('get_user_emails', { user_ids: ownerIds });
    if (profiles) profiles.forEach(p => { emailMap[p.id] = p.email; });
  }

  return (sets || []).map(s => ({
    id: s.id,
    name: s.name,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    problemIds: (s.items || []).slice().sort((a, b) => a.position - b.position).map(it => it.problem_id),
    showSolution: shareMap[s.id]?.show_solution ?? false,
    sharedBy: emailMap[shareMap[s.id]?.shared_by] || 'Unknown',
  }));
}

export async function shareSet(setId, email, showSolution) {
  const userId = await currentUserId();
  const { data: targetUserId, error: lookupErr } = await supabase
    .rpc('lookup_user_by_email', { lookup_email: email.trim().toLowerCase() });
  if (lookupErr || !targetUserId) throw new Error('No user found with that email.');
  if (targetUserId === userId) throw new Error("You can't share with yourself.");

  const { error } = await supabase
    .from('bp_problem_set_shares')
    .upsert({
      set_id: setId,
      shared_with_user_id: targetUserId,
      show_solution: showSolution,
      shared_by: userId,
    }, { onConflict: 'set_id,shared_with_user_id' });
  if (error) throw error;

  // Auto-add the new user to all existing note discussions for this set
  await syncNotesMembersOnShare(setId, targetUserId);
}

export async function listSetShares(setId) {
  const { data, error } = await supabase
    .from('bp_problem_set_shares')
    .select('id, shared_with_user_id, show_solution, created_at')
    .eq('set_id', setId);
  if (error) throw error;
  if (!data || !data.length) return [];

  const userIds = data.map(s => s.shared_with_user_id);
  const { data: profiles } = await supabase.rpc('get_user_emails', { user_ids: userIds });
  const emailMap = {};
  if (profiles) profiles.forEach(p => { emailMap[p.id] = p.email; });

  return data.map(s => ({
    ...s,
    email: emailMap[s.shared_with_user_id] || 'Unknown',
  }));
}

export async function removeSetShare(shareId) {
  const { error } = await supabase
    .from('bp_problem_set_shares')
    .delete()
    .eq('id', shareId);
  if (error) throw error;
}

export async function updateSetShare(shareId, patch) {
  const update = {};
  if ('show_solution' in patch) update.show_solution = patch.show_solution;
  const { error } = await supabase
    .from('bp_problem_set_shares')
    .update(update)
    .eq('id', shareId);
  if (error) throw error;
}

// ─── My Notes (discussions per problem-in-set) ─────────────────────────

export { currentUserId };

export async function findOrCreateNotes(setId, problemId, displayName) {
  const userId = await currentUserId();
  const resourceId = `${setId}:${problemId}`;
  const resourceType = 'bp_problem_set';

  // Find existing discussion
  const { data: existing, error: findErr } = await supabase
    .from('discussions')
    .select('id, name, created_by')
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .limit(1);
  if (findErr) throw findErr;

  let disc = existing?.[0];
  if (disc) {
    // Ensure current user is a member
    await supabase.from('discussion_members')
      .insert({ discussion_id: disc.id, user_id: userId })
      .then(() => {}, () => {});
    return disc;
  }

  // Create new discussion
  const { data: created, error: createErr } = await supabase
    .from('discussions')
    .insert({
      name: displayName || 'Notes',
      created_by: userId,
      resource_type: resourceType,
      resource_id: resourceId,
    })
    .select('id, name, created_by')
    .single();
  if (createErr) throw createErr;

  // Add creator as member
  await supabase.from('discussion_members')
    .insert({ discussion_id: created.id, user_id: userId })
    .then(() => {}, () => {});

  // Add all shared users as members
  const { data: shares } = await supabase
    .from('bp_problem_set_shares')
    .select('shared_with_user_id, shared_by')
    .eq('set_id', setId);
  if (shares) {
    const memberIds = new Set();
    for (const s of shares) {
      if (s.shared_with_user_id && s.shared_with_user_id !== userId)
        memberIds.add(s.shared_with_user_id);
      if (s.shared_by && s.shared_by !== userId)
        memberIds.add(s.shared_by);
    }
    // Also add the set owner if current user is a shared viewer
    const { data: setRow } = await supabase
      .from('bp_problem_sets')
      .select('user_id')
      .eq('id', setId)
      .maybeSingle();
    if (setRow && setRow.user_id !== userId)
      memberIds.add(setRow.user_id);

    for (const uid of memberIds) {
      await supabase.from('discussion_members')
        .insert({ discussion_id: created.id, user_id: uid })
        .then(() => {}, () => {});
    }
  }

  return created;
}

export async function loadNotes(discussionId) {
  const { data, error } = await supabase
    .from('discussion_messages')
    .select('id, content, user_id, created_at')
    .eq('discussion_id', discussionId)
    .eq('deleted', false)
    .order('created_at');
  if (error) throw error;
  return data || [];
}

export async function sendNote(discussionId, text) {
  const userId = await currentUserId();
  const { data, error } = await supabase
    .from('discussion_messages')
    .insert({ discussion_id: discussionId, user_id: userId, content: text })
    .select('id, content, user_id, created_at')
    .single();
  if (error) throw error;
  return data;
}

export async function syncNotesMembersOnShare(setId, targetUserId) {
  const { data: discussions } = await supabase
    .from('discussions')
    .select('id')
    .eq('resource_type', 'bp_problem_set')
    .like('resource_id', `${setId}:%`);
  if (!discussions || !discussions.length) return;
  for (const d of discussions) {
    await supabase.from('discussion_members')
      .insert({ discussion_id: d.id, user_id: targetUserId })
      .then(() => {}, () => {});
  }
}
