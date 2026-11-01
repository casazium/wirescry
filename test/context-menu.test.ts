import { describe, expect, it } from 'vitest';
import { contextMenuItems, type ContextMenuParams } from '../src/main/context-menu';

const flags = { canCut: false, canCopy: false, canPaste: true, canSelectAll: true };
const roles = (params: ContextMenuParams): string[] =>
  contextMenuItems(params).map((i) => ('role' in i ? i.role : '-'));

describe('contextMenuItems', () => {
  it('offers the edit menu in a text field, with paste enabled', () => {
    const params = { isEditable: true, selectionText: '', editFlags: flags };
    expect(roles(params)).toEqual(['undo', 'redo', '-', 'cut', 'copy', 'paste', '-', 'selectAll']);
    expect(contextMenuItems(params)).toContainEqual({ role: 'paste', enabled: true });
    expect(contextMenuItems(params)).toContainEqual({ role: 'cut', enabled: false });
  });

  it('offers only Copy for selected text outside a text field', () => {
    const params = { isEditable: false, selectionText: 'GET /api', editFlags: { ...flags, canCopy: true } };
    expect(contextMenuItems(params)).toEqual([{ role: 'copy', enabled: true }]);
  });

  it('offers nothing when there is no text field or selection', () => {
    expect(contextMenuItems({ isEditable: false, selectionText: ' ', editFlags: flags })).toEqual([]);
  });
});
