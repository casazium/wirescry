/**
 * A form body's fields (application/x-www-form-urlencoded): for the Fields view of a body,
 * and for HAR's postData.params.
 */

export interface FormField {
  name: string;
  value: string;
  /** Its escapes aren't UTF-8 (a form from a page in another encoding), so it's as written. */
  asWritten?: true;
}

/** Decodes one name or value: `+` is a space, an escape that isn't one stays as written. */
function decodePart(part: string): string | undefined {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' ').replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
  } catch {
    return undefined; // Escapes that aren't UTF-8.
  }
}

/**
 * The fields, decoded, in order, repeats included. A field with no `=` has an empty value.
 * As URLSearchParams decodes them, except that a leading `?` is part of the first name, and a
 * field whose escapes aren't UTF-8 is kept as written rather than shown with "�".
 */
export function formFields(text: string): FormField[] {
  const fields: FormField[] = [];
  for (const piece of text.split('&')) {
    if (!piece) continue;
    const eq = piece.indexOf('=');
    const rawName = eq < 0 ? piece : piece.slice(0, eq);
    const rawValue = eq < 0 ? '' : piece.slice(eq + 1);
    const name = decodePart(rawName);
    const value = decodePart(rawValue);
    fields.push(
      name === undefined || value === undefined
        ? { name: rawName, value: rawValue, asWritten: true }
        : { name, value },
    );
  }
  return fields;
}

/** The fields as Copy puts them: one per line, `name: value`. */
export function fieldsText(fields: FormField[]): string {
  return fields.map(({ name, value }) => `${name}: ${value}`).join('\n');
}
