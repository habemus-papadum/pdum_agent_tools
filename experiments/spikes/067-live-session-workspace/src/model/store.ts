import {action, control, scope} from '@habemus-papadum/aiui-viz';
import {createController, endAllOwnedRuns, endOwnedRun, getConfiguration, getHistoryCatalogue, getHistoryChoice} from './controller';
import type {HistoryRef, Provider} from './types';

export const appScope = scope('live-session-workspace');
/** Provider for the next owned session; no outside process is attached. */
export const provider = control<Provider>({scope: appScope, value: 'codex', options: ['codex', 'claude']});
/** Existing working directory for the next session. Blank uses the visible lab default. */
export const cwd = control({scope: appScope, value: ''});
/** Draft for one new turn. Nothing is submitted while typing. */
export const draft = control({scope: appScope, value: ''});
/** Display live messages, a native saved-history read, or their comparison. */
export const view = control({scope: appScope, value: 'live', options: ['live', 'history', 'compare']});
/** Fold operation details while keeping the conversation readable. */
export const detail = control({scope: appScope, value: 'compact', options: ['compact', 'expanded']});
/** Keep the live conversation scrolled to its newest output. */
export const follow = control({scope: appScope, value: true});
/** Optional native record inspector. */
export const inspector = control({scope: appScope, value: false});
/** Explanatory notes sit outside the normal conversation flow. */
export const notes = control({scope: appScope, value: false});
/** Optional native-history or owned-runtime workbench beside the conversation. */
export const panel = control({scope: appScope, value: 'none', options: ['none', 'history', 'runs']});
/** Provider whose saved lab conversations are listed. This does not change a live session. */
export const historyProvider = control<Provider>({scope: appScope, value: 'codex', options: ['codex', 'claude']});
/** Filter the loaded native catalogue by title, identity or working directory. */
export const historySearch = control({scope: appScope, value: ''});
/** Continuing latest preserves identity; forking creates a new conversation at a selected native boundary. */
export const continuationKind = control({scope: appScope, value: 'resume', options: ['resume', 'fork']});
/** Exact provider-native turn/message boundary selected for a fork. */
export const branchPoint = control({scope: appScope, value: ''});
export const historyReference = appScope.durableSignal<HistoryRef | null>('history-reference', null);
export const historyRevision = appScope.durableSignal('history-revision', 0);
export const runsRevision = appScope.durableSignal('runs-revision', 0);
export const managementBusy = appScope.durableSignal('management-busy', false);
export const managementReceipt = appScope.durableSignal<unknown>('management-receipt', null);
const operation = appScope.durable('study-operation', () => ({mutating: false}));
export const selected = appScope.durableSignal('selected-item', '');
export const configurationRevision = appScope.durableSignal('configuration-revision', 0);
export const actionError = appScope.durableSignal('action-error', '');
export const controller = appScope.durable('controller', createController);
export const session = appScope.durableSignal('session', controller.state());
// The controller owns external events. This binding survives component/graph HMR;
// writing on a microtask also permits an immediate subscribe callback safely.
appScope.durable('controller-subscription', () => controller.subscribe(value => {
  queueMicrotask(() => session.set(value));
}));

function active() {
  const state = controller.state();
  return Boolean(state.run && state.phase !== 'ended');
}
async function perform(operation: () => Promise<void>) {
  actionError.set('');
  try { await operation(); }
  catch (error) { actionError.set(error instanceof Error ? error.message : String(error)); throw error; }
}

/** Read configuration/credential availability; never starts a provider process or prompt. */
export const refreshConfiguration = action({scope: appScope, name: 'refresh-configuration', group: 'setup', kind: 'read',
  run: () => configurationRevision.set(value => value + 1)});
/** Launch a new owned session in the chosen directory. Model requests begin only with send-turn. */
export const launch = action({scope: appScope, name: 'launch-session', group: 'session',
  params: {provider: 'Optional codex or claude', cwd: 'Optional existing directory', qualification: 'Optional test bounds; off for normal UI'},
  run: async args => {
    if (active() || controller.state().phase === 'launching') throw Error('End the current runtime before launching another session.');
    const choice = args?.provider ?? provider.get();
    if (choice !== 'codex' && choice !== 'claude') throw Error('Choose Codex or Claude.');
    const requested = String(args?.cwd ?? cwd.get()).trim();
    const directory = requested || (await getConfiguration()).defaultCwd;
    provider.set(choice); cwd.set(directory); view.set('live'); selected.set(''); follow.set(true);
    await perform(() => controller.launch({provider: choice, cwd: directory, qualification: args?.qualification === true}));
  }});
