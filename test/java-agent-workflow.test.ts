/**
 * The Java agent workflow's matrix: which jobs each trigger asks for. GitHub's macOS runners are
 * scarce, so pull requests ask for none, and the nightly run asks for 4 (one attacher), not 12.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Event = 'pull_request' | 'schedule' | 'workflow_dispatch';

interface Matrix {
  os: string;
  attacher: string;
  suite: string[];
  exclude?: Array<Record<string, unknown>>;
}

const workflow = parse(
  readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'java-agent.yml'), 'utf8'),
) as {
  on: Record<string, unknown>;
  jobs: { versions: { 'runs-on': string; strategy: { matrix: Matrix } } };
};
const matrix = workflow.jobs.versions.strategy.matrix;

/**
 * A matrix value of the form the workflow uses, for one trigger:
 * `${{ fromJSON(github.event_name == 'pull_request' && '<json>' || '<json>') }}`. Fails on any other
 * form, so a change to the workflow can't slip past these tests.
 */
function valueFor(expression: string, event: Event): string[] {
  const match =
    /^\$\{\{\s*fromJSON\(github\.event_name == 'pull_request'\s*&&\s*'(\[[^']*\])'\s*\|\|\s*'(\[[^']*\])'\)\s*\}\}$/.exec(
      expression.trim(),
    );
  if (!match) throw new Error(`unexpected matrix value: ${expression}`);
  return JSON.parse(event === 'pull_request' ? match[1]! : match[2]!) as string[];
}

/** The jobs a trigger asks for: every combination, less the excluded ones. */
function jobsFor(event: Event): Array<{ os: string; attacher: string; suite: string }> {
  const jobs = [];
  for (const os of valueFor(matrix.os, event)) {
    for (const attacher of valueFor(matrix.attacher, event)) {
      for (const suite of matrix.suite) {
        const job = { os, attacher, suite };
        const excluded = (matrix.exclude ?? []).some((rule) =>
          // Strictly: GitHub compares the matrix's strings with the rule's values as they are.
          Object.entries(rule).every(([key, value]) => job[key as keyof typeof job] === value),
        );
        if (!excluded) jobs.push(job);
      }
    }
  }
  return jobs;
}

const macos = (jobs: ReturnType<typeof jobsFor>) => jobs.filter((j) => j.os === 'macos-latest');

describe('the Java agent workflow’s jobs', () => {
  it('asks for no macOS runner on a pull request, and runs every suite on Linux and Windows', () => {
    // Not on the list at all, so a change of the pull requests' attacher can't bring macOS back.
    expect(valueFor(matrix.os, 'pull_request')).toEqual(['ubuntu-latest', 'windows-latest']);
    const jobs = jobsFor('pull_request');
    expect(macos(jobs)).toEqual([]);
    expect(jobs).toHaveLength(8);
    for (const os of ['ubuntu-latest', 'windows-latest']) {
      expect(jobs.filter((j) => j.os === os).map((j) => j.suite)).toEqual([
        'core',
        'apache',
        'jetty',
        'netty',
      ]);
    }
    expect(new Set(jobs.map((j) => j.attacher))).toEqual(new Set(['21']));
  });

  it.each(['schedule', 'workflow_dispatch'] as const)(
    'on %s, runs every suite on macOS with one attacher: 4 macOS jobs, not 12',
    (event) => {
      const jobs = jobsFor(event);
      // JDK 17: the oldest Wirescry supports on macOS, and not the JDK that builds.
      expect(macos(jobs)).toEqual(
        ['core', 'apache', 'jetty', 'netty'].map((suite) => ({ os: 'macos-latest', attacher: '17', suite })),
      );
      // Linux and Windows still try every attacher.
      for (const os of ['ubuntu-latest', 'windows-latest']) {
        expect(new Set(jobs.filter((j) => j.os === os).map((j) => j.attacher))).toEqual(
          new Set(['17', '21', '25']),
        );
      }
      expect(jobs).toHaveLength(4 + 2 * 3 * 4);
    },
  );

  it('has no other matrix keys, such as an include that could add macOS jobs back, and runs on its os', () => {
    expect(Object.keys(matrix).sort()).toEqual(['attacher', 'exclude', 'os', 'suite']);
    expect(workflow.jobs.versions['runs-on']).toBe('${{ matrix.os }}');
  });

  it('still runs nightly and by hand, so macOS is covered every day', () => {
    expect(workflow.on).toHaveProperty('schedule');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('fails on a matrix value of a form it doesn’t know, rather than passing', () => {
    expect(() => valueFor('[ubuntu-latest, macos-latest]', 'pull_request')).toThrow(
      /unexpected matrix value/,
    );
  });
});
