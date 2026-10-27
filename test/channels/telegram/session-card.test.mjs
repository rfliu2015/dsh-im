import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  createAndBindSession,
  workspaceSessionListing,
} from '../../../src/channels/shared/workspace-command.mjs';
import {
  TELEGRAM_SESSION_CARD,
  TELEGRAM_WORKSPACE_CARD,
  parseTelegramSessionCallback,
} from '../../../src/channels/telegram/telegram-bridge.mjs';

async function workspaceFixture(count = 2) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-card-')));
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(root, `w${index}`);
    await mkdir(path);
    paths.push(path);
  }
  return { root, paths };
}

function stateFixture() {
  const seen = new Set();
  return {
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
  };
}

/** Sessions keyed by workspace path; the default is a small live listing. */
function sessionFixture(count = 3, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `sess-${index + 1}`,
    title: `会话 ${index + 1}`,
    time: Date.now() - (index + 1) * 60_000,
    archived: false,
    ...(overrides[index] ?? {}),
  }));
}

function policyWith({ canExecute = true, denied = [] } = {}) {
  return {
    getSettings: () => createAccessPolicy({
      direct: createAccessPolicyScope({
        mode: 'open',
        open: {
          defaultCanExecuteCommands: canExecute,
          commandPermissionOverrides: denied.map((id) => ({ id, canExecuteCommands: false })),
        },
        allowlist: { users: [] },
      }),
      group: createAccessPolicyScope({
        mode: 'open',
        open: { defaultCanExecuteCommands: canExecute, commandPermissionOverrides: [] },
        allowlist: { users: [] },
      }),
    }),
  };
}

function bridgeFixture({
  paths,
  sessions,
  current = paths[0],
  sessionCardResult = 'ok',
  sessionCard = TELEGRAM_SESSION_CARD,
  createResult = 'ok',
  bindError = null,
  accessPolicy,
} = {}) {
  const sent = [];
  const cards = [];
  const notices = [];
  const edits = [];
  const switches = [];
  const binds = [];
  const created = [];
  const listings = [];
  let sessionSeq = 0;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    state: stateFixture(),
    workspaceCard: TELEGRAM_WORKSPACE_CARD,
    sessionCard,
    accessPolicy,
    bot: {
      async sendText(_target, text) { sent.push(text); },
      async sendInteractionCard(_target, { text, markup }) {
        // Only the session card degrades; the workspace picker must still work
        // so the test proves the second message can fail on its own.
        if (sessionCardResult === 'fail' && /^会话列表|工作区：/.test(text)
          && markup.inline_keyboard.some((row) => row.length === 2)) {
          throw new Error('telegram refused the keyboard');
        }
        cards.push({ text, markup });
        return { providerMessageIds: [String(700 + cards.length)] };
      },
      async updateInteractionCard(_target, messageId, { markup, text }) {
        edits.push({ messageId, markup, ...(text === undefined ? {} : { text }) });
      },
      async answerInteractionCallback(queryId, text) {
        notices.push({ queryId, text });
      },
    },
    harness: {
      currentWorkspace: () => current,
      async listWorkspaces() { return [...paths]; },
      async listWorkspaceEntries() {
        return paths.map((path) => ({ path, title: path.split(/[\\/]/u).at(-1) }));
      },
      async switchWorkspace(path) {
        switches.push(path);
        current = path;
        return path;
      },
      async listWorkspaceSessions(workspace) {
        const table = typeof sessions === 'function' ? sessions(workspace) : sessions;
        listings.push(workspace);
        return { workspace, sessions: table ?? [] };
      },
      async createSession(options) {
        if (createResult === 'fail') throw new Error('harness refused to create a session');
        created.push(options);
        sessionSeq += 1;
        return `new-${sessionSeq}`;
      },
      async bindWorkspaceSession(conversationKey, sessionId) {
        if (bindError) throw bindError;
        binds.push({ conversationKey, sessionId });
        const known = (typeof sessions === 'function' ? sessions(current) : sessions)
          ?.find((session) => session.sessionId === sessionId);
        return {
          sessionId,
          workspace: current,
          title: known?.title ?? '新会话',
          archived: false,
        };
      },
      assertWorkspaceScope() {},
    },
    logger: { warn() {}, error() {} },
  });
  return { bridge, sent, cards, notices, edits, switches, binds, created, listings };
}

