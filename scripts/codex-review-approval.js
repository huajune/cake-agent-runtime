#!/usr/bin/env node
'use strict';

// No PR checkout, dependencies, shell commands or model output are executed here.
const fs = require('node:fs');
const CODEX = { id: 199175422, login: 'chatgpt-codex-connector[bot]' };
const ACTIONS = { id: 41898282, login: 'github-actions[bot]' };
const MARKER = '<!-- codex-verified-approval:v1 -->';
const SUMMARY = '<!-- codex-pull-request-review-summary -->';
const LEGACY_FAILURES = [
  'Automated AI review did not produce a valid structured decision for HEAD ',
  'Automated AI review did not complete a decisive review for HEAD ',
];
const isIdentity = (user, expected) => user?.id === expected.id && user.login === expected.login;
const isBot = (user, expected) => isIdentity(user, expected) && user.type === 'Bot';
const isOwnApproval = (review) =>
  isBot(review.user, ACTIONS) && review.state === 'APPROVED' && review.body?.startsWith(MARKER);
const isLegacyFailure = (review) =>
  isBot(review.user, ACTIONS) &&
  review.state === 'CHANGES_REQUESTED' &&
  LEGACY_FAILURES.some((prefix) => review.body?.startsWith(`${prefix}${review.commit_id}.`));

function assess(snapshot, now = Date.now()) {
  const { pr, files, comments, reactions, reviews, inlineComments } = snapshot;
  const deny = (reason) => ({ eligible: false, reason });
  if (pr.state !== 'open' || pr.draft || pr.base.ref !== 'develop')
    return deny('PR is not ready on develop');
  if (pr.head.repo?.full_name !== pr.base.repo.full_name)
    return deny('External PR requires manual approval');
  // Authority changes require independent approval; the bridge cannot authorize its own changes.
  if (
    files.some((file) =>
      [file.filename, file.previous_filename]
        .filter(Boolean)
        .some(
          (name) =>
            name.startsWith('.github/') ||
            name === 'scripts/codex-review-approval.js' ||
            name === 'tests/scripts/codex-review-approval.spec.ts',
        ),
    )
  )
    return deny('Review automation changes require manual approval');
  if (files.length !== pr.changed_files) return deny('Incomplete changed-file list');
  const summaries = comments.filter(
    (comment) => isBot(comment.user, CODEX) && comment.body?.startsWith(SUMMARY),
  );
  if (summaries.length !== 1) return deny('Expected one official Codex summary');
  const summary = summaries[0];
  const rows = summary.body.split('\n').filter((line) => /^\| (?!Review |---)/.test(line));
  if (!rows.length || !rows.some((line) => line.includes('**Code Review**')))
    return deny('Missing code review result');
  const completed = [];
  for (const row of rows) {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const status = cells[1]?.match(/^✅ \*\*Completed\*\* <relative-time datetime="([^"]+)">/);
    const sha = cells[2]?.match(/^`([a-f0-9]{7,40})`$/)?.[1];
    const time = Date.parse(status?.[1]);
    if (!status || !sha || !pr.head.sha.startsWith(sha) || !Number.isFinite(time) || time > now)
      return deny('Review is running, stale, or has an unsupported result');
    completed.push(time);
  }
  const completedAt = Math.max(...completed);
  // The reactions API reports this Bot account as type=User; pin its immutable ID and login.
  if (reactions.some((reaction) => isIdentity(reaction.user, CODEX) && reaction.content === 'eyes'))
    return deny('Codex still has a running review');
  // GitHub reaction timestamps have second precision; summary timestamps have microseconds.
  const reaction = reactions.find(
    (item) =>
      isIdentity(item.user, CODEX) &&
      item.content === '+1' &&
      Date.parse(item.created_at) >= Math.floor(completedAt / 1000) * 1000 &&
      Date.parse(item.created_at) <= now,
  );
  if (!reaction) return deny('No fresh official no-findings reaction');
  if (
    reviews.some(
      (review) =>
        isBot(review.user, CODEX) &&
        review.commit_id === pr.head.sha &&
        !['DISMISSED', 'APPROVED'].includes(review.state),
    ) ||
    inlineComments.some(
      (comment) => isBot(comment.user, CODEX) && comment.original_commit_id === pr.head.sha,
    )
  )
    return deny('Codex reported findings on this commit; fix and request a new review');
  // A COMMENTED review does not supersede that user's earlier request for changes.
  const decisions = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (!isLegacyFailure(review) && ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state))
      decisions.set(review.user.id, review.state);
  }
  if ([...decisions.values()].includes('CHANGES_REQUESTED'))
    return deny('An independent reviewer still requests changes');
  return {
    eligible: true,
    reason: 'Latest commit has a completed Codex review with no findings',
    head: pr.head.sha,
    evidence: `${summary.id}:${completedAt}:${reaction.id}`,
    summaryUrl: summary.html_url,
    reactionId: reaction.id,
  };
}

