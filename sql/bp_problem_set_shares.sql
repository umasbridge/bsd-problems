-- Problem-set sharing
-- Run this in the Supabase SQL Editor

CREATE TABLE bp_problem_set_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id UUID REFERENCES bp_problem_sets(id) ON DELETE CASCADE NOT NULL,
  shared_with_user_id UUID REFERENCES auth.users NOT NULL,
  show_solution BOOLEAN NOT NULL DEFAULT false,
  shared_by UUID REFERENCES auth.users NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (set_id, shared_with_user_id)
);

CREATE INDEX idx_bp_set_shares_user ON bp_problem_set_shares(shared_with_user_id);
CREATE INDEX idx_bp_set_shares_set ON bp_problem_set_shares(set_id);

ALTER TABLE bp_problem_set_shares ENABLE ROW LEVEL SECURITY;

-- Owner (shared_by) can do everything
CREATE POLICY "Sharer can manage shares"
  ON bp_problem_set_shares FOR ALL
  USING (shared_by = auth.uid());

-- Sharee can read their own share rows
CREATE POLICY "Sharee can view own shares"
  ON bp_problem_set_shares FOR SELECT
  USING (shared_with_user_id = auth.uid());

-- Sharee can read problem sets shared with them
CREATE POLICY "Sharee can view shared sets"
  ON bp_problem_sets FOR SELECT
  USING (
    id IN (SELECT set_id FROM bp_problem_set_shares WHERE shared_with_user_id = auth.uid())
  );

-- Sharee can read items of shared sets
CREATE POLICY "Sharee can view shared set items"
  ON bp_problem_set_items FOR SELECT
  USING (
    set_id IN (SELECT set_id FROM bp_problem_set_shares WHERE shared_with_user_id = auth.uid())
  );
