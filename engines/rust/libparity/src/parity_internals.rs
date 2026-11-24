// Parity generation algorithm
// Original algorithm by Jewel, improved by tillvit, improved further by mjvotaw, improved furtherer by tillvit
//
// Port of the batch path (ParityInternals.computeBatch) only.

use crate::js::{math_min, math_round, to_fixed, FxHashMap};
use crate::note_types::{is_hold_note, NoteType, NotedataEntry};
use crate::parity_cost::{cost, Costs, ParityCostCalculator};
use crate::parity_data_types::{
    compare_states, facing, Foot, FootOverride, MineRow, ParityState, Row, Rows, StateKey, FEET, LEFT_HEEL, LEFT_TOE, MAX_COLUMNS, NONE,
    OTHER_PART_OF_FOOT, RIGHT_HEEL, RIGHT_TOE, TECH_CATEGORY_COUNT, TECH_ERROR_COUNT, UNDEFINED_FOOT,
};
use crate::parity_result_types::{HoldOwner, ParityComputeData, RowTimestamp};
use crate::parity_utils::{
    hold_override_at, HOLD_RELEASE_WINDOW, REVERSAL_WINDOW, ROLL_RELEASE_WINDOW, SECOND_EPSILON,
};
use crate::row_stat_calculator::{calculate_row_stats, RowStatAccumulator};
use crate::stage_layouts::{stage_layout, StageLayout};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

pub type Action = [Foot; MAX_COLUMNS];

pub struct ParityGraphNode {
    // child keys to edge costs, in insertion order
    pub children: Vec<(StateKey, Costs)>,
    pub state: ParityState,
    pub key: StateKey,
}

impl ParityGraphNode {
    pub fn new(state: ParityState, key: Option<StateKey>) -> ParityGraphNode {
        let key = key.unwrap_or_else(|| state.to_key());
        ParityGraphNode { children: Vec::new(), state, key }
    }
}

// A batch_search node: its best path so far (a Slot in the TS source), the
// parent an index into the previous row's nodes.
struct BatchNode {
    state: ParityState,
    key: StateKey,
    reached: bool,
    cost: f64,
    last_ds: i64,
    rank: u32,
    parent: u32,
    expanded_by: u32,
    pruned: bool,
}

impl BatchNode {
    fn new(state: ParityState, key: StateKey) -> BatchNode {
        BatchNode { state, key, reached: false, cost: 0.0, last_ds: -1, rank: 0, parent: 0, expanded_by: 0, pruned: false }
    }

    // `from` is node `from_index` of the previous row; `old_parent_rank` is
    // the rank of `to`'s parent when `to` is reached
    fn relax(
        to: &mut BatchNode,
        from: &BatchNode,
        from_index: u32,
        old_parent_rank: u32,
        costs: &Costs,
        parent_row: i64,
    ) {
        let new_cost = from.cost + costs.get(cost::TOTAL);
        let last_ds =
            if costs.get(cost::DOUBLESTEP) > 0.0 || costs.get(cost::JACK) > 0.0 { parent_row } else { from.last_ds };
        let tie = to.reached
            && (new_cost - to.cost).abs() < TIE_EPSILON
            && (last_ds > to.last_ds || (last_ds == to.last_ds && from.rank < old_parent_rank));
        if !to.reached || new_cost < to.cost - TIE_EPSILON || tie {
            to.reached = true;
            to.cost = new_cost;
            to.last_ds = last_ds;
            to.parent = from_index;
        }
    }

    // Drops a node when a node of the same stance with weaker turn memory
    // (none, or the same turn ending no later) is cheaper by more than
    // TURN_PRUNE_MARGIN.
    fn prune_turn_memory(nodes: &mut [BatchNode]) {
        if nodes.iter().all(|n| n.state.last_turn == facing::FORWARD) {
            return;
        }
        let mut groups: FxHashMap<StateKey, Vec<usize>> = FxHashMap::default();
        let mut order: Vec<StateKey> = Vec::new();
        for (i, n) in nodes.iter().enumerate() {
            let key = n.state.stance_key();
            groups.entry(key).or_insert_with(|| {
                order.push(key);
                Vec::new()
            }).push(i);
        }
        let weaker = |a: &ParityState, b: &ParityState| {
            a.last_turn == facing::FORWARD || (a.last_turn == b.last_turn && a.last_turn_end <= b.last_turn_end)
        };
        let mut dropped: Vec<usize> = Vec::new();
        for key in &order {
            let group = &groups[key];
            if group.len() < 2 {
                continue;
            }
            for &b in group {
                if group.iter().any(|&a| {
                    a != b && nodes[a].cost + TURN_PRUNE_MARGIN < nodes[b].cost && weaker(&nodes[a].state, &nodes[b].state)
                }) {
                    dropped.push(b);
                }
            }
        }
        for i in dropped {
            nodes[i].pruned = true;
        }
    }
}

pub struct ParityInternals<'a> {
    cost_calc: ParityCostCalculator,
    layout: StageLayout,

    initial_node: ParityGraphNode,
    end_node: ParityGraphNode,

    // In a bracket phrase where both feet stand on two panels each, a foot
    // re-pressing one of its panels may keep the other part planted.
    keep_stance_all_covered: bool,
    turn_pruning: bool,
    hover_enabled: bool,

    // Cache for foot permutations, keyed by the bitmask of pressed/held columns
    permute_cache: HashMap<u32, Rc<Vec<Action>>>,

    pub best_path: Option<Vec<StateKey>>,
    pub best_path_cost: f64,

    pub notedata_rows: Rows<'a>,
}

const TIE_EPSILON: f64 = 1e-6;
/// rows a committed path node trails the search front by, at least
pub const TRACEBACK_ROWS: usize = 128;
const TURN_PRUNE_MARGIN: f64 = 1e-3;

