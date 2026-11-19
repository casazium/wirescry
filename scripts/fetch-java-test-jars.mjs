#!/usr/bin/env node
// Fetches Byte Buddy and every jar the Java agent's tests run against (testJars in
// scripts/build-java-agent.mjs) into native/java-agent/deps/, each checked against its pinned
// SHA-256. Jars already there and matching aren't fetched again.
//
//   node scripts/fetch-java-test-jars.mjs
//
// CI runs it before the Java agent's tests, between restoring and saving the cache of deps/, so
// the cache holds every jar whether or not the tests then pass, and the tests don't ask Maven
// Central for anything.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchByteBuddy, fetchPinned, testJars } from './build-java-agent.mjs';

/** Jars fetched at once: few, to be gentle with Maven Central. */
const AT_ONCE = 4;

/** Every pinned jar the build and tests use, each once (sets share some). */
export function allTestJars() {
  const byFile = new Map();
  for (const set of Object.values(testJars)) for (const jar of set) byFile.set(jar.file, jar);
  return [...byFile.values()];
}

/** Fetches every jar in `jars`, `AT_ONCE` at a time; rejects with the first failure, once all have settled. */
export async function fetchAll(jars, fetchOne = (jar) => fetchPinned(jar, jar.name)) {
  const queue = [...jars];
  const failures = [];
  const worker = async () => {
    for (let jar = queue.shift(); jar; jar = queue.shift()) {
      try {
        await fetchOne(jar);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  if (failures.length) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${jars.length} jars couldn't be fetched: ${failures[0].message}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchByteBuddy();
  const jars = allTestJars();
  await fetchAll(jars);
  console.log(`Byte Buddy and ${jars.length} test jars are in native/java-agent/deps.`);
}
