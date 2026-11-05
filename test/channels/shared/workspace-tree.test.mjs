import assert from 'node:assert/strict';
import test from 'node:test';

import { workspaceParentIndices, workspaceTree } from '../../../src/channels/shared/workspace-tree.mjs';

test('flat paths have no parents and no hierarchy', () => {
  const paths = ['E:\\a', 'E:\\b', 'E:\\c'];
  assert.deepEqual(workspaceParentIndices(paths), [null, null, null]);
  const tree = workspaceTree(paths);
  assert.equal(tree.hasHierarchy, false);
  assert.deepEqual(tree.childrenOf(null), [0, 1, 2]);
});

test('the nearest REGISTERED ancestor wins; an unregistered middle folder is skipped', () => {
  const paths = [
    'E:\\proj',
    'E:\\proj\\demands\\alpha',
    'E:\\proj\\demands\\beta',
    'E:\\other',
  ];
  // `demands` is not registered, so alpha/beta attach to `proj` directly.
  assert.deepEqual(workspaceParentIndices(paths), [null, 0, 0, null]);
  const tree = workspaceTree(paths);
  assert.equal(tree.hasHierarchy, true);
  assert.deepEqual(tree.childrenOf(null), [0, 3]);
  assert.deepEqual(tree.childrenOf(0), [1, 2]);
  assert.equal(tree.childCount(0), 2);
  assert.equal(tree.childCount(1), 0);
  assert.equal(tree.parentOf(1), 0);
});

test('a three-level chain keeps the immediate registered parent', () => {
  const paths = [
    'E:\\root',
    'E:\\root\\level2',
    'E:\\root\\level2\\level3',
  ];
  assert.deepEqual(workspaceParentIndices(paths), [null, 0, 1]);
  const tree = workspaceTree(paths);
  assert.deepEqual(tree.childrenOf(0), [1]);
  assert.deepEqual(tree.childrenOf(1), [2]);
  assert.deepEqual(tree.childrenOf(2), []);
});

test('Windows separators are normalised and matching stays case-sensitive', () => {
  const paths = ['E:/Code/Proj', 'E:\\Code\\Proj\\sub', 'E:\\code\\Proj\\sub'];
  // The third path differs only in drive-letter case; like DSH, identity is
  // case-sensitive, so it is NOT a child of the first.
  assert.deepEqual(workspaceParentIndices(paths), [null, 0, null]);
});

test('a trailing separator does not create a false parent', () => {
  const paths = ['/srv/a/', '/srv/a/b'];
  assert.deepEqual(workspaceParentIndices(paths), [null, 0]);
});

test('out-of-range and malformed indices are safe', () => {
  const tree = workspaceTree(['E:\\a', 'E:\\a\\b']);
  assert.equal(tree.childCount(-1), 0);
  assert.equal(tree.childCount(99), 0);
  assert.equal(tree.parentOf(null), null);
  assert.deepEqual(workspaceTree(null).childrenOf(null), []);
});
