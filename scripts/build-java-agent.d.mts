/** Types for scripts/build-java-agent.mjs, which tests import. */
export declare const source: string;
export declare const buildDir: string;
export declare const jars: { stub: string; impl: string; attach: string };
export declare const byteBuddy: { version: string; url: string; sha256: string; file: string };
/** A JDK tool (javac, jar) from JAVA_HOME, else PATH, if it's JDK 17 or later. */
export declare function jdkTool(name: string): string | undefined;
/** Byte Buddy's jar: the one in deps/ if its SHA-256 matches, else fetched and checked. */
export declare function fetchByteBuddy(): Promise<string>;
/** Builds the three jars. Returns their paths and SHA-256 digests. */
export declare function buildJavaAgent(): Promise<
  Record<'stub' | 'impl' | 'attach', { file: string; sha256: string }>
>;
