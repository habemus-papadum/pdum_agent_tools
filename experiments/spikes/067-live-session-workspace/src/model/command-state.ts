import type {WireRecord} from './types';

/** Correlate explicit local interruption with native command cancellation by UUID. */
export function requestedCancellationIds(records: WireRecord[]): Set<string> {
  const requested = new Set(records.filter(record => record.direction === 'local' &&
    record.message?.type === 'local/interrupt').map(record => record.message.commandId).filter(Boolean));
  return new Set(records.filter(record => record.direction === 'in' && record.message?.type === 'command_lifecycle' &&
    record.message.state === 'cancelled' && requested.has(record.message.command_uuid)).map(record => record.message.command_uuid));
}

/** Result errors stay failures until matching native cancellation evidence arrives. */
export function claudeCommandOutcome(records: WireRecord[]) {
  const start = records.findLastIndex(record => record.direction === 'local' && record.message?.type === 'local/user');
  const commandId = start >= 0 ? records[start]!.message.id : undefined;
  const tail = start >= 0 ? records.slice(start) : records;
  const result = tail.findLast(record => record.direction === 'in' && record.message?.type === 'result')?.message;
  if (commandId && requestedCancellationIds(tail).has(commandId))
    return {status: 'interrupted' as const, result, commandId};
  if (!result) return {status: 'working' as const, result, commandId};
  return {status: result.is_error || result.subtype !== 'success' ? 'failed' as const : 'completed' as const, result, commandId};
}
