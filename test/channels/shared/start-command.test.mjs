import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isSharedLocalCommand } from '../../../src/channels/shared/command-permission.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import { TELEGRAM_WORKSPACE_CARD } from '../../../src/channels/telegram/telegram-bridge.mjs';

async function workspaceFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'start-command-')));
  const paths = [join(root, 'w0'), join(root, 'w1')];
  for (const path of paths) await mkdir(path);
  return { paths };
}

/**
 * A bridge with the picker wired, the way Telegram builds one, plus the state
 * and harness surface /start reads. `session` is the bound Session id and
 * `sessions` the listing its title is read from.
 */
function bridgeFixture({
  paths,
  current = paths[0],
  session = null,
  sessions = [],
  listSessions = null,
  override = false,
  failWorkspace = false,
  cardResult = 'ok',
} = {}) {
  const sent = [];
  const cards = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    state: {
      hasSeen: () => false,
      async markSeen() {},
      sessionFor: () => session,
    },
    workspaceCard: TELEGRAM_WORKSPACE_CARD,
    bot: {
      async sendText(_target, text) { sent.push(text); },
      async sendInteractionCard(_target, { text, markup }) {
        if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
        cards.push({ text, markup });
        return { providerMessageIds: [String(900 + cards.length)] };
      },
      async updateInteractionCard() {},
      async answerInteractionCallback() {},
    },
    harness: {
      currentWorkspace: () => {
        if (failWorkspace) throw new Error('harness down');
        return current;
      },
      currentConversationWorkspace: () => {
        if (failWorkspace) throw new Error('harness down');
        return current;
      },
      hasConversationWorkspaceOverride: () => override,
      async listWorkspaces() { return [...paths]; },
      async listWorkspaceEntries() {
        return paths.map((path) => ({ path, title: '' }));
      },
      async listWorkspaceSessions() {
        if (listSessions) return listSessions();
        return { workspace: current, sessions };
      },
      async switchWorkspace(path) { return path; },
    },
  });
  return { bridge, sent, cards };
}

function message(content) {
  return {
    messageId: `m-${content}`, senderId: '42', kind: 'direct', conversationId: '88',
    content, replyTarget: {},
  };
}

test('/start is classified as a local command so the access policy gates it', () => {
  // Without this the status screen leaks workspace paths and Session titles to
  // a sender who may not run commands at all.
  assert.equal(isSharedLocalCommand('/start'), true);
});

test('/start reports the workspace, its binding mode, and the bound Session', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, sent } = bridgeFixture({
    paths,
    session: 'sess-1',
    sessions: [{ sessionId: 'sess-1', title: 'Fix the /start command', archived: false }],
  });
  await bridge.accept(message('/start'));

  assert.equal(sent.length, 1, 'the status is one message of its own');
  const status = sent[0];
  assert.match(status, /当前对话工作区：/);
  assert.match(status, new RegExp(paths[0].replace(/[\\]/g, '\\\\')));
  assert.match(status, /状态：未显式绑定/);
  assert.match(status, /当前会话：sess-1/);
  assert.match(status, /会话标题：Fix the \/start command/);
});

test('/start distinguishes an explicitly bound conversation from the bot default', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, sent } = bridgeFixture({ paths, override: true, session: 'sess-1' });
  await bridge.accept(message('/start'));
  assert.match(sent[0], /状态：已为该对话显式绑定/);
});

test('/start says plainly that no Session is bound yet', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, sent } = bridgeFixture({ paths, session: null });
  await bridge.accept(message('/start'));
  assert.match(sent[0], /本聊天尚未绑定会话/);
  assert.doesNotMatch(sent[0], /会话标题：/);
});

test('/start still answers when the Session title cannot be read', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, sent } = bridgeFixture({
    paths,
    session: 'sess-1',
    listSessions: () => { throw new Error('session.list failed'); },
  });
  await bridge.accept(message('/start'));
  // The id is the part that binds, so a failed title must not cost the reader it.
  assert.match(sent[0], /当前会话：sess-1/);
  assert.match(sent[0], /会话标题：标题暂不可用/);
});

test('/start reports an unreadable workspace instead of failing silently', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, sent } = bridgeFixture({ paths, failWorkspace: true });
  await bridge.accept(message('/start'));
  assert.match(sent[0], /暂时无法读取当前工作区/);
});

test('/start offers the same workspace picker /ws sends', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, cards } = bridgeFixture({ paths });
  await bridge.accept(message('/start'));
  assert.equal(cards.length, 1, 'a channel with a keyboard gets the picker');
  // One button per workspace, and the current one is marked.
  assert.equal(cards[0].markup.inline_keyboard.length, paths.length);
  assert.match(cards[0].markup.inline_keyboard[0][0].text, /^✓ /);
});

test('/start falls back to the text list when the keyboard cannot be sent', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, sent, cards } = bridgeFixture({ paths, cardResult: 'fail' });
  await bridge.accept(message('/start'));
  assert.equal(cards.length, 0);
  // Status first, then the text listing the card would have replaced.
  assert.match(sent[0], /当前对话工作区：/);
  assert.ok(sent.slice(1).some((text) => text.includes(paths[0])),
    'the workspace list must still reach the reader');
});

test('/start ignores a deep-link payload rather than reporting a usage error', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, sent } = bridgeFixture({ paths });
  await bridge.accept(message('/start ref-123'));
  // Telegram deep links carry a parameter; the first screen must still appear.
  assert.match(sent[0], /当前对话工作区：/);
});

test('/start with an image is not treated as the command', async () => {
  const { paths } = await workspaceFixture();
  const { bridge, sent } = bridgeFixture({ paths });
  await bridge.accept({
    ...message('/start'),
    messageId: 'm-image',
    images: [{ id: 'img-1', mimeType: 'image/png', bytes: Buffer.from([1, 2, 3]) }],
  });
  assert.equal(sent.filter((text) => /当前对话工作区：/.test(text)).length, 0);
});
