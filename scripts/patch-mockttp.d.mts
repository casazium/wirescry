/** Marks the first parts of the patch (HTTP/2 responses passed on from a server). */
export const MARKER: string;
/** Marks the part for callback replies, added later. */
export const CALLBACK_MARKER: string;
/** Marks the parts for requests offering an upgrade other than WebSocket, in both files. */
export const UPGRADE_MARKER: string;
/** Marks the parts that record a response's headers as Node sends them (TRACK_TARGET). */
export const TRACK_MARKER: string;
/** Every part's marker in TARGET: the packaging check needs them all. */
export const MARKERS: readonly string[];
/** The same for SERVER_TARGET. */
export const SERVER_MARKERS: readonly string[];
/** The same for TRACK_TARGET. */
export const TRACK_MARKERS: readonly string[];
/** One part of the patch: text found exactly once in Mockttp's file, what replaces it, and text only that part has. */
export interface Edit {
  name: string;
  tag: string;
  find: string;
  replace: string;
}
/** The parts for TARGET. */
export const EDITS: ReadonlyArray<Edit>;
/** The parts for SERVER_TARGET. */
export const SERVER_EDITS: ReadonlyArray<Edit>;
/** The parts for TRACK_TARGET. */
export const TRACK_EDITS: ReadonlyArray<Edit>;
/** The patched files, relative to Mockttp's package folder. */
export const TARGET: string;
export const SERVER_TARGET: string;
export const TRACK_TARGET: string;
/** The code of wirescryDropUpgradeOffer, as added to TARGET. */
export const UPGRADE_HELPER: string;
/**
 * Applies the parts not yet there to the file's text (TARGET's parts unless others are given), or
 * throws naming the part that no longer fits.
 */
export function patchText(text: string, edits?: ReadonlyArray<Edit>, target?: string): string;
/** Patches Mockttp in the given package folder: all its files, or none. */
export function patchMockttp(packageDir: string): 'patched' | 'already patched';
