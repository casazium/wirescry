import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { name: 'Wirescry' },
  // The template itself is what the test reads.
  Menu: { buildFromTemplate: (template: unknown) => template },
}));
const { buildMenu } = await import('../src/main/menu');
const { DOCS_URL } = await import('../src/main/about');

type Item = { label?: string; role?: string; submenu?: Item[]; click?: () => void };

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