let messageSeq = 0;
function message(content, overrides = {}) {
  messageSeq += 1;
  return {
    messageId: `msg-${messageSeq}`,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content,
    addressed: true,
    replyTarget: { chatId: 42 },
    ...overrides,
  };
}

function callback(data, overrides = {}) {
  return {
    messageId: `update-${messageSeq}`,
    callbackQueryId: 'cb-1',
    providerMessageId: 700,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    addressed: true,
    replyTarget: { chatId: 42 },
    data,
    ...overrides,
  };
}

/** The session card is always the last one sent: the picker comes first. */
function sessionCard(cards) {
  return cards.at(-1);
}

function buttons(card) {
  return (card?.markup?.inline_keyboard ?? []).flat();
}

function sessionButtons(card) {
  // A single-button row is not necessarily a session row: at a page boundary
  // the pager row holds one button too. Identify a session row by its action.
  return (card?.markup?.inline_keyboard ?? [])
    .filter((row) => row.length === 1)
    .map((row) => row[0])
    .filter((button) => parseTelegramSessionCallback(button.callback_data)?.action === 'b');
}

async function press(bridge, data, overrides = {}) {
  await bridge.acceptCallback(callback(data, overrides));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Switch to a workspace by pressing its picker row, returning the session card. */
async function openSessions(fixture, index = 0, overrides = {}) {
  const picker = fixture.cards.at(-1);
  const data = (picker?.markup?.inline_keyboard ?? [])[index]?.[0]?.callback_data;
  assert.ok(data, 'the picker offered a row');
  await press(fixture.bridge, data, overrides);
  return sessionCard(fixture.cards);
}

test('a workspace press sends the session list as a second message', async () => {
  const { paths } = await workspaceFixture(2);
  const sessions = sessionFixture(3);
  const fixture = bridgeFixture({ paths, sessions });
  await fixture.bridge.accept(message('/ws'));
  assert.equal(fixture.cards.length, 1, 'only the picker exists before a press');

  await openSessions(fixture, 1);

  assert.equal(fixture.cards.length, 2, 'the session list is a new message, not an edit');
  assert.equal(fixture.edits.length, 1, 'the picker keyboard is re-marked, never re-sent');
  assert.deepEqual(fixture.switches, [paths[1]]);
  const card = sessionCard(fixture.cards);
  assert.match(card.text, /选择要绑定的会话（共 3 个）/);
  assert.equal(sessionButtons(card).length, 3, 'one row per visible session');
  assert.deepEqual(
    sessionButtons(card).map((button) => button.text),
    ['1. 会话 1', '2. 会话 2', '3. 会话 3'],
  );
});

test('a session button binds the session it names', async () => {
  const { paths } = await workspaceFixture(2);
  const sessions = sessionFixture(3);
  const fixture = bridgeFixture({ paths, sessions });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1, { providerMessageId: 701 });

  await press(fixture.bridge, sessionButtons(card)[1].callback_data, { providerMessageId: 701 });

  assert.deepEqual(fixture.binds, [{ conversationKey: 'direct:chat-a', sessionId: 'sess-2' }]);
  assert.match(fixture.notices.at(-1)?.text ?? '', /已绑定会话/);
  // The receipt is the same one /session prints, so the two paths cannot drift.
  assert.match(fixture.sent.join('\n'), /当前聊天已绑定会话：/);
  assert.match(fixture.sent.join('\n'), /ID：sess-2/);
});

