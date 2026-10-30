import type { TaskState } from './state.js';

export type LoopEvent =
  | 'implemented'
  | 'control-ok'
  | 'control-ko'
  | 'tests-green'
  | 'tests-red'
  | 'review-approved'
  | 'review-changes'
  /** Arrêt sans commit, porte `agent-arret` validée : un tour de correction comme des tests rouges. */
  | 'stopped'
  | 'fixed';

export const EXHAUSTED = '3 tours de correction épuisés';
const CONTROL_KO = 'contrôle du commit en échec';

type TaskDecision = {
  phase: TaskState['phase'];
  round: number;
  fixer: 'same' | 'strong' | 'none';
  blocked?: string;
};

/** Décision pure : ne modifie pas `t`. */
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

/** Revue globale et preflight : `round` est le tour écoulé, retourne le suivant. */
export function nextLoopRound(round: number): {
  round: number;
  fixer: 'new' | 'strong' | 'none';
  blocked?: string;
} {
  const next = round + 1;
  if (next > 3) return { round: next, fixer: 'none', blocked: EXHAUSTED };
  return { round: next, fixer: next === 3 ? 'strong' : 'new' };
}
