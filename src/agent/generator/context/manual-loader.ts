import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Runtime instructions stay in src; governance prose is never injected into the model. */
export const BUSINESS_TOPICS = ['IB', 'SW', 'ID', 'SH', 'GEO', 'GP', 'HO'] as const;
export type BusinessTopic = (typeof BUSINESS_TOPICS)[number];

const INCLUDE = /\{\{rule:((?:IB|SW|ID|SH|GEO|GP|HO)-\d{2})\}\}/g;
const FRAGMENT = /<!-- rule:((?:IB|SW|ID|SH|GEO|GP|HO)-\d{2}) -->\n([\s\S]*?)<!-- end-rule:\1 -->/g;

export function stripMaintainerComments(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function parseRuleFragments(content: string): Map<string, string> {
  const fragments = new Map<string, string>();
  for (const match of content.matchAll(FRAGMENT)) {
    if (fragments.has(match[1])) throw new Error(`Duplicate business rule fragment: ${match[1]}`);
    if (/<!--\s*(?:rule:|end-rule:)/.test(match[2])) {
      throw new Error(`Nested business rule fragment: ${match[1]}`);
    }
    fragments.set(match[1], match[2].replace(/\n$/, ''));
  }
  const rest = content.replace(FRAGMENT, '');
  if (/<!--\s*(?:rule:|end-rule:)/.test(rest)) {
    throw new Error('Malformed business rule fragment');
  }
  if (stripMaintainerComments(rest).trim()) {
    throw new Error('Business rule text outside a fragment');
  }
  for (const [id, text] of fragments) {
    if (!stripMaintainerComments(text).trim())
      throw new Error(`Empty business rule fragment: ${id}`);
  }
  return fragments;
}

/** Preserve the existing prompt order while maintaining its business instructions by topic. */
export function assembleManual(
  manifest: string,
  readTopic: (topic: BusinessTopic) => string,
): string {
  const topics = new Map<string, Map<string, string>>();
  const included = new Set<string>();
  const expanded = manifest.replace(INCLUDE, (_, id: string) => {
    if (included.has(id)) throw new Error(`Duplicate business rule inclusion: ${id}`);
    included.add(id);
    const topic = id.split('-')[0] as BusinessTopic;
    let fragments = topics.get(topic);
    if (!fragments) {
      fragments = parseRuleFragments(readTopic(topic));
      topics.set(topic, fragments);
    }
    const fragment = fragments.get(id);
    if (fragment === undefined) throw new Error(`Missing business rule fragment: ${id}`);
    return fragment;
  });
  if (expanded.includes('{{rule:')) throw new Error('Malformed or nested business rule inclusion');
  for (const fragments of topics.values()) {
    for (const id of fragments.keys()) {
      if (!included.has(id)) throw new Error(`Unreferenced business rule fragment: ${id}`);
    }
  }
  return stripMaintainerComments(expanded);
}

export async function loadCandidateManual(proceduralRoot: string): Promise<string> {
  const [manifest, ...contents] = await Promise.all([
    readFile(join(proceduralRoot, 'candidate-consultation.md'), 'utf8'),
    ...BUSINESS_TOPICS.map((topic) =>
      readFile(join(proceduralRoot, 'rules', `${topic.toLowerCase()}.md`), 'utf8'),
    ),
  ]);
  // Read every registered topic, including one whose last inclusion was accidentally removed.
  for (const [index, topic] of BUSINESS_TOPICS.entries()) {
    const fragments = parseRuleFragments(contents[index]);
    if (fragments.size === 0) throw new Error(`Empty business rule topic: ${topic}`);
    for (const id of fragments.keys()) {
      if (!id.startsWith(`${topic}-`)) throw new Error(`Wrong business rule topic: ${id}`);
      if (!manifest.includes(`{{rule:${id}}}`)) {
        throw new Error(`Unreferenced business rule fragment: ${id}`);
      }
    }
  }
  return assembleManual(manifest, (topic) => contents[BUSINESS_TOPICS.indexOf(topic)]);
}