test('the new-session button creates a session and binds it', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(2) });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1, { providerMessageId: 701 });

  const add = buttons(card).find((button) => button.text === '新增会话');
  assert.ok(add, 'the card offers a new-session button');
  await press(fixture.bridge, add.callback_data, { providerMessageId: 701 });

  assert.deepEqual(fixture.created, [{ conversationKey: 'direct:chat-a' }]);
  assert.deepEqual(fixture.binds, [{ conversationKey: 'direct:chat-a', sessionId: 'new-1' }]);
  assert.match(fixture.notices.at(-1)?.text ?? '', /已新建会话并绑定/);
  assert.match(fixture.sent.join('\n'), /ID：new-1/);
});

test('the return button re-opens the workspace picker', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(2) });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1, { providerMessageId: 701 });

  const back = buttons(card).find((button) => button.text === '返回');
  assert.ok(back, 'the card offers a return button');
  await press(fixture.bridge, back.callback_data, { providerMessageId: 701 });

  assert.equal(fixture.cards.length, 3, 'a fresh picker is sent');
  assert.match(fixture.cards.at(-1).text, /选择要切换的工作区（共 2 个）/);
  assert.match(fixture.notices.at(-1)?.text ?? '', /已返回工作区列表/);
});

test('an out-of-page index is refused instead of binding a neighbour', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(2) });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1);

  // index 7 is inside the callback grammar but outside this snapshot.
  const nonce = parseTelegramSessionCallback(sessionButtons(card)[0].callback_data).nonce;
  await press(fixture.bridge, `s1|${nonce}|b|7`);

  assert.deepEqual(fixture.binds, []);
  assert.match(fixture.notices.at(-1)?.text ?? '', /过期/);
});

test('an expired card cannot bind anything', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(2) });
  await fixture.bridge.accept(message('/ws'));
  await openSessions(fixture, 1);

  await press(fixture.bridge, 's1|doesnotexist|b|0');

  assert.deepEqual(fixture.binds, []);
  assert.match(fixture.notices.at(-1)?.text ?? '', /过期/);
});

test('a card from another conversation is rejected', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(2) });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1);

  await press(fixture.bridge, sessionButtons(card)[0].callback_data, {
    conversationId: 'chat-b',
  });

  assert.deepEqual(fixture.binds, []);
  assert.match(fixture.notices.at(-1)?.text ?? '', /过期/);
});

test('a press without command permission binds nothing and creates nothing', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({
    paths,
    sessions: sessionFixture(2),
    accessPolicy: policyWith({ denied: ['actor-b'] }),
  });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1);

  await press(fixture.bridge, sessionButtons(card)[0].callback_data, { senderId: 'actor-b' });
  assert.deepEqual(fixture.binds, []);
  assert.match(fixture.notices.at(-1)?.text ?? '', /权限|不能执行|没有/);

  const add = buttons(card).find((button) => button.text === '新增会话');
  await press(fixture.bridge, add.callback_data, { senderId: 'actor-b' });
  assert.deepEqual(fixture.created, [], 'the new-session button is gated too');
  assert.deepEqual(fixture.binds, []);
});

test('session card delivery failure falls back to the text list', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({
    paths,
    sessions: sessionFixture(2),
    sessionCardResult: 'fail',
  });
  await fixture.bridge.accept(message('/ws'));
  await openSessions(fixture, 1);

  // The listing must survive a refused keyboard: the reader still sees it.
  assert.match(fixture.sent.join('\n'), /会话（2）/);
  assert.match(fixture.sent.join('\n'), /ID: sess-1/);
  assert.equal(fixture.cards.length, 1, 'only the picker is on screen');
});

test('a card that cannot render still prints the text list', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({
    paths,
    sessions: sessionFixture(2),
    // A channel whose card declines to render — too many rows, an unusable
    // label — must not be able to swallow the listing it was asked to show.
    sessionCard: { render: () => null, parse: () => null },
  });
  await fixture.bridge.accept(message('/ws'));
  await openSessions(fixture, 1);

  assert.match(fixture.sent.join('\n'), /会话（2）/, 'the listing survives a refused card');
  assert.match(fixture.sent.join('\n'), /ID: sess-1/);
});

