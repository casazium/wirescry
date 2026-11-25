/**
 * View › Hide Secrets in the window: secrets planted everywhere an exchange can show them, the
 * switch turned on from the menu, and the window searched for them (text, titles, labels, the
 * clipboard). And the switch itself: remembered, ticked in the menu, turned off by its badge.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BodyContent, ExchangeDetail, ExchangeSummary, ServerMessage } from '../../src/shared/api';
import type { BackendState, MenuCommand, WirescryBridge } from '../../src/shared/ipc';
import { HIDE_SECRETS_KEY } from '../../src/renderer/src/secrets';
import { status, summary } from './fixtures';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const PASSWORD = 'hunter2' + 'Correct9Horse';
const COOKIE = 'c00k1e' + 'S3ss10nV4lu3x';
const KEY = 'ak_' + 'Zx8Wv6Ut4Sr2Qp0n';
const STATUS = 'st4tus' + 'T0k3nQw7Er9Ty';
const PLUGIN = 'plug1n' + 'S3cr3tVa1ue9x';
const SECRETS = { ACCESS, BEARER, PASSWORD, COOKIE, KEY, STATUS, PLUGIN };

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ onMessage(message: unknown): void; send: ReturnType<typeof vi.fn> }>,
  answer: undefined as undefined | ((command: Record<string, unknown>) => unknown),
}));

/** What the fake backend answers getKnownValues with: the session's values, caught up at once. */
let knownValues: string[] = [];
const KNOWN_EPOCH = 'e1';
vi.mock('../../src/renderer/src/api-client', () => ({
  ApiClient: class {
    send = vi.fn(async (command: Record<string, unknown>) => fake.answer?.(command));
    close = vi.fn();
    constructor(
      public connection: unknown,
      public onMessage: (message: unknown) => void,
    ) {
      fake.clients.push(this);
    }
  },
}));

/** A plugin with a section that shows the URL as is, and one that hides secrets itself. */
vi.mock('@wirescry/pro/ui', async () => {
  const { PLUGIN_API_VERSION } = await import('../../src/plugin-api/version');
  return {
    uiPlugins: [
      {
        name: 'pro',
        apiVersion: PLUGIN_API_VERSION,
        views: [],
        exchangeSections: [
          {
            id: 'plain',
            label: 'Plain section',
            component: ({ exchange }: { exchange: ExchangeSummary }) => <p>Plugin sees {exchange.url}</p>,
          },
          {
            id: 'masking',
            label: 'Masking section',
            masksSecrets: true,
            component: ({ secretsHidden }: { secretsHidden?: boolean }) => (
              <p>
                {secretsHidden ? 'Plugin hides its secrets' : `Plugin shows ${'plug1n' + 'S3cr3tVa1ue9x'}`}
              </p>
            ),
          },
        ],
      },
    ],
  };
});

const { App } = await import('../../src/renderer/src/App');
const client = () => fake.clients.at(-1)!;

const b64 = (text: string): string => Buffer.from(text).toString('base64');

const exchange = summary('a', {
  method: 'POST',
  path: `/login?access_token=${ACCESS}`,
  url: `https://api.test/login?access_token=${ACCESS}`,
  statusMessage: `OK token=${STATUS}`,
  contentType: 'application/json',
  responseSize: 40,
  handledBy: { plugin: 'pro', ruleId: 'r1', label: `mock api_key=${KEY}` },
  annotations: [{ plugin: 'pro', label: 'Spec', tone: 'warn', title: `Mismatch: ${BEARER}` }],
});
const failed = summary('f', {
  path: '/f',
  url: 'https://api.test/f',
  status: undefined,
  failure: {
    kind: 'refused',
    code: 'ECONNRESET',
    message: `Couldn’t reach https://up.test/?api_key=${KEY}`,
    detail: `password=${PASSWORD}`,
  } as ExchangeSummary['failure'],
});
const socket = summary('w', {
  path: '/socket',
  url: `wss://api.test/socket?access_token=${ACCESS}`,
  protocol: 'wss',
  websocket: true,
  messageCount: 2,
  responseSize: undefined,
  status: 101,
});

