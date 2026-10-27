import assert from 'node:assert/strict';
import test from 'node:test';

import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';

const KEY = 'direct:chat';

/**
 * A delivery service stand-in that records what /notify asked it to do.
 * `targets` is the listTargets() answer; the state a target reports is what
 * decides whether 'always' can succeed.
 */
function serviceFixture({ targets = [], fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async listTargets(botId) {
      calls.push({ op: 'listTargets', botId });
      if (fail === 'list') throw new Error('list failed');
      return { botId, channel: 'telegram', targets };
    },
    async setSessionSync(botId, targetId, enabled) {
      calls.push({ op: 'setSessionSync', botId, targetId, enabled });
      if (fail === 'set') throw new Error('set failed');
      return { enabled };
    },
  };
}

function target({ targetId = 'tgt_1', chatId = '424242424', enabled = false, state = 'active' } = {}) {
  return { targetId, kind: 'chat', route: { chatId }, sessionSync: { enabled, state } };
}

function bridgeFor({ deliveryService = null, botId = 'bot_1', chatId = '424242424' } = {}) {
  const sent = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot: { async sendText(_target, text) { sent.push(text); } },
    harness: {
      async ensureRunning() { return true; },
      async listWorkspaces() { return []; },
    },
    state: {
      hasSeen() { return false; },
      async markSeen() {},
      sessionFor() { return null; },
    },
    deliveryService,
    botId,
  });
  let seq = 0;
  const accept = (content) => {
    seq += 1;
    return bridge.accept({
      messageId: `msg-${seq}`,
      senderId: '424242424',
      senderIsBot: false,
      kind: 'direct',
      conversationId: chatId,
      content,
      addressed: true,
      replyTarget: { chatId },
    });
  };
  return { bridge, sent, accept };
}

test('/notify without an argument reports the current mode', async () => {
  const service = serviceFixture({ targets: [target({ enabled: false })] });
  const fixture = bridgeFor({ deliveryService: service });
  await fixture.accept('/notify');

  assert.match(fixture.sent.at(-1), /当前模式：default/);
});

test('/notify reports always when the target already syncs', async () => {
  const service = serviceFixture({ targets: [target({ enabled: true })] });
  const fixture = bridgeFor({ deliveryService: service });
  await fixture.accept('/notify');

  assert.match(fixture.sent.at(-1), /当前模式：always/);
});

test('/notify always turns on sync for the target of this chat', async () => {
  const service = serviceFixture({ targets: [target({ enabled: false })] });
  const fixture = bridgeFor({ deliveryService: service });
  await fixture.accept('/notify always');

  assert.deepEqual(service.calls.at(-1), {
    op: 'setSessionSync', botId: 'bot_1', targetId: 'tgt_1', enabled: true,
  });
  assert.match(fixture.sent.at(-1), /已开启/);
});

test('/notify default turns sync off without needing a target lookup match', async () => {
  const service = serviceFixture({ targets: [target({ enabled: true })] });
  const fixture = bridgeFor({ deliveryService: service });
  await fixture.accept('/notify default');

  assert.equal(service.calls.at(-1).enabled, false);
  assert.match(fixture.sent.at(-1), /已关闭/);
});

test('/notify always explains how to create a missing target', async () => {
  const service = serviceFixture({ targets: [] });
  const fixture = bridgeFor({ deliveryService: service });
  await fixture.accept('/notify always');

  assert.match(fixture.sent.at(-1), /还没有投递目标/);
  assert.ok(!service.calls.some((call) => call.op === 'setSessionSync'), 'nothing is written');
});

test('/notify always refuses a chat that cannot sync yet', async () => {
  const service = serviceFixture({
    targets: [target({ enabled: false, state: 'unavailable' })],
  });
  const fixture = bridgeFor({ deliveryService: service });
  await fixture.accept('/notify always');

  assert.match(fixture.sent.at(-1), /还不能同步会话/);
  assert.ok(!service.calls.some((call) => call.op === 'setSessionSync'));
});

test('an unknown argument shows the usage line', async () => {
  const service = serviceFixture({ targets: [target()] });
  const fixture = bridgeFor({ deliveryService: service });
  await fixture.accept('/notify sometimes');

  assert.match(fixture.sent.at(-1), /用法：\/notify/);
});

test('a Host without a delivery service says so instead of pretending', async () => {
  const fixture = bridgeFor({ deliveryService: null });
  await fixture.accept('/notify always');

  assert.match(fixture.sent.at(-1), /不支持会话同步/);
});

test('a failing lookup or write is reported, never swallowed', async () => {
  const listFails = bridgeFor({ deliveryService: serviceFixture({ fail: 'list' }) });
  await listFails.accept('/notify');
  assert.match(listFails.sent.at(-1), /暂时无法读取投递设置/);

  const setFails = bridgeFor({
    deliveryService: serviceFixture({ targets: [target()], fail: 'set' }),
  });
  await setFails.accept('/notify always');
  assert.match(setFails.sent.at(-1), /暂时无法修改通知设置/);
});

test('/notify only matches the target for the chat it was sent from', async () => {
  const service = serviceFixture({
    targets: [target({ targetId: 'other', chatId: '999' }), target({ targetId: 'mine' })],
  });
  const fixture = bridgeFor({ deliveryService: service });
  await fixture.accept('/notify always');

  assert.equal(service.calls.at(-1).targetId, 'mine');
});
