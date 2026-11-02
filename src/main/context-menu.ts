/** Builds the right-click menu for the app window. No Electron imports, so it's testable. */
import type { MenuChoice } from '../shared/ipc';

export interface ContextMenuParams {
  isEditable: boolean;
  selectionText: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
export type ContextMenuItem = { role: EditRole; enabled: boolean } | { type: 'separator' };

/**
 * Text fields get the usual edit menu. Elsewhere, selected text can be copied. Anything
 * else gets no menu, so the result is empty.
 */
export function contextMenuItems(params: ContextMenuParams): ContextMenuItem[] {
  const flags = params.editFlags;
  if (params.isEditable)
    return [
      { role: 'undo', enabled: true },
      { role: 'redo', enabled: true },
      { type: 'separator' },
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: flags.canSelectAll },
    ];
  if (params.selectionText.trim() !== '') return [{ role: 'copy', enabled: flags.canCopy }];
  return [];
}

const MAX_CHOICES = 40;

/** The menu the UI asked for, checked, or an error if it isn't one. */
export function checkMenuChoices(value: unknown): MenuChoice[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHOICES) {
    throw new Error('A menu needs 1 to 40 items.');
  }
  return value.map((item: unknown): MenuChoice => {
    const choice = item as Record<string, unknown> | null;
    if (typeof choice !== 'object' || choice === null) throw new Error('Menu items must be objects.');
    if (choice.separator === true) return { separator: true };
    const { id, label, enabled } = choice;
    if (typeof id !== 'string' || id === '' || id.length > 200) throw new Error('A menu item needs an id.');
    if (typeof label !== 'string' || label.trim() === '' || label.length > 100) {
      throw new Error('A menu item needs a label of up to 100 characters.');
    }
    return { id, label, ...(enabled === false ? { enabled: false } : {}) };
  });
}
