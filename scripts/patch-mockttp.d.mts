/** Marks the first parts of the patch (HTTP/2 responses passed on from a server). */
export const MARKER: string;
/** Marks the part for callback replies, added later. */
export const CALLBACK_MARKER: string;
/** Every part's marker: the packaging check needs them all. */
export const MARKERS: readonly string[];
/** Each part of the patch: text found exactly once in Mockttp's file, and what replaces it. */
export const EDITS: ReadonlyArray<{ name: string; find: string; replace: string }>;
/** The patched file, relative to Mockttp's package folder. */
export const TARGET: string;
/** Applies the parts not yet there to the file's text, or throws naming the part that no longer fits. */
export function patchText(text: string): string;
/** Patches Mockttp in the given package folder. */
export function patchMockttp(packageDir: string): 'patched' | 'already patched';
