/**
 * Workspace hierarchy, derived from paths alone.
 *
 * DSH's sidebar "Workspace Tree" builds exactly this shape with
 * `owningParentFolder(path, paths)`: the nearest REGISTERED ancestor by path
 * prefix, with separators normalised and matching kept case-sensitive like
 * workspace identity. No parentId is stored anywhere, so a folder that is not
 * itself a registered workspace (e.g. `AcGrSys/demands`) is simply skipped and
 * its descendants attach to the nearest registered one.
 *
 * Keeping the same rule here means the Telegram card and the sidebar cannot
 * disagree about which level a workspace is on. Every index below is a position
 * in the caller's `paths` array, so a button keeps naming the same absolute
 * index the text list and `/ws N` use.
 */

/** Windows drive/UNC paths use `\` as a separator; POSIX ones must not be rewritten. */
function folderPath(path) {
  if (typeof path !== 'string') return '';
  const normalized = /^[A-Za-z]:[/\\]/u.test(path) || path.startsWith('\\\\')
    ? path.replaceAll('\\', '/')
    : path;
  return normalized.replace(/\/+$/u, '');
}

/**
 * For each path, the index of its nearest registered ancestor, or null when it
 * is a root. Ties cannot happen: two distinct strings cannot both be the
 * longest prefix of a third.
 */
export function workspaceParentIndices(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const folders = list.map(folderPath);
  return folders.map((child, index) => {
    let owner = null;
    let length = -1;
    for (const [candidate, root] of folders.entries()) {
      if (candidate !== index
        && root.length > length
        && child !== root
        && child.startsWith(`${root}/`)) {
        owner = candidate;
        length = root.length;
      }
    }
    return owner;
  });
}

/** Precompute the tree once: a card renders many rows from one listing. */
export function workspaceTree(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const parents = workspaceParentIndices(list);
  return {
    size: list.length,
    parents,
    hasHierarchy: parents.some((owner) => owner !== null),
    /** Direct children of `parent` (null = roots). */
    childrenOf(parent = null) {
      return parents.flatMap((owner, index) => (owner === parent ? [index] : []));
    },
    /** Direct-child count; zero means a leaf that cannot be drilled into. */
    childCount(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= list.length) return 0;
      return parents.filter((owner) => owner === index).length;
    },
    parentOf(index) {
      return Number.isSafeInteger(index) ? parents[index] ?? null : null;
    },
  };
}