impl<'a> ParityInternals<'a> {
    pub fn new(game_type: &str) -> Result<ParityInternals<'a>, String> {
        let layout = stage_layout(game_type).ok_or_else(|| format!("Unsupported game type: {game_type}"))?;
        let cost_calc = ParityCostCalculator::new(layout.clone());
        let empty = [UNDEFINED_FOOT; MAX_COLUMNS];
        let mut no_feet = empty;
        no_feet[..layout.column_count].fill(NONE);
        let mut start_state = ParityState::new(-1.0, -1.0, &no_feet, [-1; 5]);
        start_state.combined_columns = no_feet;
        Ok(ParityInternals {
            cost_calc,
            layout,
            initial_node: ParityGraphNode::new(start_state, None),
            end_node: ParityGraphNode::new(ParityState::new(-1.0, -1.0, &empty, [-1; 5]), None),
            keep_stance_all_covered: true,
            turn_pruning: true,
            hover_enabled: true,
            permute_cache: HashMap::new(),
            best_path: None,
            best_path_cost: 0.0,
            notedata_rows: Rows::default(),
        })
    }

    // Same result as compute() on a fresh instance (see batch_search);
    // replaces this instance's state.
    pub fn compute_batch(&mut self, start_beat: f64, end_beat: f64, notedata: &'a [NotedataEntry]) -> Option<ParityComputeData> {
        self.reset();
        self.recalculate_rows(start_beat, end_beat, notedata);
        let mut path: Vec<ParityGraphNode> = Vec::new();
        let cost = self.batch_search(|this, i| i < this.notedata_rows.len(), |_, node| path.push(node))?;
        for (i, node) in path.iter_mut().enumerate() {
            self.set_path_children(node, i);
        }
        self.initial_node.children = path[0].children.clone();

        let mut best_nodes: Vec<&ParityGraphNode> = path.iter().collect();
        best_nodes.push(&self.end_node);

        let best_path: Vec<StateKey> = best_nodes.iter().map(|n| n.key).collect();
        let result = Self::build_result(&self.notedata_rows, &self.layout, &best_nodes);
        self.best_path = Some(best_path);
        self.best_path_cost = cost;
        Some(result)
    }

    // compute_batch's tech and error counts, holding only the rows and states
    // of the traceback window; replaces this instance's state.
    pub fn compute_batch_counts(
        &mut self,
        start_beat: f64,
        end_beat: f64,
        notedata: &'a [NotedataEntry],
    ) -> Option<([u32; TECH_CATEGORY_COUNT], [u32; TECH_ERROR_COUNT])> {
        self.reset();
        let (note_start_idx, note_end_idx) = self.note_range(notedata, start_beat, end_beat);
        let range_notes: &'a [NotedataEntry] = js_slice(notedata, note_start_idx, note_end_idx);
        let mut builder = self.row_builder(notedata, note_start_idx);
        let mut next = 0;
        let mut finished = false;
        let has_row = |this: &mut Self, i: usize| {
            while this.notedata_rows.len() <= i && !finished {
                let row = if next < range_notes.len() {
                    next += 1;
                    builder.add(&range_notes[next - 1])
                } else {
                    finished = true;
                    builder.finish()
                };
                if let Some(row) = row {
                    this.notedata_rows.push(row);
                }
            }
            i < this.notedata_rows.len()
        };
        let mut stats = RowStatAccumulator::new(self.layout.clone(), false);
        // path index: the start node is 0, a row's node is its row + 1
        let mut index = 0;
        self.batch_search(has_row, |this, mut node| {
            this.set_path_children(&mut node, index);
            stats.push(&this.notedata_rows, node);
            // later pushes and set_path_children read rows index - 1 on
            if index >= 3 {
                this.notedata_rows.release_before(index - 2);
            }
            index += 1;
        })?;
        Some(stats.counts())
    }

    // One forward pass over rows 0.. (while has_row), keeping per row the
    // best path into each state. Passes the best path's nodes to commit() in
    // order, the start node and then one per row (not the end node), and
    // returns its cost, or None when no path exists (commit() may have been
    // called by then). has_row(i) must make rows 0..=i available; a node is
    // committed once the two rows after it are.
    //
    // Ties break as in compute(): the later same-foot repeat (last_ds), then
    // the path whose state is lower (compare_states) where the two paths
    // split. The latter is a per-row rank: paths ordered by their parent's
    // rank, then by their own state.
    //
    // Every TRACEBACK_ROWS rows, the path into the current best state is
    // committed up to TRACEBACK_ROWS rows back and the states whose path
    // disagrees there are dropped, so memory stays bounded by the window. This
    // equals the unbounded search unless the best path changes more than
    // TRACEBACK_ROWS rows after the fact.
    fn batch_search(
        &mut self,
        mut has_row: impl FnMut(&mut Self, usize) -> bool,
        mut commit: impl FnMut(&mut Self, ParityGraphNode),
    ) -> Option<f64> {
        let end_node = (self.end_node.state.clone(), self.end_node.key);
        // the end node relaxed over the row's live nodes in order; its parent
        // is the best of them
        let best = |nodes: &[BatchNode], row: i64| {
            let mut end = BatchNode::new(end_node.0.clone(), end_node.1);
            for (i, from) in nodes.iter().enumerate() {
                if from.pruned {
                    continue;
                }
                let old_rank = if end.reached { nodes[end.parent as usize].rank } else { 0 };
                BatchNode::relax(&mut end, from, i as u32, old_rank, &Costs::total_only(0.0), row);
            }
            end
        };
        let k = TRACEBACK_ROWS;
        // levels[l] holds the nodes of row base + l - 1 (row -1: the start node)
        let mut levels: VecDeque<Vec<BatchNode>> = VecDeque::new();
        let mut base = 0;
        // the first row not committed yet
        let mut committed = 0;
        // commits the path ending at node `index` of row `row`, from row `committed` on
        let commit_through = |this: &mut Self,
                              commit: &mut dyn FnMut(&mut Self, ParityGraphNode),
                              levels: &VecDeque<Vec<BatchNode>>,
                              base: usize,
                              committed: &mut usize,
                              row: usize,
                              mut index: u32| {
            let mut nodes: Vec<ParityGraphNode> = Vec::new();
            for r in (*committed..=row).rev() {
                let node = &levels[r + 1 - base][index as usize];
                nodes.push(ParityGraphNode::new(node.state.clone(), Some(node.key)));
                index = node.parent;
            }
            for node in nodes.into_iter().rev() {
                commit(this, node);
            }
            *committed = row + 1;
        };

        let mut start = BatchNode::new(self.initial_node.state.clone(), self.initial_node.key);
        start.reached = true;
        levels.push_back(vec![start]);
        has_row(self, 1);
        commit(self, ParityGraphNode::new(self.initial_node.state.clone(), Some(self.initial_node.key)));

        let mut index: FxHashMap<StateKey, u32> = FxHashMap::default();
        let mut expansion: u32 = 0;
        let mut row_index = 0;
        while has_row(self, row_index) {
            // the cost model looks one row ahead (stepjumps)
            has_row(self, row_index + 1);
            index.clear();
            let frontier = levels.back().unwrap();
            let mut row_nodes: Vec<BatchNode> = Vec::new();
            for (f, from) in frontier.iter().enumerate() {
                if from.pruned {
                    continue;
                }
                expansion += 1;
                for child_state in self.child_states(&from.state, row_index) {
                    let key = child_state.to_key();
                    let to_index = *index.entry(key).or_insert_with(|| {
                        row_nodes.push(BatchNode::new(child_state, key));
                        (row_nodes.len() - 1) as u32
                    });
                    let to = &mut row_nodes[to_index as usize];
                    if to.expanded_by == expansion {
                        continue;
                    }
                    to.expanded_by = expansion;
                    let costs = self.cost_calc.get_action_cost(&from.state, &to.state, &self.notedata_rows, row_index);
                    let old_rank = if to.reached { frontier[to.parent as usize].rank } else { 0 };
                    BatchNode::relax(to, from, f as u32, old_rank, &costs, row_index as i64 - 1);
                }
            }
            if row_nodes.is_empty() {
                return None;
            }
            if self.turn_pruning {
                BatchNode::prune_turn_memory(&mut row_nodes);
            }
            let mut order: Vec<usize> = (0..row_nodes.len()).filter(|&i| !row_nodes[i].pruned).collect();
            order.sort_by(|&a, &b| {
                let (a, b) = (&row_nodes[a], &row_nodes[b]);
                frontier[a.parent as usize]
                    .rank
                    .cmp(&frontier[b.parent as usize].rank)
                    .then_with(|| compare_states(&a.state, &b.state))
            });
            for (rank, i) in order.into_iter().enumerate() {
                row_nodes[i].rank = rank as u32;
            }
            levels.push_back(row_nodes);

            if row_index + 1 >= committed + 2 * k {
                let target = row_index - k;
                let mut anchor = best(levels.back().unwrap(), row_index as i64).parent;
                for r in (target + 1..=row_index).rev() {
                    anchor = levels[r + 1 - base][anchor as usize].parent;
                }
                commit_through(self, &mut commit, &levels, base, &mut committed, target, anchor);
                let frontier_level = row_index + 1 - base;
                for i in 0..levels[frontier_level].len() {
                    if levels[frontier_level][i].pruned {
                        continue;
                    }
                    let mut x = i as u32;
                    for r in (target + 1..=row_index).rev() {
                        x = levels[r + 1 - base][x as usize].parent;
                    }
                    if x != anchor {
                        levels[frontier_level][i].pruned = true;
                    }
                }
                // rows before `committed` are never read again
                while base < committed + 1 {
                    levels.pop_front();
                    base += 1;
                }
            }
            row_index += 1;
        }
        let end = best(levels.back().unwrap(), row_index as i64 - 1);
        if row_index > committed {
            commit_through(self, &mut commit, &levels, base, &mut committed, row_index - 1, end.parent);
        }
        Some(end.cost)
    }

    // The children of a best-path node, as compute() leaves them: the edges
    // from `node` into row `row_index` (the node's row + 1) with their costs.
    fn set_path_children(&mut self, node: &mut ParityGraphNode, row_index: usize) {
        node.children.clear();
        if row_index >= self.notedata_rows.len() {
            return;
        }
        for state in self.child_states(&node.state, row_index) {
            let key = state.to_key();
            if node.children.iter().any(|(k, _)| *k == key) {
                continue;
            }
            let costs = self.cost_calc.get_action_cost(&node.state, &state, &self.notedata_rows, row_index);
            node.children.push((key, costs));
        }
    }

    fn build_result(rows: &Rows, layout: &StageLayout, best_nodes: &[&ParityGraphNode]) -> ParityComputeData {
        let mut parity_labels: HashMap<String, Foot> = HashMap::new();
        let mut label_rows: HashMap<String, usize> = HashMap::new();

        // Per-hold ownership timeline: which foot covers each hold body over its
        // lifetime, keyed like parityLabels by the head note ("beat-col").
        let mut hold_ownership: HashMap<String, Vec<HoldOwner>> = HashMap::new();

        for (idx, row) in rows.iter().enumerate() {
            let best_option = best_nodes[idx + 1];
            let previous = &best_nodes[idx].state.combined_columns;
            for col in 0..layout.column_count {
                let foot = best_option.state.combined_columns[col];
                if foot == NONE {
                    continue;
                }
                // holdTails excluded: an "owner change" on the release row is the
                // foot leaving, not a takeover (a roll re-tapped before it ends
                // is one, its entry halfway between the rows).
                if let Some(hold) = row.holds[col] {
                    let roll_takeover = idx > 0
                        && hold.note_type == NoteType::Roll
                        && previous[col] != NONE
                        && previous[col] != foot
                        && previous[col] != OTHER_PART_OF_FOOT(foot);
                    if !row.has_hold_tail(col) || roll_takeover {
                        let beat = if roll_takeover { (rows[idx - 1].beat + row.beat) / 2.0 } else { row.beat };
                        let key = format!("{}-{}", to_fixed(hold.beat, 3), col);
                        match hold_ownership.get_mut(&key) {
                            None => {
                                hold_ownership.insert(key, vec![HoldOwner { beat: hold.beat, foot }]);
                            }
                            Some(timeline) => {
                                if timeline.last().unwrap().foot != foot {
                                    timeline.push(HoldOwner { beat, foot });
                                }
                            }
                        }
                    }
                }
                let Some(note) = row.notes[col] else { continue };
                let key = format!("{}-{}", to_fixed(note.beat, 3), col);
                parity_labels.insert(key.clone(), foot);
                label_rows.insert(key.clone(), idx);
                if is_hold_note(note) {
                    hold_ownership.insert(key, vec![HoldOwner { beat: row.beat, foot }]);
                }
            }
        }

        // Keep only holds whose owner changes mid-hold
        hold_ownership.retain(|_, timeline| timeline.len() >= 2);

        let states = best_nodes.iter().map(|node| node.state.clone()).collect();

        let row_stats = calculate_row_stats(best_nodes, rows, layout);

        let row_timestamps = rows.iter().map(|row| RowTimestamp { beat: row.beat, second: row.second }).collect();

        ParityComputeData {
            parity_labels,
            label_rows,
            hold_ownership,
            states,
            row_timestamps,
            tech_rows: row_stats.tech_rows,
            mine_rows: row_stats.mine_rows,
            roll_taps: row_stats.roll_taps,
            tech_errors: row_stats.tech_errors,
            tech_counts: row_stats.tech_counts,
            tech_error_counts: row_stats.tech_error_counts,
            facing_rows: row_stats.facing_rows,
            candles: row_stats.candles,
        }
    }

    // Generates the rows for the given range of beats. The batch path starts
    // from no rows, so the reference's splice into existing rows and its
    // update of the row after the range do nothing here; row ids
    // (rowToKey) only distinguish rows and are not needed.
    pub fn recalculate_rows(&mut self, start_beat: f64, end_beat: f64, notedata: &'a [NotedataEntry]) {
        let (note_start_idx, note_end_idx) = self.note_range(notedata, start_beat, end_beat);
        let mut builder = self.row_builder(notedata, note_start_idx);
        let mut rows = Rows::default();
        for note in js_slice(notedata, note_start_idx, note_end_idx) {
            if let Some(row) = builder.add(note) {
                rows.push(row);
            }
        }
        if let Some(row) = builder.finish() {
            rows.push(row);
        }
        self.notedata_rows = rows;
    }

    fn note_range(&self, notedata: &[NotedataEntry], start_beat: f64, end_beat: f64) -> (i64, i64) {
        note_range(notedata, start_beat, end_beat)
    }

    // Builds rows from the notes at notedata[note_start_idx..] fed to add() in
    // order: add() returns a row once the next row's first note arrives, and
    // finish() the last one. Holds and mines before note_start_idx carry in.
    fn row_builder(&self, notedata: &'a [NotedataEntry], note_start_idx: i64) -> RowBuilder<'a> {
        let mut b = RowBuilder {
            notedata,
            roll_steps: HashMap::new(),
            active_holds: [None; MAX_COLUMNS],
            next_mines: [None; MAX_COLUMNS],
            next_fake_mines: [None; MAX_COLUMNS],
            mines: [None; MAX_COLUMNS],
            fake_mines: [None; MAX_COLUMNS],
            next_mine_rows: Vec::new(),
            mine_rows: Vec::new(),
            last_column_second: None,
            last_column_beat: None,
            notes: [None; MAX_COLUMNS],
            overrides: [None; MAX_COLUMNS],
            emitted: 0,
        };

        // Search backwards to populate holds + mines
        let mut cur_idx = note_start_idx - 1;
        let mut column_status = vec![0; self.layout.column_count];
        let mut fulfilled_columns = 0;
        while cur_idx >= 0 && fulfilled_columns < column_status.len() {
            let note = &notedata[cur_idx as usize];
            if note.warped {
                cur_idx -= 1;
                continue;
            }
            if column_status[note.col] == 1 {
                cur_idx -= 1;
                continue;
            }
            if note.note_type == NoteType::Mine && fulfilled_columns == 0 {
                if note.fake {
                    if b.next_fake_mines[note.col].is_none() {
                        b.fake_mines[note.col] = Some(note.second);
                    }
                } else {
                    if b.next_mines[note.col].is_none() {
                        b.mines[note.col] = Some(note.second);
                    }
                    match b.mine_rows.first_mut() {
                        Some(first) if is_same_second(Some(first.second), Some(note.second)) => {
                            first.columns.insert(0, note.col)
                        }
                        _ => b.mine_rows.insert(0, MineRow { beat: note.beat, second: note.second, columns: vec![note.col] }),
                    }
                }
                cur_idx -= 1;
                continue;
            }

            if note.fake {
                cur_idx -= 1;
                continue;
            }

            column_status[note.col] = 1;
            fulfilled_columns += 1;

            if is_hold_note(note) {
                b.active_holds[note.col] = Some(note);
            }

            cur_idx -= 1;
        }
        b
    }

    // Successor states of `state` on row `rowIndex`, in generation order.
    fn child_states(&mut self, state: &ParityState, row_index: usize) -> Vec<ParityState> {
        let mut permutations = self.get_possible_actions(row_index);
        let row = &self.notedata_rows[row_index];
        if row.overrides.iter().any(|p| p.is_some()) {
            permutations = self.filter_actions(row, permutations, &row.overrides);
        }
        let last_row = if row_index > 0 { self.notedata_rows.get(row_index - 1) } else { None };
        let last_of_chart = row_index == self.notedata_rows.len() - 1;
        let mut states: Vec<ParityState> = Vec::new();
        for permutation in permutations.iter() {
            let mut base_state = self.init_result_state(state, row, permutation);
            if !apply_releases(state, last_row, row, &mut base_state, last_of_chart) {
                continue;
            }
            for new_state in self.stance_variants(state, row, base_state) {
                let crosses = self.layout.crossed_feet(&new_state);
                let forward = if new_state.facing != facing::FORWARD && !crosses.left_on_right && !crosses.right_on_left {
                    Some(new_state.clone_with_facing(facing::FORWARD))
                } else {
                    None
                };
                states.push(new_state);
                if let Some(f) = forward {
                    states.push(f);
                }
            }
        }
        if state.facing == facing::FORWARD {
            for s in states.iter_mut() {
                if s.facing == facing::FORWARD {
                    continue;
                }
                for &c in &self.layout.side_arrows {
                    let a = s.action[c as usize];
                    if row.notes[c as usize].is_none_or(|n| n.note_type != NoteType::Roll) || a == NONE {
                        continue;
                    }
                    let left = a == LEFT_HEEL || a == LEFT_TOE;
                    if left == self.layout.right_arrows.contains(&c) {
                        s.crossed_onto_roll = c;
                    }
                }
            }
        }
        states
    }

    fn calculate_permute_column_key(&self, row: &Row) -> u32 {
        let mut s = 0u32;
        for i in 0..self.layout.column_count {
            if row.notes[i].is_some() {
                s |= 1 << i;
            } else if row.holds[i].is_some() {
                s |= 1 << (i + MAX_COLUMNS);
            }
        }
        s
    }

    fn get_possible_actions(&mut self, row_index: usize) -> Rc<Vec<Action>> {
        let row = &self.notedata_rows[row_index];
        let cache_key = self.calculate_permute_column_key(row);
        if !self.permute_cache.contains_key(&cache_key) {
            let mut columns = [UNDEFINED_FOOT; MAX_COLUMNS];
            for c in columns.iter_mut().take(self.layout.column_count) {
                *c = NONE;
            }
            let permute_columns = self.generate_actions(row, columns, 0);
            self.permute_cache.insert(cache_key, Rc::new(permute_columns));
        }
        self.permute_cache[&cache_key].clone()
    }

    // Recursively generates all permutations of Foot positions given a Row
    fn generate_actions(&self, row: &Row, columns: Action, column: usize) -> Vec<Action> {
        if column >= self.layout.column_count {
            let mut left_heel_index: i8 = -1;
            let mut left_toe_index: i8 = -1;
            let mut right_heel_index: i8 = -1;
            let mut right_toe_index: i8 = -1;
            for i in 0..self.layout.column_count {
                match columns[i] {
                    LEFT_HEEL => left_heel_index = i as i8,
                    LEFT_TOE => left_toe_index = i as i8,
                    RIGHT_HEEL => right_heel_index = i as i8,
                    RIGHT_TOE => right_toe_index = i as i8,
                    _ => {}
                }
            }
            if (left_heel_index == -1 && left_toe_index != -1) || (right_heel_index == -1 && right_toe_index != -1) {
                return Vec::new();
            }
            if left_heel_index != -1 && left_toe_index != -1 && !self.layout.bracket_check(left_heel_index, left_toe_index) {
                return Vec::new();
            }
            if right_heel_index != -1
                && right_toe_index != -1
                && !self.layout.bracket_check(right_heel_index, right_toe_index)
            {
                return Vec::new();
            }
            return vec![columns];
        }
        let mut permutations = Vec::new();
        if row.notes[column].is_some() || row.holds[column].is_some() {
            for foot in FEET {
                if columns[..self.layout.column_count].contains(&foot) {
                    continue;
                }
                let mut new_columns = columns;
                new_columns[column] = foot;
                permutations.extend(self.generate_actions(row, new_columns, column + 1));
            }
            // a hold body may be released (child_states decides when)
            if row.notes[column].is_none() {
                permutations.extend(self.generate_actions(row, columns, column + 1));
            }
            return permutations;
        }
        self.generate_actions(row, columns, column + 1)
    }

    // Apply overrides to the permuted columns (only use permutations that actually match the overrides)
    fn filter_actions(
        &self,
        _row: &Row,
        permute_columns: Rc<Vec<Action>>,
        overrides: &[Option<FootOverride>; MAX_COLUMNS],
    ) -> Rc<Vec<Action>> {
        // Check for invalid overrides
        let mut counts = [0u32; FEET.len() + 1];
        let mut left = 0;
        let mut right = 0;
        for foot in overrides.iter().flatten() {
            match foot {
                FootOverride::Foot(f) => counts[*f as usize] += 1,
                FootOverride::Left => left += 1,
                FootOverride::Right => right += 1,
            }
        }
        for count in counts.iter().take(FEET.len()).skip(1) {
            if *count > 1 {
                return permute_columns;
            }
        }
        if left + counts[LEFT_HEEL as usize] + counts[LEFT_TOE as usize] > 2
            || right + counts[RIGHT_HEEL as usize] + counts[RIGHT_TOE as usize] > 2
        {
            return permute_columns;
        }
        let updated_columns: Vec<Action> = permute_columns
            .iter()
            .filter(|pc| {
                for c in 0..self.layout.column_count {
                    let Some(note_override) = overrides[c] else { continue };
                    match note_override {
                        FootOverride::Foot(f) => {
                            if pc[c] != f {
                                return false;
                            }
                        }
                        FootOverride::Left => {
                            if pc[c] != LEFT_HEEL && pc[c] != LEFT_TOE {
                                return false;
                            }
                        }
                        FootOverride::Right => {
                            if pc[c] != RIGHT_HEEL && pc[c] != RIGHT_TOE {
                                return false;
                            }
                        }
                    }
                }
                true
            })
            .copied()
            .collect();

        if updated_columns.is_empty() {
            return permute_columns;
        }
        Rc::new(updated_columns)
    }

    // Creates the resulting state after applying the action to the initial state
    pub fn init_result_state(&self, initial_state: &ParityState, row: &Row, action: &Action) -> ParityState {
        let mut result_state = ParityState::new(row.second, row.beat, action, [-1; 5]);
        let column_count = self.layout.column_count;

        // Merge initial + result position
        for i in 0..column_count {
            result_state.combined_columns[i] = NONE;
            let a = action[i];
            if a == NONE {
                continue;
            }
            result_state.foot_columns[a as usize] = i as i8;
            result_state.combined_columns[i] = a;
            if row.holds[i].is_none() {
                result_state.moved_feet.add(a);
            } else if initial_state.combined_columns[i] != a
                // TODO: trying to work around engine limitation where toes are only present during brackets
                && initial_state.combined_columns[i] != OTHER_PART_OF_FOOT(a)
            {
                result_state.moved_feet.add(a);
            }
            if row.holds[i].is_some() {
                result_state.hold_feet.add(a);
            }
        }
        // A foot holding with one part keeps its other part where the stance
        // left it, in the orientation it had. Dropped once the panel is taken.
        for (heel, toe) in [(LEFT_HEEL, LEFT_TOE), (RIGHT_HEEL, RIGHT_TOE)] {
            let hc = result_state.foot_columns[heel as usize];
            if hc == -1 || result_state.foot_columns[toe as usize] != -1 {
                continue;
            }
            if row.holds[hc as usize].is_none() {
                continue;
            }
            let ih = initial_state.foot_columns[heel as usize];
            let it = initial_state.foot_columns[toe as usize];
            // the free part's panel, if it had one, and whether the other foot took it
            let free_col = if ih == hc {
                it
            } else if it == hc {
                ih
            } else {
                -1
            };
            let taken = free_col != -1 && result_state.combined_columns[free_col as usize] != NONE;
            if ih == hc && it != -1 && it != hc && !taken {
                result_state.foot_columns[toe as usize] = it;
                result_state.combined_columns[it as usize] = toe;
            } else if it == hc && ih != -1 && ih != hc && !taken {
                result_state.foot_columns[toe as usize] = hc;
                result_state.foot_columns[heel as usize] = ih;
                result_state.combined_columns[hc as usize] = toe;
                result_state.combined_columns[ih as usize] = heel;
                result_state.action[hc as usize] = toe;
                result_state.hold_feet.delete(heel);
                result_state.hold_feet.add(toe);
            }
        }
        // Fill in previous position, except for a foot a mine passed under: it
        // lifted off to the center (a ghost step) and is planted nowhere. A part
        // whose column another foot took is lifted and keeps no column of record.
        for (heel, toe) in [(LEFT_HEEL, LEFT_TOE), (RIGHT_HEEL, RIGHT_TOE)] {
            if result_state.foot_columns[heel as usize] != -1 || dodges_mine(initial_state, row, heel) {
                continue;
            }
            for part in [heel, toe] {
                let prev_col = initial_state.foot_columns[part as usize];
                if prev_col == -1 {
                    continue;
                }
                if result_state.combined_columns[prev_col as usize] == NONE {
                    result_state.foot_columns[part as usize] = prev_col;
                    result_state.combined_columns[prev_col as usize] = part;
                }
            }
        }
        // Travel bookkeeping: a foot traveled if it pressed a column it wasn't
        // already occupying (re-presses move without traveling).
        for (heel, toe) in [(LEFT_HEEL, LEFT_TOE), (RIGHT_HEEL, RIGHT_TOE)] {
            let old_cols = [initial_state.foot_columns[heel as usize], initial_state.foot_columns[toe as usize]];
            for c in 0..column_count {
                if action[c] != heel && action[c] != toe {
                    continue;
                }
                if !old_cols.contains(&(c as i8)) {
                    result_state.traveled_feet.add(heel);
                    break;
                }
            }
        }

        // Hover: a foot standing on one panel remembers the adjacent panel its
        // free part trails over.
        for (heel, toe) in [(LEFT_HEEL, LEFT_TOE), (RIGHT_HEEL, RIGHT_TOE)] {
            result_state.hover[heel as usize] = -1;
            result_state.hover_pivot[heel as usize] = false;
            if !self.hover_enabled {
                continue;
            }
            let hc = result_state.foot_columns[heel as usize];
            let tc = result_state.foot_columns[toe as usize];
            if (hc == -1) == (tc == -1) {
                continue;
            }
            let b = if hc != -1 { hc } else { tc };
            let combined = result_state.combined_columns;
            let free = |c: i8| c != -1 && c != b && combined[c as usize] == NONE;
            let ih = initial_state.foot_columns[heel as usize];
            let it = initial_state.foot_columns[toe as usize];
            if result_state.traveled_feet.has(heel) {
                let from = [ih, it].into_iter().find(|&a| free(a) && self.layout.bracket_check(a, b));
                if let Some(from) = from {
                    result_state.hover[heel as usize] = from;
                }
            } else if free(initial_state.hover[heel as usize]) {
                result_state.hover[heel as usize] = initial_state.hover[heel as usize];
                result_state.hover_pivot[heel as usize] = initial_state.hover_pivot[heel as usize];
            } else if ih != -1 && it != -1 && row.holds[b as usize].is_some() {
                // the planted free part was taken this row: the foot re-orients on
                // the hold towards its other neighbour
                for c in 0..column_count as i8 {
                    if free(c) && self.layout.bracket_check(c, b) {
                        result_state.hover[heel as usize] = c;
                        result_state.hover_pivot[heel as usize] = true;
                        break;
                    }
                }
            }
        }

        self.orient(initial_state, &mut result_state);
        result_state
    }

    // Alternative result states for a row in a bracket phrase (both feet on two
    // panels each): a foot that re-pressed one of its panels and would collapse
    // to it keeps the other part planted instead.
    pub fn stance_variants(&self, initial_state: &ParityState, row: &Row, base: ParityState) -> Vec<ParityState> {
        let mut variants = vec![base];
        let pressed = (0..self.layout.column_count)
            .filter(|&c| row.notes[c].is_some() || (row.holds[c].is_some() && !row.has_hold_tail(c)))
            .count();
        if !self.keep_stance_all_covered || initial_state.foot_columns[1..].iter().any(|&c| c == -1) || pressed < 3 {
            return variants;
        }
        for (heel, toe) in [(LEFT_HEEL, LEFT_TOE), (RIGHT_HEEL, RIGHT_TOE)] {
            let bh = variants[0].foot_columns[heel as usize];
            let bt = variants[0].foot_columns[toe as usize];
            if (bh == -1) == (bt == -1) {
                continue;
            }
            let c = if bh != -1 { bh } else { bt };
            if row.holds[c as usize].is_some() {
                continue;
            }
            let ih = initial_state.foot_columns[heel as usize];
            let it = initial_state.foot_columns[toe as usize];
            if c != ih && c != it {
                continue;
            }
            let d = if c == ih { it } else { ih };
            let part_at_c = if c == ih { heel } else { toe };
            let part_at_d = if c == ih { toe } else { heel };
            let snapshot = variants.len();
            for vi in 0..snapshot {
                let v0 = &variants[vi];
                if v0.combined_columns[d as usize] != NONE || v0.released[d as usize].is_some() {
                    continue;
                }
                let mut v = v0.clone_with_facing(v0.facing);
                let pressed = v.action[c as usize];
                v.action[c as usize] = part_at_c;
                v.combined_columns[c as usize] = part_at_c;
                v.combined_columns[d as usize] = part_at_d;
                v.foot_columns[part_at_c as usize] = c;
                v.foot_columns[part_at_d as usize] = d;
                if pressed != part_at_c {
                    v.moved_feet.delete(pressed);
                    v.moved_feet.add(part_at_c);
                }
                v.hover[heel as usize] = -1;
                v.hover_pivot[heel as usize] = false;
                self.orient(initial_state, &mut v);
                variants.push(v);
            }
        }
        variants
    }

    // Front foot and facing of a result state from its foot positions.
    fn orient(&self, initial_state: &ParityState, result_state: &mut ParityState) {
        let left_pos = self.layout.average_point(result_state.left_heel(), result_state.left_toe());
        let right_pos = self.layout.average_point(result_state.right_heel(), result_state.right_toe());

        if left_pos.y > right_pos.y {
            result_state.front_foot = Some(LEFT_HEEL);
        } else if right_pos.y > left_pos.y {
            result_state.front_foot = Some(RIGHT_HEEL);
        } else {
            result_state.front_foot = initial_state.front_foot;
        }

        let lifted = |s: &ParityState, heel: Foot| {
            s.foot_columns[heel as usize] == -1 && s.foot_columns[OTHER_PART_OF_FOOT(heel) as usize] == -1
        };
        let one_lifted = lifted(result_state, LEFT_HEEL) || lifted(result_state, RIGHT_HEEL);
        let direction =
            |s: &ParityState| if s.front_foot == Some(LEFT_HEEL) { facing::RIGHT } else { facing::LEFT };

        result_state.facing = initial_state.facing;
        result_state.facing_provisional = false;
        if result_state.facing == facing::FORWARD {
            let crosses = self.layout.crossed_feet(result_state);
            if crosses.left_on_right || crosses.right_on_left {
                result_state.facing = direction(result_state);
                // with a foot in the air the front foot is the previous row's: the
                // direction is a guess until that foot lands
                result_state.facing_provisional = one_lifted;
            }
        } else if initial_state.facing_provisional && !one_lifted {
            // the lifted foot has landed: read the direction from the feet
            let crosses = self.layout.crossed_feet(result_state);
            result_state.facing =
                if crosses.left_on_right || crosses.right_on_left { direction(result_state) } else { facing::FORWARD };
        } else {
            if initial_state.facing_provisional {
                result_state.facing_provisional = true;
            }
            // force uncross
            let facing_right = result_state.facing == facing::RIGHT;
            let facing_left = result_state.facing == facing::LEFT;

            let l = &self.layout;
            let left_heel_down = l.down_arrows.contains(&result_state.foot_columns[LEFT_HEEL as usize]);
            let left_heel_up = l.up_arrows.contains(&result_state.foot_columns[LEFT_HEEL as usize]);
            let right_heel_down = l.down_arrows.contains(&result_state.foot_columns[RIGHT_HEEL as usize]);
            let right_heel_up = l.up_arrows.contains(&result_state.foot_columns[RIGHT_HEEL as usize]);

            let left_cross_impossible = facing_left && (right_heel_down || left_heel_up);
            let right_cross_impossible = facing_right && (left_heel_down || right_heel_up);

            if right_cross_impossible || left_cross_impossible {
                result_state.facing = facing::FORWARD;
            }
        }
        result_state.last_turn = initial_state.last_turn;
        result_state.last_turn_end = initial_state.last_turn_end;
        if initial_state.facing != facing::FORWARD && result_state.facing == facing::FORWARD {
            result_state.last_turn = initial_state.facing;
            result_state.last_turn_end = result_state.second;
        }
        // forgotten once out of the window, so it does not split graph states
        if result_state.second - result_state.last_turn_end >= REVERSAL_WINDOW {
            result_state.last_turn = facing::FORWARD;
            result_state.last_turn_end = f64::NEG_INFINITY;
        }
    }

    // A hold body can carry takeover annotations (parity.holdOverrides): from
    // each annotated beat on, the given foot must cover the hold's column.
    fn apply_hold_overrides(row: &mut Row) {
        for col in 0..row.holds.len() {
            let Some(hold) = row.holds[col] else { continue };
            if row.overrides[col].is_some() {
                continue;
            }
            if let Some(o) = hold_override_at(hold, row.beat) {
                row.overrides[col] = Some(o);
            }
        }
    }

    pub fn reset(&mut self) {
        self.best_path = None;
        self.best_path_cost = 0.0;
        self.notedata_rows = Rows::default();
        self.permute_cache.clear();
        self.initial_node.children.clear();
    }
}

