import { describe, expect, it } from 'vitest';
import { nextLoopRound, nextTaskPhase } from '../../src/mission/loop.js';
import type { TaskState } from '../../src/mission/state.js';

const task = (phase: TaskState['phase'], round = 0): TaskState => ({
  n: 1, title: 't', testCommand: 'pnpm test', phase, round,
});

describe('nextTaskPhase', () => {
  it('implemented -> control', () => {
    expect(nextTaskPhase(task('implement'), 'implemented')).toEqual({ phase: 'control', round: 0, fixer: 'none' });
  });
  it('control-ok -> test', () => {
    expect(nextTaskPhase(task('control'), 'control-ok').phase).toBe('test');
  });
  it('control-ko -> blocked', () => {
    expect(nextTaskPhase(task('control', 1), 'control-ko')).toEqual({
      phase: 'control', round: 1, fixer: 'none', blocked: 'commit check failed',
    });
  });
  it('tests-green -> review', () => {
    expect(nextTaskPhase(task('test'), 'tests-green').phase).toBe('review');
  });
  it('tests-red -> fix, round +1, same', () => {
    expect(nextTaskPhase(task('test'), 'tests-red')).toEqual({ phase: 'fix', round: 1, fixer: 'same' });
  });
  it('review-approved -> done', () => {
    expect(nextTaskPhase(task('review'), 'review-approved').phase).toBe('done');
  });
  it('review-changes -> fix, round +1', () => {
    expect(nextTaskPhase(task('review'), 'review-changes')).toEqual({ phase: 'fix', round: 1, fixer: 'same' });
  });
  it('stopped (approved stop without a commit) -> fix, round +1, same rules as tests-red', () => {
    expect(nextTaskPhase(task('control'), 'stopped')).toEqual({ phase: 'fix', round: 1, fixer: 'same' });
    expect(nextTaskPhase(task('control', 2), 'stopped')).toEqual({ phase: 'fix', round: 3, fixer: 'strong' });
    expect(nextTaskPhase(task('control', 3), 'stopped')).toMatchObject({ round: 4, fixer: 'none', blocked: '3 correction rounds exhausted' });
  });
  it('fixed -> control', () => {
    expect(nextTaskPhase(task('fix', 1), 'fixed')).toEqual({ phase: 'control', round: 1, fixer: 'none' });
  });
  it('three red tests in a row give same, same, strong, then blocked', () => {
    let t = task('test');
    const out = [];
    for (let i = 0; i < 4; i++) {
      const r = nextTaskPhase(t, 'tests-red');
      out.push(r);
      t = { ...t, phase: r.blocked ? t.phase : 'test', round: r.round };
    }
    expect(out.map((r) => r.fixer)).toEqual(['same', 'same', 'strong', 'none']);
    expect(out[3]!.blocked).toBe('3 correction rounds exhausted');
    expect(out[3]!.phase).toBe('test');
  });
  it('a tests-red after a review-changes shares the same round counter', () => {
    const a = nextTaskPhase(task('review'), 'review-changes');
    const b = nextTaskPhase(task('test', a.round), 'tests-red');
    expect(b.round).toBe(2);
    expect(b.fixer).toBe('same');
  });
  it('review-changes at round 4 is blocked', () => {
    expect(nextTaskPhase(task('review', 3), 'review-changes').blocked).toBe('3 correction rounds exhausted');
  });
});

describe('nextLoopRound', () => {
  it('1-2 -> new, 3 -> strong', () => {
    expect(nextLoopRound(0)).toEqual({ round: 1, fixer: 'new' });
    expect(nextLoopRound(1)).toEqual({ round: 2, fixer: 'new' });
    expect(nextLoopRound(2)).toEqual({ round: 3, fixer: 'strong' });
  });
  it('nextLoopRound(3) blocks', () => {
    expect(nextLoopRound(3)).toEqual({ round: 4, fixer: 'none', blocked: '3 correction rounds exhausted' });
  });
});

