/** Run in the real Vite page. Exercises declared controls/actions, never credentials or a provider. */
export async function runAuthBrowserChecks() {
  const checks = [];
  const check = (name, passed, detail) => checks.push({name, passed: Boolean(passed), ...(detail === undefined ? {} : {detail})});
  const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const kit = window['__orchestrator-auth'];
  const call = async (name, args) => {const result = await kit.call(name, args); await tick(); return result;};
  const set = (name, value) => call('set', {name: `orchestrator-auth/${name}`, value});
  const report = () => call('report', {format: 'full'});
  await call('reset');
  let r = await report();
  check('two source-stamped scoped cells ready', r.cells.length === 2 && r.cells.every(c => c.state === 'ready' && c.loc));
  check('five declared preview dependencies visible', r.edges.find(e => e.cell.endsWith('/preview'))?.reads.length === 5);
  check('all controls and actions carry source locations', r.controls.every(c => c.loc) && r.actions.every(c => c.loc));
  check('simulation boundary visible', document.body.innerText.includes('SIMULATION · no live operations'));
  check('no free-text credential field', !document.querySelector('input:not([type=checkbox]),textarea'));
  check('no provider URLs or hidden auth frames', ![...document.querySelectorAll('a,iframe')].some(el => /openai.com|anthropic.com|claude.ai/.test(el.href || el.src || '')));
  for (const provider of ['codex', 'claude']) for (const host of ['local', 'remote']) for (const strategy of ['api-key', 'reuse-login', 'native']) {
    await call('reset'); await set('provider', provider); await set('host', host); await set('strategy', strategy);
    await set('apiKeyEnv', provider === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY');
    await call('start'); await call('advance'); await call('advance');
    r = await report();
    check(`${provider}/${host}/${strategy}: source owner and explicit access gap`, r.authentication.receipt.plan.profile.host === host && r.authentication.receipt.phase === 'observed' && r.authentication.receipt.access === 'not-tested' && document.querySelector('.auth-progress').textContent.includes('Status observed'));
    await call('validate-access'); r = await report(); check(`${provider}/${host}/${strategy}: separate synthetic access action`, r.authentication.receipt.access === 'passed');
  }
  await call('reset'); await call('start'); await set('host', 'remote'); r = await report();
  check('draft target changes never retarget existing attempt', r.authentication.receipt.plan.profile.host === 'local' && r.authentication.preview.profile.host === 'remote');
  await call('cancel'); check('local cancellation belongs to original attempt', (await report()).authentication.receipt.phase === 'cancelled');
  await call('start'); await call('cancel'); r = await report();
  check('remote stop-watching cannot claim host cancelled', r.authentication.receipt.phase === 'unknown' && document.querySelector('.auth-progress').textContent.includes('unconfirmed'));
  for (const [scenario, phase] of [['expired', 'expired'], ['failure', 'failed'], ['connection-lost', 'unknown']]) {
    await call('reset'); await set('scenario', scenario); await call('start'); await call('advance'); await call('advance');
    r = await report(); check(`${scenario}: stable terminal outcome without replay`, r.authentication.receipt.phase === phase && r.authentication.receipt.attempt === 1 && r.authentication.receipt.access === 'not-tested');
  }
  await call('reset'); await set('accessOutcome', 'denied'); await call('start'); await call('advance'); await call('advance'); await call('validate-access');
  r = await report(); check('observed auth configuration can still fail model access', r.authentication.receipt.presence === 'configuration observed' && r.authentication.receipt.access === 'denied');
  await call('reset'); await set('strategy', 'api-key'); await set('apiKeyEnv', 'TEAM_PROVIDER_KEY'); r = await report();
  check('API reference appears in actual supported Codex edit command', r.authentication.preview.setup.endsWith('--env TEAM_PROVIDER_KEY'));
  let rejected = false; try {await set('apiKeyEnv', 'sk-no-secret-values');} catch {rejected = true;}
  check('enum reference rejects a pasted key-shaped value', rejected && (await report()).authentication.preview.selection.apiKeyEnv === 'TEAM_PROVIDER_KEY');
  const sources = await call('sources', {filter: '060-authentication-flows/src/model', limit: 8});
  check('compiler lists authentication model sources', sources.files.some(file => file.endsWith('/store.ts')));
  await call('reset');
  check('page has no horizontal overflow', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, {width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth});
  return {checks, passed: checks.filter(c => c.passed).length, total: checks.length, allPassed: checks.every(c => c.passed), viewport: [innerWidth, innerHeight]};
}
