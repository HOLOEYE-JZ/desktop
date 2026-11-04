/**
 * The roots main serves to the page's sync engine: folders the user picked
 * (features/files-folders.ts keeps and persists those) and the Windows drive's sync
 * roots (features/files-drive.ts). Every disk call names a root by id, and only a root
 * listed here resolves to a directory. Nothing here touches the disk.
 */

import type { FilesPlaceholderState, FilesRoot } from '../../shared/bridge';

export interface RegisteredRoot {
  root: FilesRoot;
  /** The absolute directory, resolved (no links), as main checks paths against it. */
  dir: string;
  /** The drive: the placeholder state of a path under `dir`, for `scan` and `stat`. */
  placeholderState?: (absolutePath: string) => FilesPlaceholderState | null;
  /** The drive: true for a file whose content isn't on disk, which `openRead` must refuse (reading would ask the page for it). */
  contentAbsent?: (absolutePath: string) => boolean;
}

type Listener = (roots: FilesRoot[]) => void;

const roots = new Map<string, RegisteredRoot>();
const listeners = new Set<Listener>();

function emit(): void {
  const list = [...roots.values()].map((entry) => entry.root);
  for (const listener of listeners) listener(list);
}

export const filesRegistry = {
  get(id: unknown): RegisteredRoot | null {
    return typeof id === 'string' ? roots.get(id) ?? null : null;
  },
  list(): RegisteredRoot[] {
    return [...roots.values()];
  },
  add(entry: RegisteredRoot): void {
    roots.set(entry.root.id, entry);
    emit();
  },
  update(id: string, patch: Partial<FilesRoot>): void {
    const entry = roots.get(id);
    if (!entry) return;
    entry.root = { ...entry.root, ...patch };
    emit();
  },
  remove(id: string): void {
    if (roots.delete(id)) emit();
  },
  onChange(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