const detailOf = (s: ExchangeSummary): ExchangeDetail => ({
  summary: s,
  requestHeaders: [
    ['authorization', `Bearer ${BEARER}`],
    ['cookie', `sid=${COOKIE}`],
    ['content-type', 'application/json'],
  ],
  responseHeaders: [
    ['content-type', 'application/json'],
    ['set-cookie', `sid=${COOKIE}; HttpOnly`],
  ],
  responseTrailers: [['x-api-key', KEY]],
  requestBody: { size: 30, stored: 30 },
  responseBody: { size: 40, stored: 40 },
  timing: { startTimestamp: 0, responseSentTimestamp: 12 },
});

const requestJson = `{"password":"${PASSWORD}"}`;
const responseJson = `{"access_token":"${ACCESS}","n":1}`;
const realBody = (side: string): BodyContent => ({
  base64: b64(side === 'request' ? requestJson : responseJson),
  size: 40,
  contentType: 'application/json',
  truncated: false,
});
/** As the backend masks it: text with markers, bytes overwritten, ranges. */
const maskedBody = (side: string): BodyContent => {
  const [json, secret] = side === 'request' ? [requestJson, PASSWORD] : [responseJson, ACCESS];
  const start = json.indexOf(secret);
  return {
    base64: b64(json.replace(secret, '*'.repeat(secret.length))),
    size: 40,
    contentType: 'application/json',
    truncated: false,
    masked: { text: json.replace(secret, '[redacted]'), ranges: [[start, start + secret.length]] },
  };
};

let bridge: {
  showMenu: ReturnType<typeof vi.fn>;
  setMenuState: ReturnType<typeof vi.fn>;
  saveBody: ReturnType<typeof vi.fn>;
  menu?: (command: MenuCommand) => void;
};
let clipboard: ReturnType<typeof vi.fn>;
let commands: Array<Record<string, unknown>>;
let changeState: (state: BackendState) => void = () => undefined;

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  localStorage.clear();
  fake.clients.length = 0;
  commands = [];
  knownValues = [];
  fake.answer = (command) => {
    commands.push(command);
    if (command.command === 'watchKnownValues') return command.on ? { epoch: KNOWN_EPOCH } : {};
    if (command.command === 'getKnownValues') {
      const after = command.epoch === KNOWN_EPOCH ? (command.after as number) : 0;
      return {
        epoch: KNOWN_EPOCH,
        values: knownValues.slice(after),
        next: knownValues.length,
        done: true,
        full: false,
      };
    }
    const id = command.exchangeId as string;
    const s = [exchange, failed, socket].find((e) => e.id === id)!;
    if (command.command === 'getExchange') return detailOf(s);
    if (command.command === 'getBody')
      return command.mask ? maskedBody(command.side as string) : realBody(command.side as string);
    if (command.command === 'getWebSocketMessages') {
      const hi = `hi ${BEARER}`;
      const binary = Buffer.concat([Buffer.from([0xff, 0, 0, 0xc0]), Buffer.from(BEARER)]);
      const meta = (index: number, size: number, isBinary: boolean) => ({
        index,
        fromClient: false,
        time: index,
        size,
        isBinary,
      });
      return command.mask
        ? {
            messages: [
              {
                ...meta(0, hi.length, false),
                base64: b64(hi.replace(BEARER, '*'.repeat(BEARER.length))),
                masked: { text: 'hi [redacted]', ranges: [[3, 3 + BEARER.length]] },
              },
              {
                ...meta(1, binary.length, true),
                base64: '',
                masked: { hidden: 'This body isn’t text and holds what looks like a secret.' },
              },
            ],
            dropped: 0,
            total: 2,
          }
        : {
            messages: [
              { ...meta(0, hi.length, false), base64: b64(hi) },
              { ...meta(1, binary.length, true), base64: binary.toString('base64') },
            ],
            dropped: 0,
            total: 2,
          };
    }
    if (command.command === 'getSseEvents')
      return {
        serial: 1,
        total: 2,
        receiving: false,
        items: command.mask
          ? [
              { kind: 'event', index: 1, type: 'login', data: '{"access_token":"[redacted]"}' },
              { kind: 'comment', index: 2, text: 'seen [redacted]' },
            ]
          : [
              { kind: 'event', index: 1, type: 'login', data: `{"access_token":"${ACCESS}"}` },
              { kind: 'comment', index: 2, text: `seen ${ACCESS}` },
            ],
      };
    return undefined;
  };
  const ready = {
    state: 'ready',
    connection: { apiUrl: 'ws://127.0.0.1:9001/', token: 't' },
    generation: 1,
  } as BackendState;
  bridge = {
    showMenu: vi.fn(async () => undefined),
    setMenuState: vi.fn(),
    saveBody: vi.fn(async () => ({})),
  };
  window.wirescry = new Proxy(
    {
      getBackendState: async () => ready,
      onBackendStateChanged: (callback: (state: BackendState) => void) => {
        changeState = callback;
        return () => undefined;
      },
      onMenuCommand: (callback: (command: MenuCommand) => void) => {
        bridge.menu = callback;
        return () => undefined;
      },
      ...bridge,
    },
    { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? (async () => undefined) },
  ) as unknown as WirescryBridge;
  clipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function started(rows: ExchangeSummary[] = [exchange, failed, socket]): Promise<void> {
  render(<App />);
  await act(async () => undefined);
  await act(async () =>
    client().onMessage({
      type: 'hello',
      status: { ...status(), plugins: [{ name: 'pro', active: true }] },
      exchanges: rows,
      paused: false,
    } as ServerMessage),
  );
}

