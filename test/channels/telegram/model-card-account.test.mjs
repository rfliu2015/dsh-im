import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';
import {
  externalCardForProvider,
  normalizeExternalCards,
} from '../../../src/channels/shared/external-card-command.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  TELEGRAM_MODEL_CARD,
  parseTelegramModelCallback,
} from '../../../src/channels/telegram/telegram-bridge.mjs';

/**
 * Two provider routes publishing an identically-named model, which is the live
 * shape this feature exists for: `workbuddy` and `workbuddy-global` both offer
 * `deepseek-v4.1-flash`, and the two resolve to different account lists.
 */
const CATALOG = {
  groups: [
    { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'deepseek-v4.1-flash', name: 'F' }] },
    { id: 'workbuddy-global', name: 'WorkBuddy Global', models: [{ id: 'deepseek-v4.1-flash', name: 'F' }] },
    { id: 'llm-deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'F' }] },
  ],
  failures: [],
};

const SPEC = {
  version: 1,
  cards: [
    {
      command: '/wb',
      title: 'Accounts CN',
      providers: ['workbuddy'],
      list: { url: '{base}/usage?region=cn', items: 'accounts', id: 'id', label: 'accountName' },
      actions: [{ post: '{base}/save', body: { field: 'accounts', value: { cn: '{id}' } } }],
    },
    {
      command: '/wbg',
      title: 'Accounts Global',
      providers: ['workbuddy-global'],
      list: { url: '{base}/usage?region=global', items: 'accounts', id: 'id', label: 'accountName' },
      actions: [{ post: '{base}/save', body: { field: 'accounts', value: { global: '{id}' } } }],
    },
  ],
};

function accessPolicy() {
  const scope = () => createAccessPolicyScope({
    mode: 'open',
    open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  });
  return { getSettings: () => createAccessPolicy({ direct: scope(), group: scope() }) };
}

function fixture({ catalog = CATALOG, current, cards = SPEC, origin = null } = {}) {
  const modelCards = [];
  const sent = [];
  const notices = [];
  const selections = [];
  const opened = [];
  let selection = current
    ?? { provider: 'workbuddy', model: 'deepseek-v4.1-flash' };

  const session = {
    async sessionExists() { return true; },
    async models() { return { ...catalog, current: selection }; },
    async isRunning() { return false; },
    async hasActiveTurn() { return false; },
    async selectModel(next) { selections.push(next); selection = next; return { selected: next }; },
  };

  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    state: { hasSeen: () => false, async markSeen() {}, sessionFor: () => 's1', async setSession() {} },
    modelCard: TELEGRAM_MODEL_CARD,
    externalCard: {
      render(listing) { opened.push(listing); return null; },
      parse: () => null,
    },
    externalCards: normalizeExternalCards(cards).cards,
    externalCardBaseUrl: origin ? () => origin : () => null,
    accessPolicy: accessPolicy(),
    bot: {
      async sendText(_t, text) { sent.push(text); },
      async sendInteractionCard(_t, card) { modelCards.push(card); return { providerMessageIds: ['9'] }; },
      async updateInteractionCard() {},
      async answerInteractionCallback(_q, text) { notices.push(text); },
    },
    harness: {
      workspaceSession: () => session,
      currentWorkspace: () => '/w',
      async listWorkspaces() { return ['/w']; },
    },
    logger: { warn() {}, info() {}, error() {} },
  });
  return { bridge, modelCards, sent, notices, selections, opened };
}

function message(content) {
  return {
    messageId: `m-${content}`, senderId: 'a', senderIsBot: false, kind: 'direct',
    conversationId: 'c', content, addressed: true, replyTarget: { chatId: 1 },
  };
}

function callback(data) {
  return {
    messageId: 'u', callbackQueryId: 'cb', providerMessageId: 9, senderId: 'a',
    senderIsBot: false, kind: 'direct', conversationId: 'c', addressed: true,
    replyTarget: { chatId: 1 }, data,
  };
}

function modelRow(card, index) {
  return (card?.markup?.inline_keyboard ?? []).flat()
    .find((button) => parseTelegramModelCallback(button.callback_data)?.index === index);
}

test('providers is optional and defaults to no provider', () => {
  const { cards, error } = normalizeExternalCards({
    version: 1,
    cards: [{ ...SPEC.cards[0], providers: undefined }],
  });
  assert.equal(error, undefined);
  assert.deepEqual(cards[0].providers, []);
});

