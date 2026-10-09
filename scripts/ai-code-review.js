#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const schema = require('../.github/ai-review.schema.json');

const FALLBACK_PREFIX = 'Automated AI review did not produce a valid structured decision for HEAD';
const LEGACY_FALLBACK_PREFIX = 'Automated AI review did not complete a decisive review for HEAD';

function parseReview(env) {
  const provider = env.AI_REVIEW_PROVIDER || 'gpt';
  const output = {
    gpt: [env.GPT_OUTCOME, env.GPT_REVIEW_JSON],
    claude: [env.CLAUDE_OUTCOME, env.CLAUDE_REVIEW_JSON],
  };
  if (!Object.hasOwn(output, provider)) return null;
  const [outcome, raw] = output[provider];
  if (outcome !== 'success') return null;
  let review;
  try {
    review = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const { decision, summary, blocking_findings: findings } = review;
  const rules = schema.properties;
  const validText = (value, max) =>
    typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;
  if (
    Object.keys(review).length !== schema.required.length ||
    !schema.required.every((key) => Object.hasOwn(review, key)) ||
    !rules.decision.enum.includes(decision) ||
    !validText(summary, rules.summary.maxLength) ||
    !Array.isArray(findings) ||
    findings.length > rules.blocking_findings.maxItems ||
    !findings.every((finding) => validText(finding, rules.blocking_findings.items.maxLength)) ||
    (decision === 'APPROVE' ? findings.length !== 0 : findings.length === 0)
  ) {
    return null;
  }
  return review;
}

function isFallback(review) {
  return (
    review.user?.login === 'github-actions[bot]' &&
    review.state === 'CHANGES_REQUESTED' &&
    typeof review.body === 'string' &&
    [FALLBACK_PREFIX, LEGACY_FALLBACK_PREFIX].some((prefix) => review.body.startsWith(prefix))
  );
}

// JSON travels through stdin; model output is never evaluated as shell code.
function githubApi(method, endpoint, body, paginate = false) {
  const args = ['api', '--method', method, endpoint];
  if (body) args.push('--input', '-');
  if (paginate) args.push('--paginate', '--slurp');
  try {
    const raw = execFileSync('gh', args, {
      input: body ? JSON.stringify(body) : undefined,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    throw new Error('GitHub API request failed; no review success can be confirmed.');
  }
}

function publishReview(env, api = githubApi) {
  const { GITHUB_REPOSITORY: repo, PR_NUMBER: number, HEAD_SHA: head } = env;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo || '') ||
    !/^[1-9]\d*$/.test(number || '') ||
    !/^[a-f0-9]{40}$/.test(head || '')
  ) {
    throw new Error('Invalid PR context; refusing to publish a review.');
  }
  const endpoint = `repos/${repo}/pulls/${number}`;
  const pr = api('GET', endpoint);
  if (pr.state !== 'open' || pr.head?.sha !== head) {
    throw new Error('PR is closed or HEAD changed; refusing to publish an obsolete review.');
  }
  const review = parseReview(env);
  const previous = api('GET', `${endpoint}/reviews?per_page=100`, undefined, true).flat();
  if (!review) {
    if (!previous.some((item) => item.commit_id === head && isFallback(item))) {
      api('POST', `${endpoint}/reviews`, {
        event: 'REQUEST_CHANGES',
        commit_id: head,
        body: `${FALLBACK_PREFIX} ${head}. Inspect the workflow run and request a fresh review after remediation.`,
      });
    }
    throw new Error(
      'Selected AI reviewer failed or returned an invalid decision. Review remains blocked.',
    );
  }
  const findings = review.blocking_findings;
  const body =
    review.summary.trim() +
    (findings.length
      ? `\n\nBlocking findings:\n${findings.map((item) => `- ${item}`).join('\n')}`
      : '');
  api('POST', `${endpoint}/reviews`, { event: review.decision, commit_id: head, body });

  // Only remove this workflow's failure placeholders after a real decision exists.
  // Human reviews and substantive AI findings must remain untouched.
  for (const item of previous.filter(isFallback)) {
    api('PUT', `${endpoint}/reviews/${item.id}/dismissals`, {
      message: `Superseded by a valid structured AI review for ${head}.`,
    });
  }
  return review.decision;
}

if (require.main === module) {
  try {
    process.stdout.write(`AI review submitted: ${publishReview(process.env)}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseReview, publishReview, FALLBACK_PREFIX, LEGACY_FALLBACK_PREFIX };
