# Operational reporting

## Behavior

The open-issues workflow runs at 08:20 UTC (02:20 America/Guatemala).
It counts actual open issues, excluding pull requests and its own bot-owned,
marked report. The software update issue counts as actionable work until closed.
With no work and no prior report it creates nothing. Otherwise it creates one
report, updates that same issue when the list changes, closes it at zero, and
reopens it when work returns. Unchanged content causes no write or comment.
The report lists issue numbers, ordered consistently, and caps the displayed
list at 200 while preserving the full count. Pagination includes all issues.

The fcc-server workflow runs at 09:00 UTC (03:00 America/Guatemala).
It compares the full upstream main commit SHA against the last notified SHA.
The initial baseline in `.github/fcc-monitor-baseline.json` is
`56ee72ea5722cb81de9b1905627897b5e77581ce`, retrieved October 27, 2026.
This establishes an observation baseline, not proof that local software is at
that version. Existing changes before that baseline are intentionally not
notified; review the upstream history separately if a catch-up review is needed.

If upstream changes, one bot-owned marked issue stores both the notification
and its SHA checkpoint in the same write. Later changes update that issue and
reopen it if closed. Closing acknowledges the current notification; an unchanged
SHA will not reopen it. Force pushes and rollbacks also count as changes.
The issue shows the latest observed transition and commit/compare links; it is
not a complete log of every intervening commit or proof of ancestry.
Prior bodies can be viewed in issue edit history.

Both workflows use paginated REST reads instead of eventually indexed search.
Only bot-created issues with exact versioned body markers are treated as managed
reports; ordinary issues with similar titles are untouched. Duplicate marked
reports or malformed checkpoint state fail visibly rather than choosing a SHA.
Do not delete or edit the marker/checkpoint lines. Deleting a report loses its
stored checkpoint and falls back to the checked-in baseline, which may notify
again. To recover, restore the issue or intentionally update the baseline after
review. Legacy unmarked daily issues, if any, require manual cleanup.

Upstream HTTP errors, rate limits, network errors and invalid responses fail
the run before any issue write. A failed notification does not advance its SHA,
so the next run can retry. Public upstream requests carry no repository token
and use a 30-second timeout. At this volume the unauthenticated API quota is
normally sufficient; rate limits remain visible failures.

## Permissions and concurrency

The reporting workflows deny permissions by default and grant only
`contents: read` (checkout) and `issues: write` (read/create/update issues) to
the reporting job. No personal token, extra secret, contents write, Actions
write, or global read/write token setting is required. Checkout does not persist
credentials. Actions are pinned to verified release commit identities.

A shared concurrency group serializes report mutations. GitHub retains at most
one pending run in a concurrency group, so redundant queued checks can be
replaced; the next check still compares current persistent state.
No pull-request event runs either reporting job. The separate validation workflow
has read-only contents access and uses mocked APIs, including in pull requests.

## Current schedule status and activation

On October 27, 2026, the public workflow API returned:

| Workflow | ID | State |
| --- | --- | --- |
| Report remaining open issues | 307860417 | disabled_inactivity |
| fcc-server update monitor | 307860424 | disabled_inactivity |

The newest retrieved scheduled runs remain September 4, 2026:
[issue report](https://github.com/Bjanuik/mission-control/actions/runs/33874437563)
and [software monitor](https://github.com/Bjanuik/mission-control/actions/runs/33875689754).
The repository issue API returned no issues at inspection time.
These are dated observations, not a guarantee of future state.

1. Review and merge the repair into the default branch, `main`. Scheduled runs
   use the default branch; an isolated repair branch does not activate them.
2. In **Actions**, select each reporting workflow and click **Enable workflow**.
   Both are currently disabled due to inactivity. This repair does not re-enable
   the old broken workflows. A repository writer can alternatively run
   `gh workflow enable issues-report.yml --repo Bjanuik/mission-control` and
   `gh workflow enable fcc-monitor.yml --repo Bjanuik/mission-control`.
3. Ensure repository Actions policy permits the pinned checkout and github-script
   actions and that Issues are enabled. Keep the default token setting restricted;
   job permissions above request the required access. Check any organization or
   enterprise policy if issue writes remain denied.
4. Run each workflow manually with **dry_run = true** (the default) and review
   its run summary. Preview performs reads and never creates, edits, reopens or
   closes issues, nor advances the checkpoint. Scheduled runs use normal mode.
   A manual run with **dry_run = false** performs real report maintenance.
5. Verify the API reports `active` and that the next scheduled runs complete
   successfully. For example:
   `gh api repos/Bjanuik/mission-control/actions/workflows --jq '.workflows[] | {name,state}'`.
   Check the run event is `schedule`; a successful manual preview alone does not
   prove scheduled delivery.

GitHub can disable scheduled workflows in public repositories after 60 days of
inactivity. Scheduling is best effort and may be delayed. Monitor Actions failures
and inactivity status; these workflows do not implement an external watchdog,
persistent assistant memory, or a complete personal task-management system.

References:
[schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[enable workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows),
[token permissions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication).

## Validation

Run `node --test tests/reporting.test.cjs` (Node 20 or newer) and
`actionlint .github/workflows/*.yml`.
Tests mock all GitHub writes and upstream responses. They cover empty/PR-only
repositories, report reuse/closure/reopening, large inventories, ownership
markers, unchanged/changed SHAs, acknowledgments, preview mode, failures,
retry after denied writes, duplicate reports, and corrupted checkpoints.
The validation workflow runs these tests with read-only permissions.
No live issue creation is needed for validation.
