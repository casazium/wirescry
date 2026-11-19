/** Types for scripts/fetch-java-test-jars.mjs, which tests import. */
import type { PinnedJar } from './build-java-agent.mjs';

/** Every pinned test jar, each once. */
export declare function allTestJars(): Array<PinnedJar & { name: string }>;
/** Fetches every jar, a few at a time; rejects after all settle if any failed. */
export declare function fetchAll<J>(jars: J[], fetchOne?: (jar: J) => Promise<unknown>): Promise<void>;
