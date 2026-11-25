/** What the window says after a HAR export or import. */
import type { HarExportResult, HarImportResult } from '../../shared/ipc';

const count = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * After an export: how many requests went where, and for a redacted one, what redaction did.
 * `left` counts rows not exported (from before the proxy restarted).
 */
export function exportNotice(result: HarExportResult, left: number): string {
  const requests = count(result.count ?? 0, 'request', 'requests');
  const r = result.redaction;
  let text: string;
  if (!r) {
    text = `Exported ${requests} to ${result.name}. Secrets weren’t redacted.`;
  } else {
    // "No secrets were found" only when nothing was left out: a body left out can hold one.
    text =
      r.values > 0
        ? `Exported ${requests} to ${result.name}, with secrets redacted in ${count(r.values, 'place', 'places')}.`
        : r.dropped > 0 || r.leftOut > 0
          ? `Exported ${requests} to ${result.name}.`
          : `Exported ${requests} to ${result.name}. No secrets were found.`;
    text += ' Redaction is best effort for bodies: check before sharing.';
    if (r.dropped > 0)
      text += ` ${count(r.dropped, 'request was', 'requests were')} left out: ${r.dropped === 1 ? 'it' : 'they'} couldn’t be redacted.`;
    if (r.leftOut > 0)
      text += ` ${count(r.leftOut, 'body or message was', 'bodies or messages were')} left out: ${r.leftOut === 1 ? 'it' : 'they'} couldn’t be redacted safely.`;
    if (r.notScanned > 0)
      text += ` ${count(r.notScanned, 'body or message wasn’t', 'bodies or messages weren’t')} checked: ${r.notScanned === 1 ? 'it isn’t' : 'they aren’t'} text.`;
    if (r.full) text += ' Some secrets may have been missed: there were too many to keep track of.';
  }
  if (left > 0)
    text += ` ${left.toLocaleString()} from before the proxy restarted ${left === 1 ? 'wasn’t included: its details were' : 'weren’t included: their details were'} lost.`;
  return text;
}

/** After an import that added requests. */
export function importNotice(result: HarImportResult): string {
  const imported = result.imported ?? 0;
  const problems = (result.problems ?? []).join(' ');
  let text = `Imported ${count(imported, 'request', 'requests')} from ${result.name}.`;
  if (result.skipped) text += ` Skipped ${result.skipped.toLocaleString()}: ${problems}`;
  if (result.removed)
    text += ` To make room, the oldest ${count(result.removed, 'request', 'requests')} left the list.`;
  if (result.redacted) text += ' This file’s secrets were redacted, so resending its requests won’t sign in.';
  return text;
}
