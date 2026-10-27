import {describe, expect, it} from 'vitest';
import {claudeCommandOutcome} from './command-state';
import {projectLive} from './projections';
import type {WireRecord} from './types';

function record(seq: number, direction: WireRecord['direction'], message: any): WireRecord {
  return {seq, direction, message, provider: 'claude', receivedAt: '2026-10-25T00:00:00Z'};
}
const start = record(1, 'local', {type: 'local/user', id: 'submitted', text: 'Run the test command'});
const interrupt = record(2, 'local', {type: 'local/interrupt', commandId: 'submitted'});
const result = record(3, 'in', {type: 'result', uuid: 'result', subtype: 'error_during_execution', is_error: true, errors: ['native execution diagnostic']});
const cancelled = record(4, 'in', {type: 'command_lifecycle', command_uuid: 'submitted', state: 'cancelled'});

describe('intent and cancellation evidence', () => {
  it('does not turn an error into successful cancellation on request acknowledgement alone', () => {
    expect(claudeCommandOutcome([start, interrupt, result]).status).toBe('failed');
    expect(claudeCommandOutcome([start, interrupt, result, cancelled]).status).toBe('interrupted');
  });
  it('does not hide an unsolicited failure or a different command cancellation', () => {
    expect(claudeCommandOutcome([start, result, cancelled]).status).toBe('failed');
    expect(claudeCommandOutcome([start, interrupt, result, {...cancelled, message: {...cancelled.message, command_uuid: 'other'}}]).status).toBe('failed');
  });
  it('shows the confirmed requested interruption while retaining the native error unchanged', () => {
    const projection = projectLive('claude', [start, interrupt, result, cancelled]);
    const row = projection.items.find(item => item.id === 'result')!;
    expect(row.state).toBe('cancelled'); expect(row.raw.is_error).toBe(true);
    expect(row.raw.errors).toEqual(['native execution diagnostic']);
  });
});
