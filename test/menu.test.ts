import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { name: 'Wirescry' },
  // The template itself is what the test reads.
  Menu: { buildFromTemplate: (template: unknown) => template },
}));
const { buildMenu, updateMenu } = await import('../src/main/menu');
const { DOCS_URL } = await import('../src/main/about');

type Item = {
  id?: string;
  label?: string;
  role?: string;
  accelerator?: string;
  enabled?: boolean;
  type?: string;
  submenu?: Item[];
  click?: () => void;
};

describe('Help menu', () => {
  it('opens the documentation', () => {
    const actions = {
      devTools: false,
      showLogFile: vi.fn(),
      checkForUpdates: vi.fn(),
      showAbout: vi.fn(),
      command: vi.fn(),
      openDocumentation: vi.fn(),
      openWebsite: vi.fn(),
      reportProblem: vi.fn(),
    };
    const template = buildMenu(actions) as unknown as Item[];
    const help = template.find((item) => item.role === 'help')!;
    const labels = help.submenu!.map((item) => item.label).filter(Boolean);
    // First of the links, ahead of the website and the issue tracker.
    expect(labels.indexOf('Documentation')).toBeLessThan(labels.indexOf('Wirescry Website'));
    help.submenu!.find((item) => item.label === 'Documentation')!.click!();
    expect(actions.openDocumentation).toHaveBeenCalledOnce();
    expect(actions.openWebsite).not.toHaveBeenCalled();
  });

  it('points at the Wirescry section of the docs site', () => {
    expect(DOCS_URL).toBe('https://docs.casazium.com/docs/wirescry/intro');
  });
});

describe('File menu', () => {
  const actions = () => ({
    devTools: false,
    showLogFile: vi.fn(),
    checkForUpdates: vi.fn(),
    showAbout: vi.fn(),
    command: vi.fn(),
    openDocumentation: vi.fn(),
    openWebsite: vi.fn(),
    reportProblem: vi.fn(),
  });
  const items = (template: Item[]): Item[] =>
    template.flatMap((item) => [item, ...items(item.submenu ?? [])]);

  it('has Export HAR, redacted, on the shortcut, and Export HAR Without Redaction beside it', () => {
    const a = actions();
    const all = items(buildMenu(a) as unknown as Item[]);
    const redacted = all.find((item) => item.id === 'export-har')!;
    const plain = all.find((item) => item.id === 'export-har-unredacted')!;
    expect(redacted).toMatchObject({ label: 'Export HAR…', accelerator: 'CmdOrCtrl+S', enabled: false });
    expect(plain).toMatchObject({ label: 'Export HAR Without Redaction…', enabled: false });
    expect(plain.accelerator).toBeUndefined();
    redacted.click!();
    plain.click!();
    expect(a.command.mock.calls).toEqual([['export-har'], ['export-har-unredacted']]);
  });

  it('enables both exports together, when there’s something to export', () => {
    const state: Record<string, { enabled: boolean }> = {
      'export-har': { enabled: false },
      'export-har-unredacted': { enabled: false },
    };
    const menu = { getMenuItemById: (id: string) => state[id] } as never;
    updateMenu(menu, { connected: true, canExport: true, paused: false } as never);
    expect([state['export-har']!.enabled, state['export-har-unredacted']!.enabled]).toEqual([true, true]);
    updateMenu(menu, { connected: true, canExport: false, paused: false } as never);
    expect([state['export-har']!.enabled, state['export-har-unredacted']!.enabled]).toEqual([false, false]);
    updateMenu(menu, { connected: false, canExport: true, paused: false } as never);
    expect([state['export-har']!.enabled, state['export-har-unredacted']!.enabled]).toEqual([false, false]);
  });
});

describe('View › Hide Secrets', () => {
  const actions = () => ({
    devTools: false,
    showLogFile: vi.fn(),
    checkForUpdates: vi.fn(),
    showAbout: vi.fn(),
    command: vi.fn(),
    openDocumentation: vi.fn(),
    openWebsite: vi.fn(),
    reportProblem: vi.fn(),
  });

  it('is a checkbox in View that sends its command', () => {
    const a = actions();
    const view = (buildMenu(a) as unknown as Item[]).find((item) => item.label === 'View')!;
    const item = view.submenu!.find((i) => i.id === 'hide-secrets')!;
    expect(item).toMatchObject({ label: 'Hide Secrets', type: 'checkbox', enabled: false });
    item.click!();
    expect(a.command.mock.calls).toEqual([['toggle-hide-secrets']]);
  });

  it('is ticked from the window, with or without the proxy, and off with no window', () => {
    const item = { enabled: false, checked: false };
    const menu = { getMenuItemById: (id: string) => (id === 'hide-secrets' ? item : undefined) } as never;
    updateMenu(menu, { connected: false, canExport: false, paused: false, secretsHidden: true });
    expect(item).toEqual({ enabled: true, checked: true });
    updateMenu(menu, { connected: true, canExport: false, paused: false, secretsHidden: false });
    expect(item).toEqual({ enabled: true, checked: false });
    updateMenu(menu, {
      connected: false,
      canExport: false,
      paused: false,
      secretsHidden: false,
      window: false,
    });
    expect(item).toEqual({ enabled: false, checked: false });
  });
});