const rows = () => screen.queryAllByTestId('exchange-row');
const select = async (index: number): Promise<void> => {
  await act(async () => void fireEvent.click(rows()[index]!));
  await act(async () => undefined);
  await act(async () => undefined);
};
const toggle = () => act(async () => bridge.menu!('toggle-hide-secrets'));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => undefined);
};

/** Everything the window shows or says: text, and every attribute (titles, labels, values). */
function everything(): string {
  const parts = [document.body.textContent ?? ''];
  for (const el of document.body.querySelectorAll('*')) {
    for (const attr of el.attributes) parts.push(attr.value);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) parts.push(el.value);
  }
  return parts.join('\n');
}

function leaked(text: string): string[] {
  return Object.entries(SECRETS)
    .filter(([, secret]) => text.includes(secret))
    .map(([name]) => name);
}

const copied = (): string => clipboard.mock.calls.at(-1)?.[0] as string;
const click = (name: string | RegExp) =>
  act(async () => void fireEvent.click(screen.getAllByRole('button', { name })[0]!));

describe('Hide Secrets: the window shows none', () => {
  it('shows them before it’s on (so the sweep would find them)', async () => {
    await started();
    await select(0);
    await settle();
    expect(leaked(everything())).toEqual(
      expect.arrayContaining(['ACCESS', 'BEARER', 'COOKIE', 'KEY', 'STATUS', 'PLUGIN']),
    );
  });

  it('hides every secret in the list, the details, the bodies and plugin sections', async () => {
    await started();
    await toggle();
    await select(0);
    await settle();
    expect(leaked(everything())).toEqual([]);
    expect(screen.getByText('Plugin hides its secrets')).toBeTruthy();
    expect(screen.getAllByText('Hidden while View › Hide Secrets is on.')).toHaveLength(1);
    // Asked for masked, and never for a real body.
    const bodies = commands.filter((c) => c.command === 'getBody');
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((c) => c.mask === true)).toBe(true);
    // Each view of a body: text, and hex with the secret's bytes as dots.
    for (const tab of ['Text', 'Hex']) {
      for (const button of screen.getAllByRole('button', { name: tab })) {
        await act(async () => void fireEvent.click(button));
      }
      expect(leaked(everything()), tab).toEqual([]);
    }
    expect(document.querySelector('.hex')?.textContent).toContain('••');
    // The text from the backend, with markers, not the overwritten bytes.
    for (const button of screen.getAllByRole('button', { name: 'Text' })) {
      await act(async () => void fireEvent.click(button));
    }
    expect(document.body.textContent).toContain('{"password":"[redacted]"}');
    expect(document.body.textContent).not.toContain('***');
  });

  it('masks a body’s load error', async () => {
    const answer = fake.answer!;
    fake.answer = (command) => {
      if (command.command === 'getBody') throw new Error(`failed: password=${PASSWORD}`);
      return answer(command);
    };
    await started();
    await toggle();
    await select(0);
    await settle();
    expect(screen.getAllByText('failed: password=[redacted]').length).toBeGreaterThan(0);
    expect(leaked(everything())).toEqual([]);
  });

  it('formats code masked, asking the backend for it masked', async () => {
    const answer = fake.answer!;
    const js = `var p="${PASSWORD}";`;
    fake.answer = (command) => {
      if (command.command === 'getBody' && command.side === 'response')
        return command.mask
          ? {
              base64: b64(js.replace(PASSWORD, '*'.repeat(PASSWORD.length))),
              size: 20,
              contentType: 'application/javascript',
              truncated: false,
              masked: { text: 'var p="[redacted]";', ranges: [[7, 7 + PASSWORD.length]] },
            }
          : { base64: b64(js), size: 20, contentType: 'application/javascript', truncated: false };
      if (command.command === 'formatBody') {
        commands.push(command);
        return command.mask
          ? { ok: true, language: 'js', text: 'var p = "[redacted]";' }
          : { ok: true, language: 'js', text: `var p = "${PASSWORD}";` };
      }
      return answer(command);
    };
    await started();
    await toggle();
    await select(0);
    await settle();
    expect(screen.getByText('var p = "[redacted]";')).toBeTruthy();
    const formats = commands.filter((c) => c.command === 'formatBody');
    expect(formats.length).toBeGreaterThan(0);
    expect(formats.every((c) => c.mask === true)).toBe(true);
    expect(leaked(everything())).toEqual([]);
  });

  const streamSummary = summary('s', {
    path: '/events',
    url: 'https://api.test/events',
    contentType: 'text/event-stream',
    responseSize: undefined,
  });
  const withStream = () => {
    const answer = fake.answer!;
    fake.answer = (command) =>
      command.exchangeId === 's' && command.command === 'getExchange'
        ? { ...detailOf(streamSummary), requestBody: undefined, responseBody: undefined }
        : answer(command);
  };

  it('shows a stream’s events masked, asking for them masked', async () => {
    withStream();
    await started([streamSummary]);
    await toggle();
    await select(0);
    await settle();
    expect(screen.getByText('{"access_token":"[redacted]"}')).toBeTruthy();
    expect(screen.getByText(/seen \[redacted\]/)).toBeTruthy();
    const looks = commands.filter((c) => c.command === 'getSseEvents');
    expect(looks.length).toBeGreaterThan(0);
    expect(looks.every((c) => c.mask === true)).toBe(true);
    expect(leaked(everything())).toEqual([]);
  });

  it('shows a stream’s events afresh, real, when turned off', async () => {
    withStream();
    await started([streamSummary]);
    await toggle();
    await select(0);
    await settle();
    await toggle();
    await settle();
    expect(leaked(everything())).toContain('ACCESS');
  });

  it('hides a failure’s message and detail', async () => {
    await started();
    await toggle();
    await select(1);
    await settle();
    expect(leaked(everything())).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('[redacted]');
  });

  it('shows a WebSocket’s messages masked: previews, the message opened, and search', async () => {
    await started();
    await toggle();
    await select(2);
    await settle();
    const messages = () => screen.getAllByTestId('ws-message');
    expect(messages().map((m) => m.textContent)).toEqual([
      expect.stringContaining('hi [redacted]'),
      expect.stringContaining('Hidden: This body isn’t text'),
    ]);
    const asked = commands.filter((c) => c.command === 'getWebSocketMessages');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => c.mask === true)).toBe(true);
    // Each opened, in each view.
    for (const index of [0, 1]) {
      await act(async () => void fireEvent.click(messages()[index]!));
      for (const tab of ['Text', 'Hex']) {
        for (const button of screen.queryAllByRole('button', { name: tab })) {
          await act(async () => void fireEvent.click(button));
        }
      }
      expect(leaked(everything()), `message ${index}`).toEqual([]);
      await act(async () => void fireEvent.click(messages()[index]!));
    }
    // The message opened shows the backend's text, with markers, not the overwritten bytes.
    await act(async () => void fireEvent.click(messages()[0]!));
    for (const button of screen.queryAllByRole('button', { name: 'Text' })) {
      await act(async () => void fireEvent.click(button));
    }
    expect(document.querySelector('.ws-detail')?.textContent).toContain('hi [redacted]');
    expect(document.querySelector('.ws-detail')?.textContent).not.toContain('***');
    await act(async () => void fireEvent.click(messages()[0]!));
    // The view's search runs over what it shows: a hidden value finds nothing.
    const search = screen.getByRole('searchbox', { name: 'Search messages' });
    await act(async () => void fireEvent.change(search, { target: { value: BEARER } }));
    expect(screen.queryAllByTestId('ws-message')).toHaveLength(0);
    await act(async () => void fireEvent.change(search, { target: { value: 'redacted' } }));
    expect(screen.queryAllByTestId('ws-message')).toHaveLength(1);
  });

  it('fetches a WebSocket’s messages afresh, masked, when turned on while it’s shown', async () => {
    await started();
    await select(2);
    await settle();
    expect(leaked(everything())).toContain('BEARER');
    commands.length = 0;
    await toggle();
    await settle();
    expect(leaked(everything())).toEqual([]);
    expect(commands.filter((c) => c.command === 'getWebSocketMessages').every((c) => c.mask === true)).toBe(
      true,
    );
  });

  it('masks a WebSocket view’s error', async () => {
    const answer = fake.answer!;
    fake.answer = (command) => {
      if (command.command === 'getWebSocketMessages') throw new Error(`failed: password=${PASSWORD}`);
      return answer(command);
    };
    await started();
    await toggle();
    await select(2);
    await settle();
    expect(screen.getByText('failed: password=[redacted]')).toBeTruthy();
  });

  it('copies what’s shown: the URL and a body masked; Copy as curl real', async () => {
    await started();
    await toggle();
    await select(0);
    await settle();
    await click('Copy URL');
    expect(copied()).toBe('https://api.test/login?access_token=[redacted]');
    for (const button of screen.getAllByRole('button', { name: 'Copy' })) {
      await act(async () => void fireEvent.click(button));
      expect(leaked(copied())).toEqual([]);
    }
    await click('Copy as curl');
    await settle();
    expect(copied()).toContain(BEARER);
    expect(copied()).toContain(PASSWORD);
    expect(copied()).toContain(ACCESS);
  });

  it('copies the masked URL from a row’s menu, and real curl', async () => {
    await started();
    await toggle();
    bridge.showMenu.mockResolvedValueOnce('copy-url');
    await act(async () => void fireEvent.contextMenu(rows()[0]!));
    expect(copied()).toBe('https://api.test/login?access_token=[redacted]');
    bridge.showMenu.mockResolvedValueOnce('copy-curl');
    await act(async () => void fireEvent.contextMenu(rows()[0]!));
    await settle();
    expect(copied()).toContain(ACCESS);
  });

  it('names a saved body from the masked URL', async () => {
    await started();
    await toggle();
    await select(0);
    await settle();
    await click('Save…');
    expect(bridge.saveBody).toHaveBeenCalled();
    expect(leaked(JSON.stringify(bridge.saveBody.mock.calls))).toEqual([]);
  });

  it('shows a body the backend hid as hidden, with no bytes', async () => {
    const answer = fake.answer!;
    fake.answer = (command) =>
      command.command === 'getBody' && command.side === 'response'
        ? {
            base64: '',
            size: 40,
            contentType: 'application/json',
            truncated: false,
            masked: { hidden: 'Couldn’t check this body for secrets.' },
          }
        : answer(command);
    await started();
    await toggle();
    await select(0);
    await settle();
    expect(
      screen.getByText(/Couldn’t check this body for secrets\. Turn off View › Hide Secrets to see it\./),
    ).toBeTruthy();
  });

  it('notes a binary body isn’t checked, and a full list of values', async () => {
    const answer = fake.answer!;
    fake.answer = (command) =>
      command.command === 'getBody' && command.side === 'response'
        ? {
            base64: b64('\u0000\u0001\u0002'),
            size: 3,
            contentType: 'application/octet-stream',
            truncated: false,
            masked: { ranges: [], binary: true, full: true },
          }
        : answer(command);
    await started();
    await toggle();
    await select(0);
    await settle();
    expect(screen.getByText('Binary bodies aren’t checked for secrets.')).toBeTruthy();
    expect(screen.getByText(/Some values seen earlier may not be hidden/)).toBeTruthy();
  });
});

