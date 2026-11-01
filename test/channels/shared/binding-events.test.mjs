import assert from 'node:assert/strict';
import test from 'node:test';

import { createBindingAnnouncer } from '../../../plugin-src/host/channels/shared/binding-events.mjs';

const GROUP_KEY = 'group:-1004337494578:67';
const DIRECT_KEY = 'direct:161161619';

function recorder({ authors = null } = {}) {
  const events = [];
  const announcer = createBindingAnnouncer({
    channel: 'telegram',
    emit: (event, payload) => events.push({ event, payload }),
    authorsOf: () => authors,
  });
  return { announcer, events };
}

/** Minimal state store shaped like the channel one: sessions map, snapshot, setSession. */
function createState(initial = {}) {
  const state = {
    sessions: { ...initial },
    authors: {},
    writes: [],
    async setSession(key, sessionId) {
      state.writes.push([key, sessionId]);
      state.sessions[key] = sessionId;
    },
    async clearSession(key) {
      delete state.sessions[key];
    },
    async clearSessions() {
      state.sessions = {};
    },
    sessionFor(key) {
      return state.sessions[key] ?? null;
    },
    snapshot() {
      return structuredClone({ sessions: state.sessions, authors: state.authors });
    },
  };
  return state;
}

test('a first bind announces only the bind, never an unbind', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState());

  await state.setSession(GROUP_KEY, 'session-a');

  assert.deepEqual(events.map((entry) => entry.event), ['dsh-im/session-pre-bind']);
  assert.equal(events[0].payload.sessionId, 'session-a');
  assert.equal(events[0].payload.conversationKey, GROUP_KEY);
  assert.equal(events[0].payload.chatType, 'thread');
  assert.equal(events[0].payload.chatId, '-1004337494578');
  assert.equal(events[0].payload.threadId, '67');
  assert.equal(events[0].payload.channel, 'telegram');
  assert.equal(events[0].payload.botId, 'bot_1');
});

test('switching a conversation unbinds the previous session before binding the new one', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a' }));

  await state.setSession(GROUP_KEY, 'session-b');

  assert.deepEqual(events.map((entry) => entry.event), [
    'dsh-im/session-unbind',
    'dsh-im/session-pre-bind',
  ]);
  assert.equal(events[0].payload.sessionId, 'session-a');
  assert.equal(events[0].payload.conversationKey, GROUP_KEY);
  assert.equal(events[0].payload.threadId, '67');
  assert.equal(events[1].payload.sessionId, 'session-b');
});

test('rewriting the same session is not a switch and announces no unbind', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a' }));

  await state.setSession(GROUP_KEY, 'session-a');

  assert.deepEqual(events.map((entry) => entry.event), ['dsh-im/session-pre-bind']);
});

test('a refused write announces nothing', async () => {
  const { announcer, events } = recorder();
  const state = createState({ [GROUP_KEY]: 'session-a' });
  state.setSession = async () => false;
  announcer.wrap('bot_1', state);

  const result = await state.setSession(GROUP_KEY, 'session-b');

  assert.equal(result, false);
  assert.deepEqual(events, []);
});

test('clearing one binding unbinds the session it held', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a', [DIRECT_KEY]: 'session-b' }));

  await state.clearSession(GROUP_KEY);

  assert.deepEqual(events.map((entry) => entry.event), ['dsh-im/session-unbind']);
  assert.equal(events[0].payload.sessionId, 'session-a');
  assert.equal(events[0].payload.conversationKey, GROUP_KEY);
  assert.equal(events[0].payload.chatType, 'thread');
});

test('clearing every binding unbinds each conversation it held', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a', [DIRECT_KEY]: 'session-b' }));

  await state.clearSessions();

  const unbound = events
    .filter((entry) => entry.event === 'dsh-im/session-unbind')
    .map((entry) => [entry.payload.conversationKey, entry.payload.sessionId])
    .sort();
  assert.deepEqual(unbound, [[DIRECT_KEY, 'session-b'], [GROUP_KEY, 'session-a']].sort());
});

test('the remembered author wins over the key for the sender', async () => {
  const authors = { [GROUP_KEY]: { senderId: '161161619', senderName: 'Dmitry' } };
  const { announcer, events } = recorder({ authors });
  const state = announcer.wrap('bot_1', createState());

  await state.setSession(GROUP_KEY, 'session-a');

  assert.equal(events[0].payload.senderId, '161161619');
  assert.equal(events[0].payload.senderName, 'Dmitry');
});

test('a throwing subscriber does not break the write', async () => {
  const announcer = createBindingAnnouncer({
    channel: 'telegram',
    emit: () => {
      throw new Error('subscriber exploded');
    },
  });
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a' }));

  await state.setSession(GROUP_KEY, 'session-b');

  assert.equal(state.sessions[GROUP_KEY], 'session-b');
});

test('wrapping the same store twice keeps the first wrapper', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState());
  const again = announcer.wrap('bot_1', state);

  assert.equal(again, state);
  await state.setSession(GROUP_KEY, 'session-a');
  assert.deepEqual(events.map((entry) => entry.event), ['dsh-im/session-pre-bind']);
});
