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
  | 'springBootLoader';
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