test('a malformed providers entry rejects the whole spec', () => {
  for (const providers of ['workbuddy', [''], [42], ['has space']]) {
    const result = normalizeExternalCards({
      version: 1,
      cards: [{ ...SPEC.cards[0], providers }],
    });
    assert.ok(result.error, JSON.stringify(providers));
    assert.deepEqual(result.cards, [], 'no partial cards');
  }
});

test('a provider route resolves to the card that declared it', () => {
  const { cards } = normalizeExternalCards(SPEC);
  assert.equal(externalCardForProvider('workbuddy', cards).command, '/wb');
  assert.equal(externalCardForProvider('workbuddy-global', cards).command, '/wbg');
  assert.equal(externalCardForProvider('llm-deepseek', cards), undefined);
  assert.equal(externalCardForProvider(undefined, cards), undefined);
});

test('the model card carries no separate account button', async () => {
  const f = fixture();
  await f.bridge.accept(message('/models'));
  const buttons = (f.modelCards[0]?.markup?.inline_keyboard ?? []).flat();
  assert.ok(buttons.length > 0, 'the card has model rows');
  assert.deepEqual(
    [...new Set(buttons.map((b) => parseTelegramModelCallback(b.callback_data)?.action))],
    ['s'],
    'only model rows — the account list is reached by pressing the current row',
  );
});

test('a model press offers the account list for the chosen provider', async () => {
  await withAccounts(async (origin) => {
    const f = fixture({ origin });
    await f.bridge.accept(message('/models'));
    // Index 1 is workbuddy/deepseek-v4.1-flash; index 2 is the GLOBAL one with
    // the same model id. Pressing the second must offer the global account list.
    const row = modelRow(f.modelCards[0], 2);
    assert.ok(row, 'the global row is on the card');

    await f.bridge.acceptCallback(callback(row.callback_data));
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(f.selections, [{ provider: 'workbuddy-global', model: 'deepseek-v4.1-flash' }]);
    assert.equal(f.opened.length, 1, 'the account list was read after the switch');
    assert.equal(f.opened[0].title, 'Accounts Global', 'the card for the provider just chosen');
  });
});

test('pressing the CURRENT model row still offers the account list', async () => {
  // This is the whole reason the separate button was removed: the current row is
  // the account-switch entry point, so re-selecting the model already in use
  // must go through the same path and open the same list.
  await withAccounts(async (origin) => {
    const f = fixture({ origin, current: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } });
    await f.bridge.accept(message('/models'));
    const row = modelRow(f.modelCards[0], 1);
    assert.match(row.text, /✓/u, 'row 1 is the current model');

    await f.bridge.acceptCallback(callback(row.callback_data));
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(f.selections, [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }]);
    assert.equal(f.opened.length, 1, 'the account list opened anyway');
    assert.equal(f.opened[0].title, 'Accounts CN');
  });
});

test('a provider without a declared card offers nothing after a switch', async () => {
  await withAccounts(async (origin) => {
    const f = fixture({ origin, current: { provider: 'llm-deepseek', model: 'deepseek-flash' } });
    await f.bridge.accept(message('/models'));
    // Index 1 is workbuddy's model — declared, so it WOULD offer a list. Use the
    // llm-deepseek row (index 3) to prove an undeclared provider offers nothing.
    const row = modelRow(f.modelCards[0], 3);
    assert.match(row.text, /llm-deepseek/u);
    await f.bridge.acceptCallback(callback(row.callback_data));
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(f.selections.length, 1, 'the model still switched');
    assert.equal(f.opened.length, 0, 'but no account list was opened');
  });
});

test('a failed account read does not undo the reported model switch', async () => {
  // A dead loopback port: the model switch succeeds, the account route does not.
  // Nothing answers, so the failure is reported as "the endpoint is missing" —
  // the 404-first rule from the external-card doc (a route that does not answer
  // means the plugin is not there, which is the answer the reader needs).
  const f = fixture({ origin: 'http://127.0.0.1:1' });
  await f.bridge.accept(message('/models'));
  const row = modelRow(f.modelCards[0], 1);
  await f.bridge.acceptCallback(callback(row.callback_data));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.deepEqual(f.selections, [{ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }]);
  assert.ok(
    f.sent.some((text) => /模型已切换为/u.test(text)),
    'the completed switch is still reported',
  );
  assert.ok(
    f.sent.some((text) => /Accounts CN/u.test(text)),
    'the account failure reaches the reader as text, not as a lost switch',
  );
});

/** A loopback server standing in for the pooled provider's account route. */
async function withAccounts(run) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      accounts: [
        { id: 'a1', accountName: 'rich', selected: false },
        { id: 'a2', accountName: 'poor', selected: true },
      ],
      pool: { enabled: false },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
