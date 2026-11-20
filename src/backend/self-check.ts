import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { toBodyContent } from './body-content';
import { Formatter } from './formatter';
import { knownPart } from './har-redact';
import { HarRedactor } from './redactor';
import { findAgentJars } from './java/agent-host';
import path from 'node:path';

/**
 * Exercises what has crashed the backend before. Up to 0.1.3 it changed V8 flags after
 * start-up, and from then on anything that made a new V8 context (a worker thread, a
 * decompression stream) aborted the process: opening a gzip or HTML body lost the whole
 * capture. The flags now come at launch (see BACKEND_V8_FLAGS in src/main/backend-supervisor.ts).
 * Run by the packaged self-test, so CI checks every build on every system.
 * Returns the problems found; if the bug comes back, the process dies here instead. Also checks the
 * packaged app carries its Java agent.
 */
export async function selfCheck(resources?: string): Promise<string[]> {
  const problems: string[] = [];
  // The Java agent ships in the app's resources (electron-builder.cjs): `resources` is given by
  // the packaged self-test only.
  if (resources) {
    const jars = findAgentJars(resources);
    const folder = path.join(resources, 'java-agent');
    if (!jars || !Object.values(jars).every((file) => path.dirname(file) === folder)) {
      problems.push(`the Java agent's jars aren't in ${folder}`);
    }
  }
  try {
    new RegExp('a+', 'l');
  } catch {
    problems.push("linear-time regexes are off: the backend didn't get its V8 flags");
  }

  const json = '{"ok":true}';
  const content = await toBodyContent(() => Readable.from([gzipSync(json)]), 31, [
    ['content-encoding', 'gzip'],
  ]);
  const decoded = Buffer.from(content.base64, 'base64').toString();
  if (decoded !== json) problems.push(`decoding a gzip body gave ${JSON.stringify(decoded)}`);

  const formatter = new Formatter();
  try {
    const html = await formatter.format('html', '<div><p>x</p></div>');
    if (html !== '<div>\n  <p>x</p>\n</div>') problems.push(`formatting HTML gave ${JSON.stringify(html)}`);
  } catch (error) {
    problems.push(`formatting HTML failed: ${(error as Error).message}`);
  } finally {
    await formatter.close();
  }

  // HAR export's redaction worker loads and redacts: a header, and a value it learned in a body.
  const redactor = new HarRedactor();
  try {
    const secret = 'self-check-secret-0123456789';
    const entry = {
      request: {
        url: 'https://example.com/',
        headers: [{ name: 'Authorization', value: `Bearer ${secret}` }],
      },
      response: { content: { mimeType: 'text/plain', text: `echo ${secret}` } },
    };
    await redactor.collect([knownPart(entry)]);
    const outcome = await redactor.redact(entry, {
      cut: { request: false, response: false },
      base64Frames: [],
    });
    if (!('text' in outcome)) problems.push(`redacting a HAR entry gave ${JSON.stringify(outcome)}`);
    else if (outcome.text.includes(secret) || outcome.values !== 2)
      problems.push(
        `redacting a HAR entry left ${outcome.text.includes(secret) ? 'a secret' : `${outcome.values} places`}`,
      );
  } catch (error) {
    problems.push(`redacting a HAR entry failed: ${(error as Error).message}`);
  } finally {
    await redactor.close();
  }
  return problems;
}
