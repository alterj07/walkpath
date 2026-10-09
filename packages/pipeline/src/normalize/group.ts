import { normalizeTitle } from './title.ts';

export interface GroupKeyInput {
  title: string;
  boardId: string;
  internalReqId?: string | null | undefined;
}

/**
 * Key for multi-location fan-out (plan 4.6 layer 3): one requisition posted as many city
 * variants shares a board and a normalized title (or a requisition id), so the table can
 * show one row with "N locations" and the detail page can list them.
 */
export function groupKey(input: GroupKeyInput): string {
  const { title } = normalizeTitle(input.title);
  const t = title
    .toLowerCase()
    .replace(/\b(multiple locations|various locations|remote|hybrid|on-?site)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const req = input.internalReqId ? `req:${input.internalReqId.trim().toLowerCase()}` : `title:${t}`;
  return `${input.boardId}|${req}`;
}