struct RowBuilder<'a> {
    notedata: &'a [NotedataEntry],
    roll_steps: HashMap<*const NotedataEntry, f64>,
    active_holds: [Option<&'a NotedataEntry>; MAX_COLUMNS],
    next_mines: [Option<f64>; MAX_COLUMNS],
    next_fake_mines: [Option<f64>; MAX_COLUMNS],
    mines: [Option<f64>; MAX_COLUMNS],
    fake_mines: [Option<f64>; MAX_COLUMNS],
    next_mine_rows: Vec<MineRow>,
    mine_rows: Vec<MineRow>,
    last_column_second: Option<f64>,
    last_column_beat: Option<f64>,
    notes: [Option<&'a NotedataEntry>; MAX_COLUMNS],
    overrides: [Option<FootOverride>; MAX_COLUMNS],
    emitted: usize,
}

impl<'a> RowBuilder<'a> {
    fn make_row(&mut self) -> Row<'a> {
        let last_column_second = self.last_column_second.unwrap();
        let last_column_beat = self.last_column_beat.unwrap();
        let mut holds: [Option<&'a NotedataEntry>; MAX_COLUMNS] = [None; MAX_COLUMNS];
        let mut hold_tails: u8 = 0;
        for col in 0..MAX_COLUMNS {
            let Some(hold) = self.active_holds[col] else { continue };
            if !(is_same_second(Some(hold.second), Some(last_column_second)) || hold.second > last_column_second) {
                holds[col] = Some(hold);
            }
            if (hold.beat + hold.hold - last_column_beat).abs() <= 0.0005 {
                hold_tails |= 1 << hold.col;
            }
        }
        let mut roll_steps = [None; MAX_COLUMNS];
        for (c, hold) in holds.iter().enumerate() {
            if let Some(hold) = hold.filter(|h| h.note_type == NoteType::Roll) {
                roll_steps[c] = Some(self.roll_step(hold));
            }
        }
        let mut row = Row {
            notes: self.notes,
            holds,
            hold_tails,
            roll_steps,
            mines: self.next_mines,
            fake_mines: self.next_fake_mines,
            mine_rows: std::mem::take(&mut self.next_mine_rows),
            second: last_column_second,
            beat: last_column_beat,
            overrides: self.overrides,
        };
        ParityInternals::apply_hold_overrides(&mut row);
        self.emitted += 1;
        row
    }

    fn roll_step(&mut self, hold: &NotedataEntry) -> f64 {
        if let Some(&step) = self.roll_steps.get(&(hold as *const _)) {
            return step;
        }
        let notedata = self.notedata;
        let is_step = |n: &NotedataEntry| !n.warped && !n.fake && n.note_type != NoteType::Mine;
        let mut step = f64::INFINITY;
        let (start, end) = note_range(notedata, hold.beat, hold.beat);
        let mut i = start - 1;
        while i >= 0 {
            let n = &notedata[i as usize];
            if is_step(n) && !is_same_second(Some(n.second), Some(hold.second)) {
                step = hold.second - n.second;
                break;
            }
            i -= 1;
        }
        let mut i = end.max(0) as usize;
        while i < notedata.len() {
            let n = &notedata[i];
            if is_step(n) && !is_same_second(Some(n.second), Some(hold.second)) {
                step = math_min(step, n.second - hold.second);
                break;
            }
            i += 1;
        }
        self.roll_steps.insert(hold as *const _, step);
        step
    }

    fn add(&mut self, note: &'a NotedataEntry) -> Option<Row<'a>> {
        if note.warped {
            return None;
        }
        if note.note_type == NoteType::Mine {
            if is_same_second(Some(note.second), self.last_column_second) && self.emitted > 0 {
                if note.fake {
                    self.next_fake_mines[note.col] = Some(note.second);
                } else {
                    self.next_mines[note.col] = Some(note.second);
                    push_mine(&mut self.next_mine_rows, note);
                }
            } else if note.fake {
                self.fake_mines[note.col] = Some(note.second);
            } else {
                self.mines[note.col] = Some(note.second);
                push_mine(&mut self.mine_rows, note);
            }
            return None;
        }
        if note.fake {
            return None;
        }
        let mut row = None;
        if !is_same_second(self.last_column_second, Some(note.second)) {
            if self.last_column_second.is_some() && self.last_column_beat.is_some() {
                row = Some(self.make_row());
            }
            self.last_column_second = Some(note.second);
            self.last_column_beat = Some(note.beat);
            self.notes = [None; MAX_COLUMNS];
            self.overrides = [None; MAX_COLUMNS];
            self.next_mines = self.mines;
            self.next_fake_mines = self.fake_mines;
            self.next_mine_rows = std::mem::take(&mut self.mine_rows);
            self.mines = [None; MAX_COLUMNS];
            self.fake_mines = [None; MAX_COLUMNS];
            for hold in self.active_holds.iter_mut() {
                if let Some(h) = hold {
                    if math_round(note.beat * 48.0) > math_round((h.beat + h.hold) * 48.0) {
                        *hold = None;
                    }
                }
            }
        }
        self.notes[note.col] = Some(note);
        if let Some(o) = note.parity.as_ref().and_then(|p| p.override_) {
            if o.truthy() {
                self.overrides[note.col] = Some(o);
            }
        }
        if is_hold_note(note) {
            self.active_holds[note.col] = Some(note);
        }
        row
    }

    fn finish(&mut self) -> Option<Row<'a>> {
        if self.notes.iter().any(|n| n.is_some()) { Some(self.make_row()) } else { None }
    }
}

fn note_range(notedata: &[NotedataEntry], start_beat: f64, end_beat: f64) -> (i64, i64) {
    get_range_in_sorted_array(notedata, math_round(start_beat * 48.0), math_round(end_beat * 48.0), |a| {
        math_round(a.beat * 48.0)
    })
}

fn release_window(hold: &NotedataEntry) -> f64 {
    if hold.note_type == NoteType::Roll { ROLL_RELEASE_WINDOW } else { HOLD_RELEASE_WINDOW }
}

fn same_hold(a: Option<&NotedataEntry>, b: &NotedataEntry) -> bool {
    a.is_some_and(|a| std::ptr::eq(a, b))
}

// A hold or roll with no foot on it after this row is released. A new
// release needs a foot that covered it on the previous row to leave it (a
// hold not on its tail row; leaving a roll on its tail row is free); a
// release lasts while its window does. False for a state that is invalid or
// the duplicate of a covered one.
fn apply_releases(
    initial_state: &ParityState,
    last_row: Option<&Row>,
    row: &Row,
    result_state: &mut ParityState,
    last_of_chart: bool,
) -> bool {
    // a hold that ends before this row with no foot on it must end within its window
    for c in 0..MAX_COLUMNS {
        let Some(since) = initial_state.released[c] else { continue };
        let Some(last_row) = last_row else { continue };
        let Some(hold) = last_row.holds[c] else { continue };
        if same_hold(row.holds[c], hold) {
            continue;
        }
        let end = hold.beat + hold.hold;
        let end_second =
            last_row.second + ((end - last_row.beat) / (row.beat - last_row.beat)) * (row.second - last_row.second);
        if end_second - since > release_window(hold) + SECOND_EPSILON {
            return false;
        }
    }
    for c in 0..row.holds.len() {
        let Some(hold) = row.holds[c] else { continue };
        if result_state.combined_columns[c] != NONE {
            if result_state.action[c] == NONE {
                return false;
            }
            continue;
        }
        let since = if last_row.is_some_and(|l| same_hold(l.holds[c], hold)) { initial_state.released[c] } else { None };
        if let Some(since) = since {
            if row.second - since > release_window(hold) + SECOND_EPSILON {
                return false;
            }
            result_state.released[c] = Some(since);
        } else if initial_state.combined_columns[c] != NONE
            && (hold.note_type == NoteType::Roll || !row.has_hold_tail(c))
            && hold.second < initial_state.second + SECOND_EPSILON
        {
            result_state.released[c] = Some(row.second);
        } else {
            return false;
        }
        // after the last row nobody steps back on: the hold must end within the window (tempo of the last gap)
        if let (true, Some(last_row)) = (last_of_chart, last_row) {
            let end = hold.beat + hold.hold;
            let end_second =
                row.second + ((end - row.beat) / (row.beat - last_row.beat)) * (row.second - last_row.second);
            if end_second - result_state.released[c].unwrap() > release_window(hold) + SECOND_EPSILON {
                return false;
            }
        }
    }
    true
}

// a foot standing on a panel whose mine passed since the last row lifts off
// it (MD); a foot holding that panel is not affected
fn dodges_mine(initial_state: &ParityState, row: &Row, heel: Foot) -> bool {
    [heel, OTHER_PART_OF_FOOT(heel)].iter().any(|&part| {
        let col = initial_state.foot_columns[part as usize];
        col != -1 && row.mines[col as usize].is_some() && row.holds[col as usize].is_none()
    })
}

fn push_mine(list: &mut Vec<MineRow>, note: &NotedataEntry) {
    match list.last_mut() {
        Some(last) if is_same_second(Some(last.second), Some(note.second)) => last.columns.push(note.col),
        _ => list.push(MineRow { beat: note.beat, second: note.second, columns: vec![note.col] }),
    }
}

fn is_same_second(second1: Option<f64>, second2: Option<f64>) -> bool {
    match (second1, second2) {
        (Some(a), Some(b)) => (a - b).abs() < SECOND_EPSILON,
        _ => false,
    }
}

/// `Array.prototype.slice(start, end)` for non-negative arguments.
fn js_slice<T>(array: &[T], start: i64, end: i64) -> &[T] {
    let len = array.len() as i64;
    let s = start.clamp(0, len);
    let e = end.clamp(0, len);
    if s >= e {
        &array[0..0]
    } else {
        &array[s as usize..e as usize]
    }
}

fn get_range_in_sorted_array<T>(array: &[T], start: f64, end: f64, index: impl Fn(&T) -> f64) -> (i64, i64) {
    if array.is_empty() {
        return (0, 0);
    }
    let at = |i: i64| -> Option<&T> { if i < 0 { None } else { array.get(i as usize) } };
    // array[i] past the end makes the reference throw
    let idx_at = |i: i64| index(at(i).expect("range index out of bounds"));

    let mut start_idx = bsearch(array, start, &index);
    if idx_at(start_idx) < start {
        start_idx += 1;
    }
    while at(start_idx - 1).is_some_and(|a| index(a) == start) {
        start_idx -= 1;
    }

    let mut end_idx = bsearch(array, end, &index);
    if idx_at(end_idx) > end {
        end_idx -= 1;
    }
    while at(end_idx + 1).is_some_and(|a| index(a) == end) {
        end_idx += 1;
    }

    (start_idx, end_idx + 1)
}

fn bsearch<T>(arr: &[T], value: f64, property: &impl Fn(&T) -> f64) -> i64 {
    if arr.is_empty() {
        return -1;
    }
    let len = arr.len() as i64;
    let p = |i: i64| property(&arr[i as usize]);
    if value >= p(len - 1) {
        let mut mid = len - 1;
        while mid > 0 && p(mid - 1) == value {
            mid -= 1;
        }
        return mid;
    }
    let mut low: i64 = 0;
    let mut high: i64 = len;
    while low <= high && low < len {
        let mut mid = (low + high) >> 1;
        if p(mid) == value {
            while mid > 0 && p(mid - 1) == value {
                mid -= 1;
            }
            return mid;
        }
        if p(mid) < value {
            low = mid + 1;
        }
        if p(mid) > value {
            high = mid - 1;
        }
    }
    high.max(0)
}