describe('Hide Secrets: the switch', () => {
  it('is ticked in the menu, remembered, and shows a badge that turns it off', async () => {
    await started();
    expect(bridge.setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ secretsHidden: false }));
    expect(screen.queryByRole('button', { name: 'Secrets hidden' })).toBeNull();
    await toggle();
    expect(bridge.setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ secretsHidden: true }));
    expect(localStorage.getItem(HIDE_SECRETS_KEY)).toBe('1');
    expect(screen.getByRole('button', { name: 'Secrets hidden' }).title).toContain('Compose');
    await click('Secrets hidden');
    expect(screen.queryByRole('button', { name: 'Secrets hidden' })).toBeNull();
    expect(localStorage.getItem(HIDE_SECRETS_KEY)).toBeNull();
    expect(bridge.setMenuState).toHaveBeenLastCalledWith(expect.objectContaining({ secretsHidden: false }));
  });

  it('starts on when it was left on', async () => {
    localStorage.setItem(HIDE_SECRETS_KEY, '1');
    await started();
    expect(screen.getByRole('button', { name: 'Secrets hidden' })).toBeTruthy();
    await select(0);
    await settle();
    expect(leaked(everything())).toEqual([]);
  });

  it('starts on when storage can’t be read', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    await started();
    expect(screen.getByRole('button', { name: 'Secrets hidden' })).toBeTruthy();
  });

  it('works with no proxy: the menu command still turns it on', async () => {
    render(<App />);
    await act(async () => undefined);
    await toggle();
    expect(screen.getByRole('button', { name: 'Secrets hidden' })).toBeTruthy();
  });

  it('shows real values again when turned off, fetching the bodies afresh', async () => {
    await started();
    await toggle();
    await select(0);
    await settle();
    commands.length = 0;
    await toggle();
    await settle();
    expect(leaked(everything())).toEqual(expect.arrayContaining(['ACCESS', 'BEARER', 'PASSWORD']));
    const bodies = commands.filter((c) => c.command === 'getBody');
    expect(bodies.length).toBe(2);
    expect(bodies.every((c) => c.mask === undefined)).toBe(true);
  });

  it('drops a body already shown when turned on, and shows the masked one', async () => {
    await started();
    await select(0);
    await settle();
    expect(leaked(everything())).toContain('PASSWORD');
    await toggle();
    await settle();
    expect(leaked(everything())).toEqual([]);
  });
});

