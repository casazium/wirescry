/** Marks Mockttp's file as patched; the patch is skipped when it's there. */
export const MARKER: string;
/** Each part of the patch: text found exactly once in Mockttp's file, and what replaces it. */
export const EDITS: ReadonlyArray<{ name: string; find: string; replace: string }>;
/** The patched file, relative to Mockttp's package folder. */
export const TARGET: string;
/** Applies the patch to the file's text, or throws naming the part that no longer fits. */
export function patchText(text: string): string;
/** Patches Mockttp in the given package folder. */
export function patchMockttp(packageDir: string): 'patched' | 'already patched';