function createApi(token, repository) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Missing token or invalid repository');
  return async function api(path, method = 'GET', body) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

async function list(api, path) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const rows = await api(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error(`Invalid GitHub list: ${path}`);
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error(`Pagination limit exceeded: ${path}`);
}

async function readSnapshot(api, number) {
  const pr = await api(`pulls/${number}`);
  const [files, comments, reactions, reviews, inlineComments] = await Promise.all([
    list(api, `pulls/${number}/files`),
    list(api, `issues/${number}/comments`),
    list(api, `issues/${number}/reactions`),
    list(api, `pulls/${number}/reviews`),
    list(api, `pulls/${number}/comments`),
  ]);
  return { pr, files, comments, reactions, reviews, inlineComments };
}

async function synchronize({ api, number, apply = false, read = () => readSnapshot(api, number) }) {
  let snapshot = await read();
  let verdict = assess(snapshot);
  if (!apply) return verdict;
  const dismiss = (id, message) =>
    api(`pulls/${number}/reviews/${id}/dismissals`, 'PUT', { message });
  const approvalBody = (result) =>
    `${MARKER}\n\nVerified official Codex review for HEAD ${result.head}.\n` +
    `Evidence: ${result.evidence}\nSummary: ${result.summaryUrl}\n\n` +
    'Codex completed all listed reviews and posted a fresh no-findings reaction. CI and branch protection remain required.';
  const prune = async (state, result) => {
    for (const review of state.reviews.filter(isOwnApproval)) {
      if (
        !result.eligible ||
        review.commit_id !== result.head ||
        review.body !== approvalBody(result)
      )
        await dismiss(
          review.id,
          'Codex approval evidence changed or is no longer valid; a fresh review is required.',
        );
    }
  };
  await prune(snapshot, verdict);
  if (!verdict.eligible) return verdict;
  const expected = verdict;
  // Re-read every source immediately before writing, rather than trusting webhook contents.
  snapshot = await read();
  verdict = assess(snapshot);
  if (
    !verdict.eligible ||
    verdict.head !== expected.head ||
    verdict.evidence !== expected.evidence
  ) {
    await prune(snapshot, { eligible: false });
    return {
      eligible: false,
      reason: 'Review changed before approval; retry after the new review completes',
    };
  }
  let approval = snapshot.reviews.find(
    (review) =>
      isOwnApproval(review) &&
      review.commit_id === verdict.head &&
      review.body === approvalBody(verdict),
  );
  if (!approval) {
    approval = await api(`pulls/${number}/reviews`, 'POST', {
      event: 'APPROVE',
      commit_id: verdict.head,
      body: approvalBody(verdict),
    });
  }
  let after;
  try {
    after = await read();
  } catch (error) {
    // If the post-write check is unavailable, do not leave an unverified approval behind.
    if (approval?.id) await dismiss(approval.id, 'Unable to verify Codex evidence after approval.');
    throw error;
  }
  const checked = assess(after);
  if (!checked.eligible || checked.head !== verdict.head || checked.evidence !== verdict.evidence) {
    await prune(after, { eligible: false });
    return { eligible: false, reason: 'Review changed during approval; bridge approval dismissed' };
  }
  // Only old Claude infrastructure failures are superseded; never dismiss substantive/human reviews.
  for (const review of after.reviews.filter(isLegacyFailure))
    await dismiss(
      review.id,
      `Superseded by verified official Codex review for HEAD ${checked.head}.`,
    );
  return { ...checked, approved: true };
}

async function main() {
  const number = process.env.PR_NUMBER;
  if (!/^[1-9]\d*$/.test(number || '')) throw new Error('PR_NUMBER must be a positive integer');
  const apply = process.argv.includes('--apply');
  if (apply) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      !['issue_comment', 'pull_request_target', 'workflow_dispatch'].includes(
        process.env.GITHUB_EVENT_NAME,
      ) ||
      process.env.GITHUB_REF !== `refs/heads/${event.repository.default_branch}`
    )
      throw new Error('Writes require the trusted default-branch workflow');
  }
  const api = createApi(
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    process.env.GITHUB_REPOSITORY,
  );
  let result;
  // A summary edit can arrive a few seconds before Codex creates the PR-level reaction.
  for (let attempt = 0; attempt < (apply ? 12 : 1); attempt++) {
    result = await synchronize({ api, number, apply });
    if (result.reason !== 'No fresh official no-findings reaction') break;
    if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log(JSON.stringify({ pr: Number(number), ...result }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `PR #${number}: ${result.approved ? 'APPROVED' : 'NOT APPROVED'} — ${result.reason}\n`,
    );
}

module.exports = {
  assess,
  synchronize,
  readSnapshot,
  list,
  CODEX,
  ACTIONS,
  MARKER,
  SUMMARY,
  isLegacyFailure,
};
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