/** Submit one new turn to this live session. It does not steer or queue input during an active turn. */
export const send = action({scope: appScope, name: 'send-turn', group: 'conversation', params: {text: 'Optional prompt; otherwise the visible draft'},
  run: async args => {
    if (controller.state().phase !== 'ready') throw Error('Wait for the current turn, or interrupt it, before sending a new turn.');
    const text = String(args?.text ?? draft.get()).trim();
    if (!text) throw Error('Enter a prompt.');
    view.set('live'); follow.set(true);
    await perform(() => controller.send(text));
    if (draft.get().trim() === text) draft.set('');
  }});
/** Interrupt the current turn. This is distinct from ending the runtime or undoing tool effects. */
export const interrupt = action({scope: appScope, name: 'interrupt-turn', group: 'conversation', run: async () => {
  if (controller.state().phase !== 'working') throw Error('No active turn to interrupt.');
  await perform(() => controller.interrupt());
}});
/** Read this session's saved native history without resuming or submitting work. */
export const readHistory = action({scope: appScope, name: 'read-saved-history', group: 'history', kind: 'read', run: async () => {
  const state = controller.state();
  if (!state.run) throw Error('Launch a session first.');
  if (['launching', 'working', 'ending'].includes(state.phase)) throw Error('Read saved history after the current operation finishes.');
  await perform(() => controller.loadHistory());
}});
/** Stop the runtime owned by this study. Saved conversation data and local files are not rolled back. */
export const end = action({scope: appScope, name: 'end-runtime', group: 'session', run: async () => {
  if (!active()) throw Error('There is no owned runtime to end.');
  await perform(() => controller.end());
  runsRevision.set(value => value + 1);
  historyRevision.set(value => value + 1);
}});
/** Inspect one rendered item's native record. This never executes recorded content. */
export const inspectItem = action({scope: appScope, name: 'inspect-item', group: 'inspection', kind: 'read', params: {key: 'source:id from a projected item'},
  run: args => { selected.set(String(args?.key ?? '')); inspector.set(true); }});

/** Open and refresh the native saved-session catalogue. Reading never resumes a conversation. */
export const refreshHistory = action({scope: appScope, name: 'refresh-history', group: 'history', kind: 'read',
  params: {provider: 'Optional codex or claude'}, run: args => {
    if (args?.provider === 'codex' || args?.provider === 'claude') {
      if (historyReference.get()?.provider !== args.provider) {historyReference.set(null); branchPoint.set('');}
      historyProvider.set(args.provider);
    }
    panel.set('history'); historyRevision.set(value => value + 1);
  }});

/** Select a native conversation for inspection. The draft and active conversation stay unchanged.
 * @usage Pass a catalogue reference, or provider/sessionId/cwd. No continuation or prompt is submitted.
 */
export const selectHistory = action({scope: appScope, name: 'select-history', group: 'history', kind: 'read',
  params: {reference: 'Optional full catalogue reference', provider: 'codex or claude', sessionId: 'Native conversation ID', cwd: 'Optional source working directory'},
  run: async args => {
    const supplied = args?.reference as HistoryRef | undefined;
    const choice = args?.provider ?? supplied?.provider ?? historyProvider.get();
    if (choice !== 'codex' && choice !== 'claude') throw Error('Choose Codex or Claude history.');
    let reference = supplied;
    if (!reference) {
      const catalogue = await getHistoryCatalogue(choice);
      reference = catalogue.sessions.find(item => item.sessionId === args?.sessionId && (!args?.cwd || item.cwd === args.cwd));
    }
    if (!reference?.sessionId || !reference.cwd || reference.provider !== choice) throw Error('Choose a saved conversation from the native catalogue.');
    historyProvider.set(choice); historyReference.set(reference); branchPoint.set('');
    continuationKind.set('resume'); selected.set(''); panel.set('history');
  }});

/** Continue the selected native history in its recorded profile and working directory.
 * @usage kind=resume opens latest saved context; kind=fork requires an exact pointId from the native read.
 * The existing draft is preserved and remains unsent. This is not a filesystem restore.
 */
