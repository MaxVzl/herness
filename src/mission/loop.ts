import type { TaskState } from './state.js';

export type LoopEvent =
  | 'implemented'
  | 'control-ok'
  | 'control-ko'
  | 'tests-green'
  | 'tests-red'
  | 'review-approved'
  | 'review-changes'
  /** Stopped without a commit, `agent-stopped` gate approved: a correction round, like red tests. */
  | 'stopped'
  | 'fixed';

export const EXHAUSTED = '3 correction rounds exhausted';
const CONTROL_KO = 'commit check failed';

type TaskDecision = {
  phase: TaskState['phase'];
  round: number;
  fixer: 'same' | 'strong' | 'none';
  blocked?: string;
};

/** Pure decision: does not modify `t`. */
export function nextTaskPhase(t: TaskState, ev: LoopEvent): TaskDecision {
  const go = (phase: TaskState['phase']): TaskDecision => ({ phase, round: t.round, fixer: 'none' });
  switch (ev) {
    case 'implemented': return go('control');
    case 'control-ok': return go('test');
    case 'control-ko': return { ...go(t.phase), blocked: CONTROL_KO };
    case 'tests-green': return go('review');
    case 'review-approved': return go('done');
    case 'fixed': return go('control');
    case 'tests-red':
    case 'review-changes':
    case 'stopped': {
      const round = t.round + 1;
      if (round > 3) return { phase: t.phase, round, fixer: 'none', blocked: EXHAUSTED };
      return { phase: 'fix', round, fixer: round === 3 ? 'strong' : 'same' };
    }
  }
}

/** Global review and preflight: `round` is the round just finished; returns the next one. */
export function nextLoopRound(round: number): {
  round: number;
  fixer: 'new' | 'strong' | 'none';
  blocked?: string;
} {
  const next = round + 1;
  if (next > 3) return { round: next, fixer: 'none', blocked: EXHAUSTED };
  return { round: next, fixer: next === 3 ? 'strong' : 'new' };
}
