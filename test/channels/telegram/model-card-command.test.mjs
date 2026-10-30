import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  TELEGRAM_MODEL_CARD,
  parseTelegramModelCallback,
} from '../../../src/channels/telegram/telegram-bridge.mjs';

const CATALOG = {
  groups: [
    {
      id: 'workbuddy',
      name: 'WorkBuddy',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'V4.1 Flash' },
        { id: 'glm-5.3', name: 'GLM 5.3' },
        { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
      ],
    },
  ],
  failures: [],
};

/** Ten models so the card needs a second page. */
const LONG_CATALOG = {
  groups: [{
    id: 'p',
    name: 'P',
    models: Array.from({ length: 10 }, (_, i) => ({ id: `m${i + 1}`, name: `M${i + 1}` })),
  }],
  failures: [],
};

/**
 * The bridge takes an ACCESS POLICY WRAPPER, not a policy: the shared
 * permission gate calls `accessPolicy.getSettings()`. Passing the policy itself
 * made `evaluateInboundAccess` answer "policy unavailable" and every press was
 * refused before it reached the card.
 */
function accessPolicy({ canExecute = true, denied = [] } = {}) {
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
        open: {
          defaultCanExecuteCommands: canExecute,
          commandPermissionOverrides: denied.map((id) => ({ id, canExecuteCommands: false })),
        },
        allowlist: { users: [] },
      }),
    }),
  };
}

/**
 * A bridge with one bound Session, so `/models` reads the session catalogue and
 * a press goes through the same `selectModel` path a typed `/model <n>` uses.
 */
function fixture({ catalog = CATALOG, sessionCard = 'ok', access = {} } = {}) {
  const sent = [];
  const cards = [];
  const notices = [];
  const edits = [];
  const selections = [];
  const seen = new Set();
  let current = { provider: catalog.groups[0].id, model: catalog.groups[0].models[0].id };

  const session = {
    async sessionExists() { return true; },
    async models() { return { ...catalog, current }; },
    async isRunning() { return false; },
    async hasActiveTurn() { return false; },
    async selectModel(selection) {
      selections.push(selection);
      const offered = catalog.groups.some(
        (group) => group.id === selection.provider
          && group.models.some((model) => model.id === selection.model),
      );
      if (!offered) throw new Error('not offered');
      current = { provider: selection.provider, model: selection.model };
      return { selected: { ...current } };
    },
  };

  const state = {
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
    sessionFor: () => 'session-1',
    async setSession() {},
  };

  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    state,
    modelCard: TELEGRAM_MODEL_CARD,
    accessPolicy: accessPolicy(access),
    bot: {
      async sendText(_target, text) { sent.push(text); },
      async sendInteractionCard(_target, { text, markup }) {
        if (sessionCard === 'fail') throw new Error('telegram refused the keyboard');
        cards.push({ text, markup });
        return { providerMessageIds: [String(900 + cards.length)] };
      },
      async updateInteractionCard(_target, messageId, { markup, text }) {
        edits.push({ messageId, markup, ...(text === undefined ? {} : { text }) });
      },
      async answerInteractionCallback(queryId, text) { notices.push({ queryId, text }); },
    },
    harness: {
      workspaceSession: () => session,
      currentWorkspace: () => '/w',
      async listWorkspaces() { return ['/w']; },
    },
    logger: { warn() {}, error() {} },
  });
  return { bridge, sent, cards, notices, edits, selections, catalog };
}

let seq = 0;
function message(content) {
  seq += 1;
  return {
    messageId: `msg-${seq}`,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content,
    addressed: true,
    replyTarget: { chatId: 42 },
  };
}

