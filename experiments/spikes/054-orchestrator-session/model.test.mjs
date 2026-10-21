import assert from 'node:assert/strict';
import test from 'node:test';
import { fileView, makeExcerpt, makeSubmission, initialReceipt, advanceReceipt } from './model.mjs';

const request = (mode = 'steer', scenario = 'normal', excerpts = []) => makeSubmission({ mode, scenario, excerpts, text: 'Add the cancellation check.', settings: { model: 'gpt-6-luna', effort: 'low', tier: 'default' }, id: 'request-test' });

test('historical selection retains actual captured bytes when current content changes or disappears', () => {
  const excerpt = makeExcerpt(fileView('captured', 'changed'), [12, 13], 'Check cancellation here.', 'excerpt-test');
  assert.equal(excerpt.contentVersion, 'fixture:retry-v1');
  assert.equal(excerpt.resolvedPath, '/work/projects/relay/src/retry.ts');
  assert.equal(excerpt.text.includes('throwIfAborted'), false);
  assert.equal(fileView('current', 'changed').lines[12].includes('throwIfAborted'), true);
  assert.throws(() => makeExcerpt(fileView('current', 'missing'), [1, 2], '', 'missing'), /No source/);
  assert.equal(fileView('captured', 'missing').available, true);
});

test('frozen submission cannot be changed by later draft or excerpt edits', () => {
  const excerpts = [makeExcerpt(fileView('captured', 'normal'), [7, 12], 'Original comment', 'one')];
  const submission = request('queue', 'normal', excerpts);
  excerpts[0].comment = 'Later comment'; excerpts.length = 0;
  assert.equal(submission.excerpts[0].comment, 'Original comment');
  assert.equal(submission.settings.model, 'gpt-6-luna');
  assert.equal(request('steer').settings.model, 'gpt-6');
});

test('turn ended race does not reinterpret steering as a queued turn', () => {
  const receipt = advanceReceipt(initialReceipt(request('steer', 'turn-ended')));
  assert.equal(receipt.stage, 'not-applied');
  assert.equal(receipt.terminal, true);
  assert.equal(receipt.submission.mode, 'steer');
  assert.equal(advanceReceipt(receipt), receipt);
});

test('unknown acknowledgement remains unknown and has no automatic retry transition', () => {
  const receipt = advanceReceipt(initialReceipt(request('queue', 'unknown')));
  assert.equal(receipt.stage, 'unknown');
  assert.equal(advanceReceipt(receipt), receipt);
});

test('queue acceptance is distinct from starting the next turn', () => {
  const queued = advanceReceipt(initialReceipt(request('queue')));
  assert.equal(queued.stage, 'queued'); assert.equal(queued.terminal, false);
  assert.equal(advanceReceipt(queued).stage, 'turn-started');
});

test('explicit intent and content are required', () => {
  assert.throws(() => request('infer'), /explicit/);
  assert.throws(() => makeSubmission({ mode: 'steer', text: ' ', excerpts: [], settings: {}, scenario: 'normal' }), /prompt text/);
});
