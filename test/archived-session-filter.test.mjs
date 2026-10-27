import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'archived-filter-')));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  return { root, workspace };
}

function harnessFor(workspace, sessions, onBind = () => {}) {
  return {
    currentWorkspace() { return workspace; },
    async listWorkspaceSessions() { return { workspace, sessions }; },
    async bindWorkspaceSession(_key, sessionId) {
      onBind(sessionId);
      const session = sessions.find((item) => item.sessionId === sessionId);
      return { workspace, sessionId, title: session?.title ?? null, archived: false };
    },
  };
}

const MIXED = [
  { sessionId: 's-live-1', title: 'Live one', archived: false, summaryAvailable: true },
  { sessionId: 's-gone-1', title: 'Archived one', archived: true, summaryAvailable: true },
  { sessionId: 's-live-2', title: 'Live two', archived: false, summaryAvailable: true },
  { sessionId: 's-gone-2', title: 'Archived two', archived: true, summaryAvailable: true },
  { sessionId: 's-live-3', title: 'Live three', archived: false, summaryAvailable: true },
];

test('/sessionlist omits archived sessions from the listing', async (t) => {
  const { workspace } = await fixture(t);
  const result = await runWorkspaceCommand('/sessionlist', harnessFor(workspace, MIXED));

  assert.match(result.message, /会话（3）/);
  assert.match(result.message, /1\. Live one/);
  assert.match(result.message, /2\. Live two/);
  assert.match(result.message, /3\. Live three/);
  assert.doesNotMatch(result.message, /s-gone-1|s-gone-2/);
  assert.doesNotMatch(result.message, /已归档/);
});

test('--limit bounds the visible sessions, not the raw ones', async (t) => {
  const { workspace } = await fixture(t);
  const result = await runWorkspaceCommand('/sessionlist --limit 2', harnessFor(workspace, MIXED));

  // Counting archived entries against the quota would leave only one row here.
  assert.match(result.message, /1\. Live one/);
  assert.match(result.message, /2\. Live two/);
  assert.doesNotMatch(result.message, /Live three|s-gone/);
});

test('/session N resolves against the same array the listing printed', async (t) => {
  const { workspace } = await fixture(t);
  const bound = [];
  const harness = harnessFor(workspace, MIXED, (sessionId) => bound.push(sessionId));

  // Index 2 in the printed list is the third live session, never an archived one.
  const listing = await runWorkspaceCommand('/sessionlist', harness);
  assert.match(listing.message, /3\. Live three/);

  await runWorkspaceCommand('/session 3', harness, 'direct:chat');
  assert.deepEqual(bound, ['s-live-3']);

  await runWorkspaceCommand('/session 1', harness, 'direct:chat');
  assert.deepEqual(bound, ['s-live-3', 's-live-1']);
});

test('an index past the visible tail is rejected even though raw sessions exist', async (t) => {
  const { workspace } = await fixture(t);
  const bound = [];
  const harness = harnessFor(workspace, MIXED, (sessionId) => bound.push(sessionId));

  // Five raw sessions, three visible: 4 and 5 must not reach an archived one.
  const result = await runWorkspaceCommand('/session 4', harness, 'direct:chat');
  assert.match(result.message, /会话序号不存在/);
  assert.deepEqual(bound, []);
});

test('a full archived workspace reads as empty rather than listing archive noise', async (t) => {
  const { workspace } = await fixture(t);
  const sessions = [
    { sessionId: 'a-1', title: 'Old', archived: true, summaryAvailable: true },
    { sessionId: 'a-2', title: 'Older', archived: true, summaryAvailable: true },
  ];
  const result = await runWorkspaceCommand('/sessionlist', harnessFor(workspace, sessions));

  assert.match(result.message, /该工作区暂无会话/);
  assert.doesNotMatch(result.message, /a-1|a-2/);
});

test('binding a full archived Session ID still works', async (t) => {
  const { workspace } = await fixture(t);
  const bound = [];
  const harness = harnessFor(workspace, MIXED, (sessionId) => bound.push(sessionId));

  // Filtering is a listing policy; an explicit ID must stay reachable.
  const result = await runWorkspaceCommand('/session s-gone-1', harness, 'direct:chat');
  assert.deepEqual(bound, ['s-gone-1']);
  assert.match(result.message, /当前聊天已绑定会话/);
});