test('archived sessions never reach the card', async () => {
  const { paths } = await workspaceFixture(2);
  const sessions = sessionFixture(3, { 1: { archived: true } });
  const fixture = bridgeFixture({ paths, sessions });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1);

  assert.deepEqual(
    sessionButtons(card).map((button) => button.text),
    ['1. 会话 1', '2. 会话 3'],
    'the archived session is filtered out and the indexes close up',
  );

  await press(fixture.bridge, sessionButtons(card)[1].callback_data);
  assert.deepEqual(fixture.binds, [{ conversationKey: 'direct:chat-a', sessionId: 'sess-3' }]);
});

test('a page holds at most eight sessions and the surplus page is reachable', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(11) });
  await fixture.bridge.accept(message('/ws'));
  const first = await openSessions(fixture, 1, { providerMessageId: 701 });

  assert.equal(sessionButtons(first).length, 8, 'eight rows per page');
  assert.equal(parseTelegramSessionCallback(sessionButtons(first)[7].callback_data).index, 7);

  const next = buttons(first).find((button) => button.text === '下一页');
  await press(fixture.bridge, next.callback_data, { providerMessageId: 701 });

  const rows = sessionButtons({ markup: fixture.edits.at(-1).markup });
  assert.equal(rows.length, 3, 'the second page carries the remaining three');
  // Page two continues the same snapshot, so its first row is index 8, not 0.
  const firstRow = parseTelegramSessionCallback(rows[0].callback_data);
  assert.equal(firstRow.action, 'b');
  assert.equal(firstRow.index, 8, 'indexes continue across pages');
  assert.equal(
    firstRow.nonce,
    parseTelegramSessionCallback(sessionButtons(first)[0].callback_data).nonce,
    'both pages share one nonce, so both resolve against one snapshot',
  );
  assert.match(rows[0].text, /^9\. /, 'the printed number is the snapshot position');
});

test('one binding per press: the card is retired after it lands', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(2) });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1, { providerMessageId: 701 });
  const data = sessionButtons(card)[0].callback_data;

  await press(fixture.bridge, data, { providerMessageId: 701 });
  assert.equal(fixture.binds.length, 1);
  assert.deepEqual(
    fixture.edits.at(-1).markup,
    { inline_keyboard: [] },
    'the pressed card keeps its text but loses its keyboard',
  );
  const editsAfterFirst = fixture.edits.length;

  await press(fixture.bridge, data, { providerMessageId: 701 });
  assert.equal(fixture.binds.length, 1, 'the retired card cannot bind twice');
  assert.match(fixture.notices.at(-1)?.text ?? '', /过期/);
  assert.equal(fixture.edits.length, editsAfterFirst, 'the dead card is already retired');
});

test('a failed bind reports the same text /session uses', async () => {
  const { paths } = await workspaceFixture(2);
  const error = new Error('session is gone');
  error.code = 'session-not-found';
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(2), bindError: error });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1);

  await press(fixture.bridge, sessionButtons(card)[0].callback_data);

  assert.match(fixture.notices.at(-1)?.text ?? '', /未找到该会话/);
});

test('the session listing is the same array /session N binds', async () => {
  const { paths } = await workspaceFixture(1);
  const sessions = sessionFixture(4, { 0: { archived: true } });
  const harness = {
    currentWorkspace: () => paths[0],
    async listWorkspaceSessions() { return { workspace: paths[0], sessions }; },
    assertWorkspaceScope() {},
  };
  const listing = await workspaceSessionListing(harness, {});
  assert.deepEqual(
    listing.sessions.map((session) => session.sessionId),
    ['sess-2', 'sess-3', 'sess-4'],
    'the listing hides archived sessions and closes the numbering up',
  );
  assert.match(listing.message, /会话（3）/);
});

