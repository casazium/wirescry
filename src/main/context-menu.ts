/** Builds the right-click menu for the app window. No Electron imports, so it's testable. */

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
