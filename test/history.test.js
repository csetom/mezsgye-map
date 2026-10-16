/**
 * Undo/redo history tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { History } from '../src/history.js';

function clock() {
  let t = 0;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('undo and redo walk back and forth through snapshots', () => {
  const h = new History({ now: clock() });
  h.reset('A');
  h.record('B');
  h.record('C');
  assert.equal(h.undo(), 'B');
  assert.equal(h.undo(), 'A');
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), 'B');
  assert.equal(h.redo(), 'C');
  assert.equal(h.redo(), null);
});

test('a new edit after undo drops the redo branch', () => {
  const h = new History({ now: clock() });
  h.reset('A');
  h.record('B');
  h.undo();
  h.record('X');
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), 'A');
});

test('same-key edits close together coalesce; others do not', () => {
  const now = clock();
  const h = new History({ now, coalesceMs: 1000 });
  h.reset('');
  h.record('K', 'name');
  now.advance(200);
  h.record('Kö', 'name');
  now.advance(200);
  h.record('Köd', 'name');
  assert.equal(h.undo(), '', 'typing a name is one undo step');

  h.reset('');
  h.record('a', 'name');
  now.advance(5000);
  h.record('ab', 'name');
  assert.equal(h.undo(), 'a', 'a pause starts a new step');

  h.reset('');
  h.record('a', 'name');
  h.record('a+', 'notes');
  assert.equal(h.undo(), 'a', 'a different field starts a new step');
});

test('unchanged snapshots are ignored and the stack is capped', () => {
  const h = new History({ limit: 3, now: clock() });
  h.reset('0');
  assert.equal(h.record('0'), false);
  for (const s of ['1', '2', '3', '4', '5']) h.record(s);
  const seen = [];
  for (let s = h.undo(); s !== null; s = h.undo()) seen.push(s);
  assert.deepEqual(seen, ['4', '3', '2']);
});

test('dirty tracks the saved snapshot, including undoing back to it', () => {
  const h = new History({ now: clock() });
  h.reset('A');
  assert.equal(h.dirty, false);
  h.record('B');
  assert.equal(h.dirty, true);
  h.undo();
  assert.equal(h.dirty, false);
  h.redo();
  h.markSaved('B*');
  assert.equal(h.dirty, false);
  assert.equal(h.undo(), 'A');
  assert.equal(h.dirty, true);

  h.reset('N', { saved: false });
  assert.equal(h.dirty, true, 'a never-saved document stays dirty');
});
