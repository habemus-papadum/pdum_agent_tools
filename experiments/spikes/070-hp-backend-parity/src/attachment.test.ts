import { test } from 'node:test';
import { attachmentScenarios } from './attachment-scenarios.ts';

test('Two MessagePort clients replay, detach, rejoin, and continue without repeated actions', async () => { await attachmentScenarios(); });