describe('Hide Secrets: values known from elsewhere', () => {
  // Learned by the backend from the Authorization header: no rule finds it in a path or x-echo.
  const LEARNED = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
  const repeat = summary('r', {
    path: `/u/${LEARNED}/profile`,
    url: `https://api.test/u/${LEARNED}/profile`,
    statusMessage: `Found ${LEARNED}`,
    status: 302,
    responseSize: undefined,
  });
  const plain = summary('p', { path: '/plain/page', url: 'https://api.test/plain/page' });
  const withRepeat = () => {
    const answer = fake.answer!;
    fake.answer = (command) => {
      if (command.command === 'getExchange' && command.exchangeId === 'r')
        return {
          summary: repeat,
          requestHeaders: [['authorization', `Bearer ${LEARNED}`]],
          responseHeaders: [
            ['x-echo', `you sent ${LEARNED}`],
            ['location', `https://api.test/next?state=${LEARNED}`],
            ['x-plain', 'hello-world'],
          ],
          timing: {},
        };
      if (command.command === 'getExchange' && command.exchangeId === 'p') return detailOf(plain);
      return answer(command);
    };
  };
  const learned = (text: string): boolean => text.includes(LEARNED);
  const pathCells = () => rows().map((r) => r.querySelector('.path')!.textContent);

  it('shows the repeat with the switch off', async () => {
    withRepeat();
    await started([repeat, plain]);
    await select(0);
    await settle();
    expect(learned(everything())).toBe(true);
  });

  it('hides it in the list and the detail: URL, path, message, x-echo, Location and the redirect', async () => {
    withRepeat();
    knownValues = [LEARNED];
    await started([repeat, plain]);
    await toggle();
    await settle();
    expect(pathCells()).toEqual([expect.stringContaining('/u/[redacted]/profile'), '/plain/page']);
    await select(0);
    await settle();
    expect(learned(everything())).toBe(false);
    expect(screen.getByText('you sent [redacted]')).toBeTruthy();
    // Ordinary values stay readable.
    expect(screen.getByText('hello-world')).toBeTruthy();
    await click('Copy URL');
    expect(copied()).toBe('https://api.test/u/[redacted]/profile');
  });

  it('shows "Checking…" until caught up, then the masked row; Copy URL waits', async () => {
    withRepeat();
    knownValues = [LEARNED];
    let release!: () => void;
    const answer = fake.answer!;
    fake.answer = (command) =>
      command.command === 'getKnownValues'
        ? new Promise((resolve) => (release = () => resolve(answer(command))))
        : answer(command);
    await started([repeat, plain]);
    await toggle();
    await settle();
    expect(pathCells().every((t) => t?.includes('Checking…'))).toBe(true);
    expect(screen.getAllByText('Checking for secrets').length).toBeGreaterThan(0);
    expect(learned(everything())).toBe(false);
    // The row's menu offers Copy URL, disabled, saying why.
    bridge.showMenu.mockResolvedValueOnce('copy-url');
    await act(async () => void fireEvent.contextMenu(rows()[0]!));
    expect(bridge.showMenu.mock.calls.at(-1)![0][0]).toEqual({
      id: 'copy-url',
      label: 'Copy URL (checking for secrets…)',
      enabled: false,
    });
    expect(clipboard).not.toHaveBeenCalled();
    await act(async () => release());
    await settle();
    expect(pathCells()[0]).toContain('/u/[redacted]/profile');
    expect(learned(everything())).toBe(false);
  });

  it('stays at "Checking…" when catching up fails', async () => {
    withRepeat();
    const answer = fake.answer!;
    fake.answer = (command) => {
      if (command.command === 'getKnownValues') throw new Error('not now');
      return answer(command);
    };
    await started([repeat, plain]);
    await toggle();
    await settle();
    expect(pathCells().every((t) => t?.includes('Checking…'))).toBe(true);
    expect(learned(everything())).toBe(false);
  });

  it('masks a row already shown once a push brings its value, and a new row with its own values', async () => {
    withRepeat();
    await started([repeat, plain]);
    await toggle();
    await settle();
    // Covered with no values yet: the repeat shows (a value learned later is a known limit).
    expect(pathCells()[0]).toContain(LEARNED);
    const fresh = summary('n', { path: `/n/${LEARNED}`, url: `https://api.test/n/${LEARNED}` });
    await act(async () =>
      client().onMessage({
        type: 'exchanges',
        known: { epoch: KNOWN_EPOCH, from: 0, values: [LEARNED], full: false },
        exchanges: [fresh],
        removed: [],
      } as ServerMessage),
    );
    // New rows are drawn on the next frame.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await settle();
    expect(pathCells()).toEqual([
      expect.stringContaining('/u/[redacted]/profile'),
      '/plain/page',
      expect.stringContaining('/n/[redacted]'),
    ]);
    expect(learned(everything())).toBe(false);
  });

  it('a push with a gap shows "Checking…" until it has caught up', async () => {
    withRepeat();
    await started([repeat, plain]);
    await toggle();
    await settle();
    knownValues = ['Aa1' + 'Bb2Cc3Dd4Ee5Ff6', 'Gg7' + 'Hh8Ii9Jj0Kk1Ll2', LEARNED];
    let release!: () => void;
    const answer = fake.answer!;
    fake.answer = (command) =>
      command.command === 'getKnownValues'
        ? new Promise((resolve) => (release = () => resolve(answer(command))))
        : answer(command);
    await act(async () =>
      client().onMessage({
        type: 'exchanges',
        known: { epoch: KNOWN_EPOCH, from: 2, values: [LEARNED], full: false },
        exchanges: [],
        removed: [],
      } as ServerMessage),
    );
    await settle();
    expect(pathCells().every((t) => t?.includes('Checking…'))).toBe(true);
    await act(async () => release());
    await settle();
    expect(pathCells()[0]).toContain('/u/[redacted]/profile');
  });

  it('notes a full list on the badge', async () => {
    const answer = fake.answer!;
    fake.answer = (command) =>
      command.command === 'getKnownValues'
        ? { epoch: KNOWN_EPOCH, values: [], next: 0, done: true, full: true }
        : answer(command);
    await started();
    await toggle();
    await settle();
    const badge = screen.getByRole('button', { name: 'Secrets hidden (list full)' });
    expect(badge.title).toContain(
      'Some values seen earlier may not be hidden: Wirescry’s list of them is full.',
    );
    expect(badge.className).toContain('full');
  });

  it('asks to watch only while on, and says when it’s off', async () => {
    await started();
    await settle();
    // Off: no values asked for; on a connection it only says it's off.
    expect(commands.some((c) => c.command === 'getKnownValues')).toBe(false);
    expect(commands.filter((c) => c.command === 'watchKnownValues')).toEqual([
      { command: 'watchKnownValues', on: false },
    ]);
    await toggle();
    await settle();
    expect(commands).toContainEqual({ command: 'watchKnownValues', on: true });
    await toggle();
    await settle();
    expect(commands.at(-1)).toEqual({ command: 'watchKnownValues', on: false });
  });

  it('shows rows from before a restart as can’t be checked', async () => {
    withRepeat();
    knownValues = [LEARNED];
    await started([repeat, plain]);
    await toggle();
    await settle();
    // A new backend: the old rows stay, dimmed; their values went with the old one.
    await act(async () =>
      changeState({
        state: 'ready',
        connection: { apiUrl: 'ws://127.0.0.1:9002/', token: 't' },
        generation: 2,
      } as BackendState),
    );
    await act(async () =>
      client().onMessage({ type: 'hello', status: status(), exchanges: [], paused: false } as ServerMessage),
    );
    await settle();
    expect(pathCells()).toEqual([
      expect.stringContaining('Can’t be checked for secrets'),
      expect.stringContaining('Can’t be checked for secrets'),
    ]);
    expect(learned(everything())).toBe(false);
    bridge.showMenu.mockResolvedValueOnce('copy-url');
    await act(async () => void fireEvent.contextMenu(rows()[0]!));
    expect(bridge.showMenu.mock.calls.at(-1)![0][0]).toMatchObject({ id: 'copy-url', enabled: false });
    expect(clipboard).not.toHaveBeenCalled();
  });
});
