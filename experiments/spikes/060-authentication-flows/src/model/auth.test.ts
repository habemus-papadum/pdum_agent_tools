import {describe, expect, it} from 'vitest';
import {advance, begin, cancel, fixtures, initialReceipt, initialSelection, operationPreview, validateAccess, validReference, type Selection} from './auth';

describe('source-grounded operation previews', () => {
  it('maps every provider/host/strategy fixture to its explicit owner and native root', () => {
    expect(fixtures).toHaveLength(12);
    for (const fixture of fixtures) {
      const p = operationPreview({...initialSelection, ...fixture});
      expect(p.command).toContain(`--profile-dir '${fixture.path}'`);
      expect(p.owner).toContain(fixture.hostLabel);
      expect(p.status).toContain('auth status');
      expect(p.remoteProposal).toBe(fixture.host === 'remote');
      expect(p.command).not.toContain('--remote');
    }
  });
  it('uses Codex copy-at-creation rather than inventing reuse auth configuration', () => {
    const p = operationPreview({...initialSelection, strategy: 'reuse-login'});
    expect(p.setup).toContain('profile create --from-codex-home');
    expect(p.setup).toContain('--copy-auth --auth chatgpt --no-interview');
    expect(p.setup).not.toContain('--auth reuse-login');
    expect(p.setupMeaning).toContain('target must not exist');
  });
  it('uses existing Codex API edit flags and rejects values that are not names', () => {
    const p = operationPreview({...initialSelection, strategy: 'api-key', apiKeyEnv: 'TEAM_OPENAI_KEY'});
    expect(p.setup).toContain('auth configure --no-interview --method api-key --env TEAM_OPENAI_KEY');
    for (const value of ['sk-example-value', 'x y', '$(echo secret)', '']) expect(validReference(value)).toBe(false);
    expect(operationPreview({...initialSelection, strategy: 'api-key', apiKeyEnv: 'sk-example-value'}).valid).toBe(false);
  });
  it('keeps Claude references in its existing creation contract', () => {
    const p = operationPreview({...initialSelection, provider: 'claude', strategy: 'api-key', apiKeyEnv: 'ANTHROPIC_API_KEY'});
    expect(p.setup).toContain('--auth api-key --api-key-env ANTHROPIC_API_KEY');
    expect(p.setupMeaning).toContain('existing-profile auth editing is not exposed');
    expect(p.command).not.toContain('auth configure');
    const reuse = operationPreview({...initialSelection, provider: 'claude', strategy: 'reuse-login'});
    expect(reuse.setup).toContain('--source-directory');
    expect(reuse.refresh).toContain('refresh is not managed');
  });
  it('limits native device auth to Codex', () => {
    expect(operationPreview({...initialSelection, deviceAuth: true}).command).toContain('--device-auth');
    expect(operationPreview({...initialSelection, provider: 'claude', deviceAuth: true}).command).not.toContain('--device-auth');
  });
});

describe('explicit synthetic outcomes', () => {
  it('requires a separate model access check after successful native status', () => {
    let r = begin(initialReceipt(), initialSelection, 'success');
    expect(() => validateAccess(r, 'passed')).toThrow('Observe native status');
    r = advance(r); expect(r.phase).toBe('returned'); expect(r.access).toBe('not-tested');
    r = advance(r); expect(r.phase).toBe('observed'); expect(r.presence).toBe('configuration observed'); expect(r.access).toBe('not-tested');
    r = validateAccess(r, 'denied'); expect(r.presence).toBe('configuration observed'); expect(r.access).toBe('denied');
    expect(advance(r)).toBe(r);
  });
  it('retains each provider’s different status claim', () => {
    for (const provider of ['codex', 'claude'] as const) {
      const r = advance(advance(begin(initialReceipt(), {...initialSelection, provider}, 'success')));
      expect(r.events.at(-1)).toContain(provider === 'codex' ? 'authenticated = "not checked"' : 'logged_in = true');
    }
  });
  it('freezes attempt identity and refuses replacement while it is pending', () => {
    const selection: Selection = {...initialSelection};
    const r = begin(initialReceipt(), selection, 'success'); selection.host = 'remote';
    expect(r.plan?.selection.host).toBe('local');
    expect(r.plan?.profile.host).toBe('local');
    expect(() => begin(r, selection, 'success')).toThrow('Finish or cancel');
  });
  it('distinguishes cancellation of local work from stopping remote observation', () => {
    expect(cancel(begin(initialReceipt(), initialSelection, 'success')).phase).toBe('cancelled');
    const remote = cancel(begin(initialReceipt(), {...initialSelection, host: 'remote'}, 'success'));
    expect(remote.phase).toBe('unknown'); expect(remote.presence).toBe('unknown'); expect(remote.events.at(-1)).toContain('unconfirmed');
  });
  it.each(['expired', 'failure', 'connection-lost'] as const)('keeps %s terminal with no implicit retry', scenario => {
    const r = advance(begin(initialReceipt(), initialSelection, scenario));
    expect(r.phase).toBe({expired: 'expired', failure: 'failed', 'connection-lost': 'unknown'}[scenario]);
    expect(advance(r)).toBe(r); expect(r.access).toBe('not-tested');
    expect(begin(r, initialSelection, 'success').attempt).toBe(2);
  });
});
