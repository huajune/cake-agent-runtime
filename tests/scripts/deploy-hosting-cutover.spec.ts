import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('first hosting cutover', () => {
  let work: string;
  let bin: string;
  let roster: string;
  function stub(name: string, body: string) {
    const file = join(bin, name);
    writeFileSync(file, '#!/bin/sh\n' + body);
    chmodSync(file, 0o700);
  }
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'cake-hosting-cutover-'));
    bin = join(work, 'bin');
    roster = join(work, 'private/dashboard-onboarding/staff');
    mkdirSync(bin);
    mkdirSync(roster, { recursive: true });
    writeFileSync(join(roster, 'roster.json'), '{}');
    writeFileSync(join(work, 'docker-compose.yml'), 'previous');
    writeFileSync(join(work, 'new-compose.yml'), 'candidate');
    writeFileSync(join(work, '.deploy.env'), 'IMAGE_TAG=previous\n');
    writeFileSync(join(work, '.env.production'), 'PORT=8080\n');
    stub('stat', 'echo 1000:1000');
    stub('flock', 'exit 0');
    stub('sleep', 'exit 0');
    stub(
      'curl',
      'echo health >> "$TRACE"; if test "$SCENE" = unhealthy; then echo "{}"; else echo \'{"status":"healthy"}\'; fi',
    );
    stub(
      'docker',
      `case "$*" in
  *"dashboard-onboarding.js bind-directory "*) echo bind >> "$TRACE"; test "$SCENE" != bind-failure ;;
  *"dashboard-onboarding.js apply "*) echo accounts >> "$TRACE" ;;
  *" up -d --force-recreate"*) echo switch >> "$TRACE" ;;
  *) exit 0 ;;
esac`,
    );
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));
  function deploy(scene: string) {
    const trace = join(work, 'trace');
    const result = spawnSync(
      'bash',
      [
        resolve('scripts/deploy-remote.sh'),
        '--mode',
        'build',
        '--workdir',
        work,
        '--image-tag',
        'candidate',
        '--source-dir',
        work,
        '--compose-source',
        join(work, 'new-compose.yml'),
        '--supabase-url',
        'http://localhost',
        '--supabase-anon-key',
        'test',
      ],
      {
        env: { ...process.env, PATH: bin + ':' + process.env.PATH, TRACE: trace, SCENE: scene },
        encoding: 'utf8',
      },
    );
    return {
      status: result.status,
      trace: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [],
    };
  }

  it('binds before switching, and opens accounts only after health succeeds', () => {
    expect(deploy('success')).toEqual({
      status: 0,
      trace: ['bind', 'switch', 'health', 'accounts'],
    });
  });
  it('keeps the old image and configuration when binding fails', () => {
    expect(deploy('bind-failure')).toEqual({ status: 1, trace: ['bind'] });
    expect(readFileSync(join(work, '.deploy.env'), 'utf8')).toBe('IMAGE_TAG=previous\n');
    expect(readFileSync(join(work, 'docker-compose.yml'), 'utf8')).toBe('previous');
  });
  it('requires the ownership receipt even for a previously completed account batch', () => {
    for (const file of ['cakeadmin.ready.json', 'complete.json'])
      writeFileSync(join(roster, file), '{}');
    expect(deploy('bind-failure').trace).toEqual(['bind']);
  });
  it('keeps accounts unopened on a failed health check', () => {
    const result = deploy('unhealthy');
    expect(result.status).toBe(1);
    expect(result.trace.slice(0, 3)).toEqual(['bind', 'switch', 'health']);
    expect(result.trace).not.toContain('accounts');
  });
  it.each(['credentials.work.json', 'cakeadmin.work.json'])(
    'requires the other production credential file before switching when only %s is present',
    (oneFile) => {
      writeFileSync(
        join(work, '.env.production'),
        'NEXT_PUBLIC_SUPABASE_URL=https://resexopnhpthuoxfwydx.supabase.co\n',
      );
      writeFileSync(join(roster, oneFile), '{}');
      expect(deploy('success')).toEqual({ status: 1, trace: [] });
      const other =
        oneFile === 'credentials.work.json' ? 'cakeadmin.work.json' : 'credentials.work.json';
      writeFileSync(join(roster, other), '{}');
      expect(deploy('success')).toEqual({
        status: 0,
        trace: ['bind', 'switch', 'health', 'accounts'],
      });
    },
  );
});