export const continueHistory = action({scope: appScope, name: 'continue-session', group: 'history',
  params: {kind: 'resume or fork', pointId: 'Required native boundary ID for fork', qualification: 'Optional bounded automated check'},
  run: async args => {
    if (operation.mutating) throw Error('A management action is already in progress.');
    if (active() || controller.state().phase === 'launching') throw Error('End this page’s current runtime before continuing a saved conversation.');
    const source = historyReference.get();
    if (!source) throw Error('Inspect a saved conversation first.');
    if (source.provider !== historyProvider.get()) throw Error('Inspect a conversation from the selected history provider before continuing.');
    const kind = args?.kind ?? continuationKind.get();
    if (kind !== 'resume' && kind !== 'fork') throw Error('Choose Resume latest or Fork from a point.');
    const pointId = String(args?.pointId ?? branchPoint.get());
    operation.mutating = true; managementBusy.set(true); managementReceipt.set(null);
    try {
      await perform(async () => {
        const chosen = await getHistoryChoice(source);
        const point = kind === 'fork' ? chosen.branchPoints.find(item => item.id === pointId) : undefined;
        if (kind === 'fork' && !point) throw Error('Select a supported native fork boundary.');
        provider.set(chosen.reference.provider); cwd.set(chosen.reference.cwd);
        view.set('live'); selected.set(''); follow.set(true);
        await controller.continueSession({source: chosen.reference, kind, point, qualification: args?.qualification === true});
        if (['ready', 'working'].includes(controller.state().phase)) {
          panel.set('none');
          managementReceipt.set({operation: kind, source: chosen.reference.sessionId,
            boundary: point ?? null, openedConversation: controller.state().run?.threadId, draftSent: false});
        }
      });
    } finally {operation.mutating = false; managementBusy.set(false); runsRevision.set(value => value + 1);}
  }});

/** Disconnect this browser client. Codex runtime remains owned; Claude SDK disconnect ends its worker. */
export const disconnect = action({scope: appScope, name: 'disconnect-client', group: 'session', run: async () => {
  const current = controller.state();
  if (!current.run || !['ready', 'working', 'error'].includes(current.phase)) throw Error('No connected client to disconnect.');
  await perform(() => controller.disconnect());
  runsRevision.set(value => value + 1);
}});

/** Read owned runtime observations. Old owner records are not adopted as process handles. */
export const refreshRuns = action({scope: appScope, name: 'refresh-runtimes', group: 'lifecycle', kind: 'read', run: () => {
  panel.set('runs'); runsRevision.set(value => value + 1);
}});

/** End one identified runtime owned by this lab. Other runs and the draft are unaffected. */
export const endRun = action({scope: appScope, name: 'end-owned-run', group: 'lifecycle', params: {id: 'Exact owned run ID'}, run: async args => {
  if (operation.mutating) throw Error('A management action is already in progress.');
  const id = String(args?.id ?? ''); if (!id) throw Error('Choose an owned run.');
  operation.mutating = true; managementBusy.set(true); managementReceipt.set(null);
  try {
    await perform(async () => {
      if (controller.state().run?.id === id) await controller.end();
      else await endOwnedRun(id);
      managementReceipt.set({operation: 'end-run', targetId: id, observedClientPhase: controller.state().phase});
    });
  } finally {operation.mutating = false; managementBusy.set(false); runsRevision.set(value => value + 1); historyRevision.set(value => value + 1);}
}});

/** End the current set of lab-owned runtimes. This is not an atomic stop or a shutdown of an unrelated owner. */
export const endAllRuns = action({scope: appScope, name: 'end-all-owned-runs', group: 'lifecycle', run: async () => {
  if (operation.mutating) throw Error('A management action is already in progress.');
  operation.mutating = true; managementBusy.set(true); managementReceipt.set(null);
  try {
    await perform(async () => {
      const currentId = active() ? controller.state().run?.id : undefined;
      if (currentId) await controller.end();
      const result = await endAllOwnedRuns();
      managementReceipt.set({operation: 'end-all-owned', ...result,
        targetIds: [...new Set([...(currentId ? [currentId] : []), ...result.targetIds])],
        observedClientPhase: controller.state().phase});
    });
  } finally {operation.mutating = false; managementBusy.set(false); runsRevision.set(value => value + 1); historyRevision.set(value => value + 1);}
}});
