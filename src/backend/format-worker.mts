/**
 * Pretty-prints code in a worker thread, so formatting a large minified file
 * never stalls the proxy. Self-contained (no local imports) so Node can run the
 * TypeScript source directly in tests.
 */
import { isMainThread, parentPort } from 'node:worker_threads';
import beautify from 'js-beautify';
import formatXml from 'xml-formatter';

export type Language = 'html' | 'xml' | 'js' | 'css';

const OPTIONS = {
  indent_size: 2,
  end_with_newline: false,
  preserve_newlines: true,
  max_preserve_newlines: 2,
};

/** Formats code. js-beautify copes with invalid or partial input; XML falls back to the original if it can't parse. */
export function formatCode(language: Language, text: string): string {
  switch (language) {
    case 'js':
      return beautify.js(text, OPTIONS);
    case 'css':
      return beautify.css(text, OPTIONS);
    case 'html':
      return beautify.html(text, { ...OPTIONS, wrap_line_length: 0 });
    case 'xml':
      return formatXml(text, { indentation: '  ', collapseContent: true, lineSeparator: '\n' });
  }
}

export interface FormatRequest {
  id: number;
  language: Language;
  text: string;
}

export type FormatResponse = { id: number; text: string } | { id: number; error: string };

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', ({ id, language, text }: FormatRequest) => {
    try {
      port.postMessage({ id, text: formatCode(language, text) } satisfies FormatResponse);
    } catch (error) {
      port.postMessage({ id, error: (error as Error).message } satisfies FormatResponse);
    }
  });
}
