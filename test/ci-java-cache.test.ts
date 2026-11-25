/**
 * CI's Java libraries cache. The Electron runtime job builds the Java agent, which fetches Byte
 * Buddy from Maven Central, whose 429s failed it; it reads java-agent.yml's cache instead. Only
 * java-agent.yml may save that key, after fetching every jar, or the key could hold Byte Buddy
 * alone and the agent's own jobs would lose their test jars.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

function load(name: string): Workflow {
  return parse(
    readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', name), 'utf8'),
  ) as Workflow;
}

const DEPS = 'native/java-agent/deps';
/** The key java-agent.yml restores, and saves once it has fetched every jar. */
const agentKey = () =>
  load('java-agent.yml').jobs.versions!.steps.find(
    (s) => s.uses?.startsWith('actions/cache/restore@') && s.with?.path === DEPS,
  )?.with?.key;

/** Steps that restore or save the Java libraries cache. */
const cacheSteps = (steps: Step[]) =>
  steps.filter((s) => s.uses?.startsWith('actions/cache') && s.with?.path === DEPS);

/** A step that saves when the job ends or by itself: `actions/cache` or `actions/cache/save`. (That
 * no workflow but java-agent.yml saves its key is checked in fetch-java-test-jars.test.ts.) */
const saves = (s: Step) => !s.uses!.startsWith('actions/cache/restore@');

describe("CI's Java libraries cache", () => {
  const ci = load('ci.yml');
  const electron = ci.jobs.electron!.steps;

  it('the Electron job restores java-agent.yml’s key before its tests', () => {
    const key = agentKey();
    expect(key).toBe("java-agent-deps-${{ hashFiles('scripts/build-java-agent.mjs') }}");
    const [step, ...more] = cacheSteps(electron);
    expect(more).toEqual([]);
    expect(step!.uses).toMatch(/^actions\/cache\/restore@v\d+$/);
    expect(step!.with!.key).toBe(key);
    const fallbacks = step!.with!['restore-keys']!.trim().split('\n');
    expect(fallbacks).toEqual(['java-agent-deps-', 'byte-buddy-']);
    const tests = electron.findIndex((s) => s.run?.includes('test:electron'));
    expect(tests).toBeGreaterThan(-1);
    expect(electron.indexOf(step!)).toBeLessThan(tests);
    expect(electron.indexOf(step!)).toBeGreaterThan(electron.findIndex((s) => s.run === 'npm ci'));
  });

  it('the check job keeps saving Byte Buddy under its own key', () => {
    const [step] = cacheSteps(ci.jobs.check!.steps);
    expect(saves(step!)).toBe(true);
    expect(step!.with!.key).toMatch(/^byte-buddy-/);
  });
});