function callback(data, overrides = {}) {
  seq += 1;
  return {
    messageId: `update-${seq}`,
    callbackQueryId: 'cb-1',
    providerMessageId: 900,
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

function modelButtons(card) {
  return (card?.markup?.inline_keyboard ?? [])
    .flat()
    .filter((button) => parseTelegramModelCallback(button.callback_data)?.action === 's');
}

async function press(bridge, data, overrides = {}) {
  await bridge.acceptCallback(callback(data, overrides));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('/models renders as a card instead of the text list', async () => {
  const f = fixture();
  await f.bridge.accept(message('/models'));
  assert.equal(f.cards.length, 1, 'one card, no text list');
  assert.equal(f.sent.length, 0, 'the text list is suppressed when the card is delivered');
  const card = f.cards[0];
  assert.match(card.text, /当前模型：workbuddy\/deepseek-v4\.1-flash/u);
  assert.equal(modelButtons(card).length, 3);
});

test('pressing a model row switches the model through /model <n>', async () => {
  const f = fixture();
  await f.bridge.accept(message('/models'));
  const buttons = modelButtons(f.cards[0]);
  const glm = buttons.find((button) => button.text.includes('glm-5.3'));
  assert.ok(glm, 'the card lists the model the catalogue offered');

  await press(f.bridge, glm.callback_data);

  assert.deepEqual(f.selections, [{ provider: 'workbuddy', model: 'glm-5.3' }]);
  assert.ok(f.sent.some((text) => /模型已切换为/u.test(text)), 'the switch is confirmed');
  assert.equal(f.edits.at(-1)?.markup?.inline_keyboard?.length, 0, 'the keyboard is retired');
  assert.match(f.notices.at(-1).text, /glm-5\.3/u);
});

test('a pressed row resolves to the number the text list printed', async () => {
  const f = fixture();
  await f.bridge.accept(message('/models'));
  const card = f.cards[0];
  const rows = (card.markup.inline_keyboard ?? []).flat()
    .filter((button) => parseTelegramModelCallback(button.callback_data)?.action === 's');
  // Index 2 is glm-5.3: the second model of the only group.
  assert.equal(parseTelegramModelCallback(rows[1].callback_data).index, 2);
  await press(f.bridge, rows[1].callback_data);
  assert.deepEqual(f.selections[0], { provider: 'workbuddy', model: 'glm-5.3' });
});

test('a card that cannot be sent falls back to the text list', async () => {
  const f = fixture({ sessionCard: 'fail' });
  await f.bridge.accept(message('/models'));
  assert.equal(f.cards.length, 0);
  assert.ok(f.sent.some((text) => /可用模型/u.test(text)), 'the text list still arrives');
});

test('another page of the same card keeps the same indices', async () => {
  const f = fixture({ catalog: LONG_CATALOG });
  await f.bridge.accept(message('/models'));
  const first = f.cards[0];
  const next = (first.markup.inline_keyboard ?? []).flat()
    .find((button) => parseTelegramModelCallback(button.callback_data)?.action === 'p');
  assert.ok(next, 'a ten-model card offers a second page');

  await press(f.bridge, next.callback_data);

  const edit = f.edits.at(-1);
  assert.match(edit.text, /第 2\/2 页/u, 'the body states the page it now shows');
  const second = { markup: edit.markup };
  const indexes = modelButtons(second).map(
    (button) => parseTelegramModelCallback(button.callback_data).index,
  );
  assert.deepEqual(indexes, [9, 10], 'page two continues the numbering');
});

test('a press on a card the bridge never issued only toasts', async () => {
  const f = fixture();
  await press(f.bridge, 'm1|nosuchnonce|s|1');
  assert.equal(f.notices.length, 1);
  assert.equal(f.selections.length, 0);
});

test('a press from a sender without command permission does not switch', async () => {
  // actor-a may run commands; actor-b may not. The card is sent to actor-a, then
  // actor-b presses a row: the keyboard must not bypass the command gate that
  // typing "/model 2" would hit.
  const f = fixture({ access: { denied: ['actor-b'] } });
  await f.bridge.accept(message('/models'));
  const button = modelButtons(f.cards[0])[1];
  await press(f.bridge, button.callback_data, { senderId: 'actor-b' });
  assert.equal(f.selections.length, 0, 'the switch never ran');
  assert.equal(f.sent.length, 0);
  assert.equal(f.notices.length, 1, 'the press is answered with a refusal');
});

test('a model row press cannot be replayed after the keyboard is retired', async () => {
  const f = fixture();
  await f.bridge.accept(message('/models'));
  const button = modelButtons(f.cards[0])[1];
  await press(f.bridge, button.callback_data);
  assert.equal(f.selections.length, 1);
  await press(f.bridge, button.callback_data);
  assert.equal(f.selections.length, 1, 'the same card cannot switch twice');
});


