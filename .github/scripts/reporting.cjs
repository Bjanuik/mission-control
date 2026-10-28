const baseline = require('../fcc-monitor-baseline.json');
const ISSUE_MARKER = '<!-- mission-control:issues-report:v1 -->';
const FCC_MARKER = '<!-- mission-control:fcc-monitor:v1 -->';
const SHA_PATTERN = /^[a-f0-9]{40}$/;

function managed(issue, marker) {
  return !issue.pull_request && issue.user?.login === 'github-actions[bot]' &&
    issue.body?.startsWith(marker + '\n');
}

async function inventory(github, context) {
  return github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'all', per_page: 100,
  });
}

function findReport(issues, marker) {
  const matches = issues.filter(issue => managed(issue, marker));
  if (matches.length > 1) throw new Error(`Multiple reports found for ${marker}`);
  return matches[0];
}

async function publish({github, context, dryRun}, report, desired) {
  const changed = !report || Object.entries(desired).some(([key, value]) => report[key] !== value);
  if (!changed) return 'Unchanged; no issue write.';
  if (dryRun) return `Preview: would ${report ? 'update' : 'create'} report (${desired.state}).`;
  if (report) {
    await github.rest.issues.update({...context.repo, issue_number: report.number, ...desired});
  } else {
    const {state, ...payload} = desired;
    await github.rest.issues.create({...context.repo, ...payload});
  }
  return `${report ? 'Updated' : 'Created'} report (${desired.state}).`;
}

async function summarize(core, message) {
  core.info(message);
  await core.summary.addRaw(message).write();
}

async function issuesReport(args) {
  const {github, context, core} = args;
  const dryRun = args.dryRun ?? process.env.DRY_RUN === 'true';
  const issues = await inventory(github, context);
  const report = findReport(issues, ISSUE_MARKER);
  const actionable = issues.filter(issue => !issue.pull_request && issue.state === 'open' &&
    !managed(issue, ISSUE_MARKER)).sort((a, b) => a.number - b.number);
  if (!actionable.length && !report) return summarize(core, 'No open issues; no report created.');
  // Numeric links avoid injecting user-supplied titles into managed Markdown.
  const links = actionable.slice(0, 200).map(issue => `- #${issue.number}`).join('\n');
  const body = `${ISSUE_MARKER}\n${actionable.length} open issue(s) remaining.\n\n${links}` +
    (actionable.length > 200 ? '\n\nShowing the first 200; see the repository Issues tab for all open issues.' : '');
  const result = await publish({...args, dryRun}, report, {
    title: 'Mission Control: open issues', body, state: actionable.length ? 'open' : 'closed',
  });
  return summarize(core, `${actionable.length} open issue(s). ${result}`);
}

async function fccMonitor(args) {
  const {github, context, core} = args;
  const dryRun = args.dryRun ?? process.env.DRY_RUN === 'true';
  const report = findReport(await inventory(github, context), FCC_MARKER);
  let previous = baseline.sha;
  if (report) {
    previous = report.body.match(/\n<!-- upstream-sha:([a-f0-9]{40}) -->\n/)?.[1];
  }
  if (!SHA_PATTERN.test(previous || '')) throw new Error('Missing or invalid upstream baseline SHA.');
  // Public upstream: do not send the repository-scoped token to another repository.
  const fetchUpstream = args.fetchUpstream ?? fetch;
  const response = await fetchUpstream(
    `https://api.github.com/repos/${baseline.repository}/commits/${encodeURIComponent(baseline.ref)}`,
    {headers: {Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(30000)},
  );
  if (!response.ok) throw new Error(`Upstream lookup failed: HTTP ${response.status}`);
  const latest = (await response.json()).sha;
  if (!SHA_PATTERN.test(latest || '')) throw new Error('Upstream returned an invalid commit SHA.');
  if (latest === previous) return summarize(core, 'Upstream SHA unchanged; no issue write.');
  const root = `https://github.com/${baseline.repository}`;
  const body = `${FCC_MARKER}\n<!-- upstream-sha:${latest} -->\n` +
    `Upstream ${baseline.ref} changed. Review before updating local software.\n\n` +
    `Previous observed commit: [${previous}](${root}/commit/${previous})\n\n` +
    `Current commit: [${latest}](${root}/commit/${latest})\n\n` +
    `[Compare changes](${root}/compare/${previous}...${latest})\n\n` +
    'Close this issue after review. It reopens only when a different upstream SHA is observed.\n' +
    'This is the latest observed change; earlier notifications remain in issue edit history.';
  // Persist notification and checkpoint in one write; failures keep the old SHA for retry.
  const result = await publish({...args, dryRun}, report, {
    title: 'Mission Control: fcc-server update available', body, state: 'open',
  });
  return summarize(core, `Upstream SHA changed from ${previous} to ${latest}. ${result}`);
}

module.exports = {issuesReport, fccMonitor, ISSUE_MARKER, FCC_MARKER};
