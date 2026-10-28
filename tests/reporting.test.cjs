const {test} = require('node:test');
const assert = require('node:assert/strict');
const {issuesReport, fccMonitor, ISSUE_MARKER, FCC_MARKER} = require('../.github/scripts/reporting.cjs');
const baseline = require('../.github/fcc-monitor-baseline.json');
const next = 'a'.repeat(40);
const later = 'b'.repeat(40);
function harness(initial = [], sha = baseline.sha) {
  const issues = structuredClone(initial);
  const calls = [];
  const listForRepo = () => {};
  const args = {
    context: {repo: {owner: 'example', repo: 'test'}}, dryRun: false,
    core: {info() {}, summary: {addRaw() {return this;}, async write() {}}},
    github: {
      async paginate(method, options) {
        assert.equal(method, listForRepo);
        assert.deepEqual(options, {owner: 'example', repo: 'test', state: 'all', per_page: 100});
        return structuredClone(issues);
      },
      rest: {issues: {
        listForRepo,
        async create(payload) {
          calls.push(['create', payload]);
          issues.push({...payload, state: 'open', number: 1000, user: {login: 'github-actions[bot]'}});
        },
        async update(payload) {
          calls.push(['update', payload]);
          Object.assign(issues.find(i => i.number === payload.issue_number), payload);
        },
      }},
    },
    async fetchUpstream(url, options) {
      assert.equal(url, 'https://api.github.com/repos/' + baseline.repository + '/commits/main');
      assert.equal(options.headers.Authorization, undefined);
      return {ok: true, async json() {return {sha};}};
    },
  };
  return {args, issues, calls};
}
const task = number => ({number, state: 'open', title: 'Task', body: '', user: {login: 'owner'}});

test('empty repository and PR-only repository create no report', async () => {
  for (const initial of [[], [{...task(1), pull_request: {}}]]) {
    const h = harness(initial);
    await issuesReport(h.args);
    assert.equal(h.calls.length, 0);
  }
});
test('issue report creates once, skips identical state, updates, closes and reopens', async () => {
  const h = harness([task(1)]);
  await issuesReport(h.args);
  assert.match(h.issues[1].body, /\n- #1$/);
  await issuesReport(h.args);
  assert.equal(h.calls.length, 1);
  h.issues.push(task(2));
  await issuesReport(h.args);
  assert.equal(h.calls.length, 2);
  h.issues[0].state = 'closed';
  h.issues[2].state = 'closed';
  await issuesReport(h.args);
  assert.equal(h.issues[1].state, 'closed');
  await issuesReport(h.args);
  assert.equal(h.calls.length, 3);
  h.issues[0].state = 'open';
  await issuesReport(h.args);
  assert.equal(h.issues[1].state, 'open');
  assert.equal(h.calls.filter(c => c[0] === 'create').length, 1);
});
test('all paginated issues counted; Markdown output bounded', async () => {
  const h = harness(Array.from({length: 205}, (_, i) => task(i + 1)));
  await issuesReport(h.args);
  assert.match(h.calls[0][1].body, /205 open issue/);
  assert.match(h.calls[0][1].body, /Showing the first 200/);
});
test('only bot-owned marked issue is managed; monitor is actionable', async () => {
  const h = harness([{...task(1), body: ISSUE_MARKER + '\nforged'}, {
    ...task(2), body: FCC_MARKER + '\nupdate', user: {login: 'github-actions[bot]'},
  }]);
  await issuesReport(h.args);
  assert.match(h.calls[0][1].body, /2 open issue/);
});
test('unchanged upstream never creates issue, including on first run', async () => {
  const h = harness();
  await fccMonitor(h.args);
  assert.equal(h.calls.length, 0);
});
test('changed upstream persists SHA, skips repeat, preserves closure, reopens on next SHA', async () => {
  const h = harness([], next);
  await fccMonitor(h.args);
  assert.match(h.issues[0].body, new RegExp('upstream-sha:' + next));
  await fccMonitor(h.args);
  assert.equal(h.calls.length, 1);
  h.issues[0].state = 'closed';
  await fccMonitor(h.args);
  assert.equal(h.calls.length, 1);
  h.args.fetchUpstream = async () => ({ok: true, json: async () => ({sha: later})});
  await fccMonitor(h.args);
  assert.equal(h.calls[1][0], 'update');
  assert.equal(h.issues[0].state, 'open');
});
test('manual preview never mutates or checkpoints', async () => {
  for (const fn of [issuesReport, fccMonitor]) {
    const h = harness([task(1)], next);
    h.args.dryRun = true;
    await fn(h.args);
    assert.equal(h.calls.length, 0);
    assert.equal(h.issues.length, 1);
  }
});
test('upstream HTTP errors, malformed SHA, invalid JSON and network failure are visible without writes', async () => {
  for (const fetchUpstream of [
    async () => ({ok: false, status: 403}),
    async () => ({ok: false, status: 404}),
    async () => ({ok: true, json: async () => ({sha: null})}),
    async () => ({ok: true, json: async () => {throw new Error('invalid JSON');}}),
    async () => {throw new Error('network failure');},
  ]) {
    const h = harness();
    h.args.fetchUpstream = fetchUpstream;
    await assert.rejects(fccMonitor(h.args));
    assert.equal(h.calls.length, 0);
  }
});
test('write failure leaves checkpoint unchanged for retry', async () => {
  const h = harness([], next);
  const create = h.args.github.rest.issues.create;
  h.args.github.rest.issues.create = async () => {throw new Error('denied');};
  await assert.rejects(fccMonitor(h.args), /denied/);
  assert.equal(h.issues.length, 0);
  h.args.github.rest.issues.create = create;
  await fccMonitor(h.args);
  assert.equal(h.calls.length, 1);
});
test('duplicate managed state and corrupted SHA fail without writes', async () => {
  for (const [fn, marker] of [[issuesReport, ISSUE_MARKER], [fccMonitor, FCC_MARKER]]) {
    const owned = {number: 10, state: 'closed', user: {login: 'github-actions[bot]'}, body: marker + '\nbroken'};
    const h = harness([owned, {...owned, number: 11}]);
    await assert.rejects(fn(h.args), /Multiple reports/);
    assert.equal(h.calls.length, 0);
    if (fn === fccMonitor) {
      const broken = harness([owned]);
      await assert.rejects(fn(broken.args), /invalid upstream baseline/);
      assert.equal(broken.calls.length, 0);
    }
  }
});