test('createAndBindSession binds what it created', async () => {
  const { paths } = await workspaceFixture(1);
  const bound = [];
  const harness = {
    currentWorkspace: () => paths[0],
    async createSession(options) {
      assert.deepEqual(options, { conversationKey: 'direct:chat-a' });
      return 'fresh-1';
    },
    async bindWorkspaceSession(key, sessionId) {
      bound.push({ key, sessionId });
      return { sessionId, workspace: paths[0], title: '新会话', archived: false };
    },
    assertWorkspaceScope() {},
  };
  const result = await createAndBindSession(harness, 'direct:chat-a');
  assert.equal(result.error, undefined);
  assert.deepEqual(bound, [{ key: 'direct:chat-a', sessionId: 'fresh-1' }]);
  assert.match(result.message, /ID：fresh-1/);
});

test('an untitled Session is labelled by number, never by its long id', async () => {
  const { paths } = await workspaceFixture(2);
  // A real Harness id is long enough to crowd out the row on a phone.
  const sessions = sessionFixture(2, {
    0: { title: null, sessionId: 'sess_01J8X9K2QWERTYUIOPASDFGHJKLZXCVBNM' },
    1: { title: null },
  });
  const fixture = bridgeFixture({ paths, sessions });
  await fixture.bridge.accept(message('/ws'));
  const card = await openSessions(fixture, 1, { providerMessageId: 801 });

  const rows = sessionButtons(card);
  assert.equal(rows[0].text, '1. 未命名会话 1');
  assert.equal(rows[1].text, '2. 未命名会话 2');
  for (const row of rows) {
    assert.doesNotMatch(row.text, /sess_/, 'the id never reaches the button');
  }
});

test('a page boundary offers no button that leads nowhere', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(16) });
  await fixture.bridge.accept(message('/ws'));
  const first = await openSessions(fixture, 1, { providerMessageId: 802 });

  const firstLabels = buttons(first).map((button) => button.text);
  assert.ok(firstLabels.includes('下一页'));
  assert.ok(!firstLabels.includes('上一页'), 'page one has nothing before it');
  assert.match(first.text, /第 1\/2 页/);

  const next = buttons(first).find((button) => button.text === '下一页');
  await press(fixture.bridge, next.callback_data, { providerMessageId: 802 });

  const second = { markup: fixture.edits.at(-1).markup, text: fixture.edits.at(-1).text };
  const secondLabels = buttons(second).map((button) => button.text);
  assert.ok(secondLabels.includes('上一页'));
  assert.ok(!secondLabels.includes('下一页'), 'the last page has nothing after it');
  assert.match(second.text ?? '', /第 2\/2 页/, 'the body names the page it is showing');
});

test('the page number travels with the keyboard on every turn', async () => {
  const { paths } = await workspaceFixture(2);
  const fixture = bridgeFixture({ paths, sessions: sessionFixture(20) });
  await fixture.bridge.accept(message('/ws'));

  // The first page arrives as a sent card; each turn then arrives as an edit.
  // Track the session card explicitly: the workspace picker edits too.
  let shown = await openSessions(fixture, 1, { providerMessageId: 803 });
  const editsBefore = () => fixture.edits.length;

  const step = async (label, expected) => {
    const button = buttons(shown).find((entry) => entry.text === label);
    assert.ok(button, `${label} is offered`);
    const before = editsBefore();
    await press(fixture.bridge, button.callback_data, { providerMessageId: 803 });
    assert.equal(fixture.edits.length, before + 1, 'a turn edits exactly once');
    const edit = fixture.edits.at(-1);
    assert.match(edit.text, new RegExp(expected), 'the body follows the page');
    assert.ok(edit.markup, 'the keyboard follows the body');
    shown = { markup: edit.markup, text: edit.text };
  };

  // Twenty Sessions is three pages: forward twice, then back once.
  await step('下一页', '第 2/3 页');
  await step('下一页', '第 3/3 页');
  await step('上一页', '第 2/3 页');
});

