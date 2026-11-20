/**
 * The Java agent workflow's Java 8, installed on Linux by setup-java (Ubuntu's image has none).
 * Temurin 8u514, published Nov 19, 2026, failed setup-java's checksum on some runs (the same wrong
 * file each time it did) and installed on others, so the step names an exact build until a newer
 * one installs reliably.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  if?: string;
  with?: Record<string, string>;
}

const workflow = parse(
  readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'java-agent.yml'), 'utf8'),
) as { jobs: { versions: { steps: Step[] } } };
const java8 = workflow.jobs.versions.steps.filter(
  (s) => s.uses?.startsWith('actions/setup-java@') && s.with?.distribution === 'temurin',
);

describe('the Java agent workflow’s Java 8', () => {
  it('is installed once, on Linux, from Temurin', () => {
    expect(java8).toHaveLength(1);
    expect(java8[0]!.if).toBe("runner.os == 'Linux'");
  });

  it('names an exact Java 8 build, not the newest, and not 8u514', () => {
    const version = java8[0]!.with!['java-version']!;
    // An exact Temurin version: 8.0.<update>+<build>.
    expect(version).toMatch(/^8\.0\.\d+\+\d+$/);
    expect(version).not.toBe('8.0.514+1');
  });
});
