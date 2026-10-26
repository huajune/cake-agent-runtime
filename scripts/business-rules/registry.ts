import { BUSINESS_TOPICS } from '../../src/agent/generator/context/manual-loader';
import type { BusinessRuleLink } from '../../src/types/business-rule.types';

export interface RuleRecord {
  id: string;
  status: string;
  sources: string[];
  tests: string[];
}

export interface RuleBinding extends BusinessRuleLink {
  id: string;
  catalog: string;
  anchor: string;
}

const RULE_ID = /^(IB|SW|ID|SH|GEO|GP|HO)-\d{2}$/;
const ACTIVE = new Set(['现行基线', '已裁定']);
const STATUSES = new Set([...ACTIVE, '待裁定', '已废止']);

function references(block: string, label: string): string[] {
  return [...block.matchAll(new RegExp(`^- ${label}：\x60([^\x60]+)\x60`, 'gm'))].map(
    (match) => match[1],
  );
}

/** The Markdown index is the registry; no second JSON/configuration copy. */
export function validateRegistry(
  files: ReadonlyMap<string, string>,
  bindings: readonly RuleBinding[],
): { rules: RuleRecord[]; errors: string[] } {
  const errors: string[] = [];
  const rules = new Map<string, RuleRecord>();
  for (const topic of BUSINESS_TOPICS) {
    const path = `docs/business-rules/${topic.toLowerCase()}.md`;
    const content = files.get(path);
    if (!content) {
      errors.push(`Missing topic document: ${path}`);
      continue;
    }
    let count = 0;
    for (const block of content.split(/^## /m).slice(1)) {
      const title = block.split('\n')[0];
      if (!/^[A-Z]+-\d/.test(title)) continue;
      const [id, ...words] = title.split(' ');
      count++;
      if (!RULE_ID.test(id) || !id.startsWith(`${topic}-`) || !words.join('').trim()) {
        errors.push(`Invalid rule heading: ${path}: ${title}`);
      }
      if (rules.has(id)) errors.push(`Duplicate rule: ${id}`);
      const status = block.match(/^- 状态：(.+)$/m)?.[1].trim() ?? '';
      if (!STATUSES.has(status)) errors.push(`Invalid status: ${id}: ${status}`);
      if (!/^- 来源：\S.+$/m.test(block)) errors.push(`Missing provenance: ${id}`);
      const sources = references(block, '落点');
      const tests = references(block, '验证');
      if (ACTIVE.has(status) && (!sources.length || !tests.length)) {
        errors.push(`Active rule needs implementation and verification: ${id}`);
      }
      for (const reference of [...sources, ...tests]) {
        const [file, anchor, ...extra] = reference.split('#');
        if (
          !/^(src|tests)\/[\w./-]+$/.test(file) ||
          file.split('/').includes('..') ||
          extra.length
        ) {
          errors.push(`Unsafe reference: ${id}: ${reference}`);
          continue;
        }
        const source = files.get(file);
        if (source === undefined) errors.push(`Missing reference: ${id}: ${file}`);
        else if (anchor !== undefined && (!anchor || !source.includes(anchor))) {
          errors.push(`Missing anchor: ${id}: ${reference}`);
        }
      }
      for (const test of tests) {
        if (!/^tests\/.+\.spec\.ts$/.test(test)) errors.push(`Invalid test path: ${id}: ${test}`);
      }
      for (const source of sources) {
        if (!source.startsWith('src/'))
          errors.push(`Invalid implementation path: ${id}: ${source}`);
      }
      rules.set(id, { id, status, sources, tests });
    }
    if (!count) errors.push(`Empty topic document: ${path}`);
  }

  function linkedRule(id: string, location: string): RuleRecord | undefined {
    const rule = rules.get(id);
    if (!rule) errors.push(`Unknown business rule: ${location}: ${id}`);
    else if (!ACTIVE.has(rule.status))
      errors.push(`Inactive rule used at runtime: ${location}: ${id}`);
    return rule;
  }

  for (const [file, content] of files) {
    if (!file.startsWith('src/')) continue;
    const ids = [
      ...[...content.matchAll(/^\/\/ business-rules: (.+)$/gm)].flatMap((match) =>
        match[1].split(',').map((id) => id.trim()),
      ),
      ...[...content.matchAll(/^<!-- rule:([^\s]+) -->$/gm)].map((match) => match[1]),
    ];
    for (const id of new Set(ids)) {
      const rule = linkedRule(id, file);
      if (rule && !rule.sources.some((source) => source.split('#')[0] === file)) {
        errors.push(`Missing reverse implementation link: ${id}: ${file}`);
      }
    }
  }

  for (const binding of bindings) {
    if (binding.businessRule === null) {
      if (!binding.mechanismReason?.trim()) errors.push(`Mechanism needs rationale: ${binding.id}`);
      continue;
    }
    const rule = linkedRule(binding.businessRule, binding.id);
    const reference = `${binding.catalog}#${binding.anchor}`;
    if (rule && !rule.sources.includes(reference)) {
      errors.push(`Missing reverse catalog link: ${binding.id}: ${reference}`);
    }
    if (binding.mechanismReason)
      errors.push(`Business rule cannot also be a mechanism: ${binding.id}`);
  }
  return { rules: [...rules.values()], errors };
}

export function selectRuleTests(rules: readonly RuleRecord[], topics: readonly string[]): string[] {
  const selected = topics.length ? topics : BUSINESS_TOPICS;
  for (const topic of selected) {
    if (!(BUSINESS_TOPICS as readonly string[]).includes(topic)) {
      throw new Error(`Unknown topic: ${topic}; use ${BUSINESS_TOPICS.join(', ')}`);
    }
  }
  return [
    ...new Set(
      rules
        .filter((rule) => selected.includes(rule.id.split('-')[0]))
        .flatMap((rule) => rule.tests),
    ),
  ].sort();
}
