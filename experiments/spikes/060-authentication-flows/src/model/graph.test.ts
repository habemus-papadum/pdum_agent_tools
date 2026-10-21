// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {flush} from 'solid-js';
import {cellHarness, resetControlSurface, whenReady} from '@habemus-papadum/aiui-viz/testing';
import {graph} from './graph';
import * as s from './store';
import {initialReceipt} from './auth';
afterEach(() => {resetControlSurface(); flush(() => s.receipt.set(initialReceipt()));});
it('preview responds to every declared choice without executing an operation', async () => {
  const h = cellHarness(() => graph());
  try {
    expect((await whenReady(h.cells.preview)).profile.id).toBe('local/codex-account');
    s.host.set('remote'); expect((await whenReady(h.cells.preview)).owner).toContain('workbench.remote');
    s.deviceAuth.set(true); expect((await whenReady(h.cells.preview)).command).toContain('--device-auth');
    s.strategy.set('api-key'); expect((await whenReady(h.cells.preview)).setup).toContain('--env OPENAI_API_KEY');
    s.apiKeyEnv.set('TEAM_PROVIDER_KEY'); expect((await whenReady(h.cells.preview)).setup).toContain('--env TEAM_PROVIDER_KEY');
    s.provider.set('claude'); expect((await whenReady(h.cells.preview)).setup).toContain('--api-key-env TEAM_PROVIDER_KEY');
    expect(s.receipt.get().attempt).toBe(0);
  } finally { h.dispose(); }
});
it('registered actions and progress cell use the same frozen receipt', async () => {
  const h = cellHarness(() => graph());
  try {
    await whenReady(h.cells.progress);
    flush(() => s.start.run());
    expect((await whenReady(h.cells.progress)).phase).toBe('waiting');
    s.host.set('remote'); await whenReady(h.cells.preview);
    expect((await whenReady(h.cells.progress)).plan?.profile.host).toBe('local');
    flush(() => s.advance.run()); await whenReady(h.cells.progress);
    flush(() => s.advance.run()); expect((await whenReady(h.cells.progress)).access).toBe('not-tested');
    flush(() => s.accessOutcome.set('denied'));
    flush(() => s.validate.run()); expect((await whenReady(h.cells.progress)).access).toBe('denied');
  } finally { h.dispose(); }
});
it('enum-only environment references cannot store a pasted credential', () => {
  expect(() => s.apiKeyEnv.set('sk-never-a-real-key')).toThrow();
  expect(s.apiKeyEnv.get()).toBe('OPENAI_API_KEY');
});
