/** Types for scripts/build-java-agent.mjs, which tests import. */
export declare const source: string;
export declare const buildDir: string;
export interface AgentJars {
  stub: string;
  impl: string;
  weaver: string;
  attach: string;
}
export declare const jars: AgentJars;
/** The jars a build into `dir` makes. */
export declare function jarsIn(dir?: string): AgentJars;
export declare const byteBuddy: { version: string; url: string; sha256: string; file: string };
/** A JDK tool (javac, jar) from JAVA_HOME, else PATH, if it's JDK 17 or later. */
export declare function jdkTool(name: string): string | undefined;
/** Byte Buddy's jar: the one in deps/ if its SHA-256 matches, else fetched and checked. */
export declare function fetchByteBuddy(): Promise<string>;
/** A pinned jar: where it comes from, its SHA-256, and where it's kept. */
export interface PinnedJar {
  url: string;
  sha256: string;
  file: string;
}
/** How many times a pinned jar is asked for before giving up. */
export declare const FETCH_ATTEMPTS: number;
/** How long to wait (ms) after failed ask `attempt` (1-based), given the answer's Retry-After. */
export declare function retryWait(attempt: number, retryAfter: string | null, random?: () => number): number;
/**
 * A pinned jar: the one at `jar.file` if its SHA-256 matches, else fetched (failed asks retried
 * with waits) and checked. `options` are for tests.
 */
export declare function fetchPinned(
  jar: PinnedJar,
  what: string,
  options?: {
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    wait?: (ms: number) => Promise<void>;
    random?: () => number;
  },
): Promise<string>;
/** A set of test jars: a key of testJars. */
export type TestJarSet =
  | 'apache4'
  | 'apache4async'
  | 'apache5'
  | 'apache4.3'
  | 'apache4.4'
  | 'apache5.0'
  | 'apache5.2'
  | 'apache5.4'
  | 'apache5.7'
  | 'spring'
  | 'springBootLoader'
  | 'jetty9.4.0'
  | 'jetty9.4.25'
  | 'jetty9.4'
  | 'jetty10.0.0'
  | 'jetty10'
  | 'jetty11.0.0'
  | 'jetty11'
  | 'jetty12.0.0'
  | 'jetty12.0'
  | 'jetty12.1.0'
  | 'jetty12.1'
  | 'reactorNetty1.0.0'
  | 'reactorNetty1.0.48'
  | 'reactorNetty1.1.0'
  | 'reactorNetty1.1.24'
  | 'reactorNetty1.1.31'
  | 'reactorNetty1.2.0'
  | 'reactorNetty1.2.18'
  | 'reactorNetty1.3.8'
  | 'tcnative'
  | 'webflux';
/** Libraries the tests run the agent against (never shipped), pinned by SHA-256. */
export declare const testJars: Record<
  TestJarSet,
  Array<{ name: string; url: string; sha256: string; file: string }>
>;
/** The jars of `set`, fetched and checked as needed: their paths. */
export declare function fetchTestJars(set: TestJarSet): Promise<string[]>;
/** Builds the jars into `outDir` (default native/java-agent/build/). Returns paths and SHA-256s. */
export declare function buildJavaAgent(
  outDir?: string,
): Promise<Record<keyof AgentJars, { file: string; sha256: string }>>;
