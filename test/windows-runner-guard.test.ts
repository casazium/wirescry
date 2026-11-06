/**
 * docs/windows-runner-guard.ps1, the check the Windows test PC's runner makes before every job
 * (docs/WINDOWS-TEST-PC.md). Run with PowerShell on Windows CI, which has it.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.join(import.meta.dirname, '..', 'docs', 'windows-runner-guard.ps1');
const WORKFLOW = 'casazium/wirescry/.github/workflows/windows-docker-desktop.yml';

function guard(env: { repository?: string; event?: string; workflowRef?: string }): {
  code: number | null;
  out: string;
} {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: env.repository ?? 'casazium/wirescry',
      GITHUB_EVENT_NAME: env.event ?? 'push',
      GITHUB_WORKFLOW_REF: env.workflowRef ?? `${WORKFLOW}@refs/heads/main`,
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe.runIf(process.platform === 'win32')('The Windows test PC runner guard', () => {
  it('allows the Docker Desktop workflow from main or a release tag, pushed or run by hand', () => {
    for (const [event, ref] of [
      ['push', 'refs/heads/main'],
      ['workflow_dispatch', 'refs/heads/main'],
      ['push', 'refs/tags/v0.1.19'],
    ]) {
      const result = guard({ event, workflowRef: `${WORKFLOW}@${ref}` });
      expect(result, `${event} ${ref}`).toMatchObject({ code: 0, out: expect.stringContaining('allowed') });
    }
  }, 120_000);

  it('refuses pull requests, other workflows, other branches, and other repositories', () => {
    const refused = [
      { event: 'pull_request' },
      { event: 'pull_request_target' },
      { workflowRef: 'casazium/wirescry/.github/workflows/ci.yml@refs/heads/main' },
      // A fork's own copy of the workflow.
      { workflowRef: 'someone/wirescry/.github/workflows/windows-docker-desktop.yml@refs/heads/main' },
      { workflowRef: `${WORKFLOW}@refs/heads/feature` },
      { workflowRef: `${WORKFLOW}@refs/pull/12/merge` },
      { workflowRef: `${WORKFLOW}@refs/heads/main-evil` },
      { workflowRef: `${WORKFLOW}@refs/tags/latest` },
      { repository: 'someone/wirescry' },
      { workflowRef: '' },
    ];
    for (const env of refused) {
      const result = guard(env);
      expect(result, JSON.stringify(env)).toMatchObject({ code: 1, out: expect.stringContaining('Refused') });
    }
  }, 300_000);
});
