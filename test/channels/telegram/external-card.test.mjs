import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyCardActions,
  externalCardFor,
  fetchCardListing,
  normalizeExternalCards,
  readPath,
  restartStateBaseUrls,
  writePath,
} from '../../../src/channels/shared/external-card-command.mjs';
import {
  TELEGRAM_EXTERNAL_CARD,
  parseTelegramExternalCardCallback,
} from '../../../src/channels/telegram/telegram-bridge.mjs';

const SPEC = {
  version: 1,
  cards: [{
    command: '/wb',
    title: 'Accounts',
    list: {
      url: '{base}/usage?region=cn',
      items: 'accounts',
      id: 'id',
      label: 'accountName',
      current: 'selected',
      note: { path: 'pool.enabled', is: true, text: 'pool is on' },
    },
    actions: [{
      post: '{base}/__save',
      body: { field: 'accounts', value: { cn: '{id}' } },
    }],
  }],
};

const ANSWER = {
  accounts: [
    { id: 'a1', accountName: 'first', selected: false },
    { id: 'a2', accountName: 'second', selected: true },
  ],
  pool: { enabled: true },
};

function fakeFetch({ json = ANSWER, status = 200, calls = [], text } = {}) {
  return async (url, options) => {
    calls.push({ url, method: options?.method ?? 'GET', body: options?.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (text ?? JSON.stringify(json)),
    };
  };
}

test('the spec normalizes into one card with its note rule intact', () => {
  const { cards, error } = normalizeExternalCards(SPEC);
  assert.equal(error, undefined);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].command, '/wb');
  assert.deepEqual(cards[0].list.note, { path: 'pool.enabled', is: true, text: 'pool is on' });
});

test('a spec that cannot be fully understood is rejected whole', () => {
  for (const broken of [
    { version: 2, cards: [] },
    { version: 1, cards: [{ ...SPEC.cards[0], command: 'wb' }] },
    { version: 1, cards: [{ ...SPEC.cards[0], actions: [] }] },
    { version: 1, cards: [{ ...SPEC.cards[0], list: { ...SPEC.cards[0].list, items: '' } }] },
    { version: 1, cards: [SPEC.cards[0], SPEC.cards[0]] },
    { version: 1, cards: [{ ...SPEC.cards[0], actions: [{ post: 'u', settingsRewrite: { nsIncludes: 'x' } }] }] },
  ]) {
    const result = normalizeExternalCards(broken);
    assert.ok(result.error, JSON.stringify(broken).slice(0, 80));
    assert.deepEqual(result.cards, [], 'a rejected spec never yields partial cards');
  }
});

test('only the bare command matches, and it is case-insensitive', () => {
  const { cards } = normalizeExternalCards(SPEC);
  assert.ok(externalCardFor('/wb', cards));
  assert.ok(externalCardFor('/WB', cards));
  assert.equal(externalCardFor('/wb 2', cards), undefined, 'arguments are not this card');
  assert.equal(externalCardFor('/models', cards), undefined);
  assert.equal(externalCardFor('hello', cards), undefined);
});

test('dot paths read and write without touching the caller object', () => {
  const live = { regions: { cn: { pool: { enabled: true, members: ['a'] } } } };
  assert.deepEqual(readPath(live, 'regions.cn.pool.members'), ['a']);
  const patched = writePath(live.regions.cn, 'pool.enabled', false);
  assert.equal(patched.pool.enabled, false);
  assert.deepEqual(patched.pool.members, ['a'], 'siblings survive the rewrite');
  assert.equal(live.regions.cn.pool.enabled, true, 'the source object is not mutated');
});

test('the card shows the note only while its condition holds', async () => {
  const { cards } = normalizeExternalCards(SPEC);
  const on = await fetchCardListing(cards[0], { baseUrl: 'http://h', fetchImpl: fakeFetch() });
  assert.equal(on.listing.note, 'pool is on');
  const off = await fetchCardListing(cards[0], {
    baseUrl: 'http://h',
    fetchImpl: fakeFetch({ json: { ...ANSWER, pool: { enabled: false } } }),
  });
  assert.equal(off.listing.note, '');
});

test('the listing keeps the upstream order and marks the current row', async () => {
  const { cards } = normalizeExternalCards(SPEC);
  const { listing } = await fetchCardListing(cards[0], {
    baseUrl: 'http://h', fetchImpl: fakeFetch(),
  });
  assert.deepEqual(listing.rows.map((r) => r.id), ['a1', 'a2']);
  assert.deepEqual(listing.rows.map((r) => r.current), [false, true]);
  assert.deepEqual(listing.rows.map((r) => r.index), [1, 2]);
});

test('an unreadable list reports why and renders nothing', async () => {
  const { cards } = normalizeExternalCards(SPEC);
  const failure = await fetchCardListing(cards[0], {
    baseUrl: 'http://h',
    fetchImpl: fakeFetch({ status: 404, text: 'nope' }),
  });
  assert.match(failure.error, /HTTP 404/u);
  const wrongShape = await fetchCardListing(cards[0], {
    baseUrl: 'http://h',
    fetchImpl: fakeFetch({ json: { accounts: 'not an array' } }),
  });
  assert.match(wrongShape.error, /no array/u);
});

test('actions run in order and expand {base}/{id} into the body', async () => {
  const { cards } = normalizeExternalCards(SPEC);
  const calls = [];
  const answer = await applyCardActions(cards[0], { id: 'a2', label: 'second' }, {
    baseUrl: 'http://h',
    fetchImpl: fakeFetch({ calls }),
  });
  assert.equal(answer.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://h/__save');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { field: 'accounts', value: { cn: 'a2' } });
});

test('a failing action stops the sequence — later writes never run', async () => {
  const twoStep = {
    version: 1,
    cards: [{
      ...SPEC.cards[0],
      actions: [
        { post: '{base}/one', body: {} },
        { post: '{base}/two', body: {} },
      ],
    }],
  };
  const { cards } = normalizeExternalCards(twoStep);
  const calls = [];
  let nth = 0;
  const fetchImpl = async (url, options) => {
    nth += 1;
    calls.push(url);
    return {
      ok: nth === 1,
      status: nth === 1 ? 200 : 500,
      text: async () => (nth === 1 ? '{}' : 'boom'),
    };
  };
  const answer = await applyCardActions(cards[0], { id: 'a1', label: 'first' }, {
    baseUrl: 'http://h', fetchImpl,
  });
  assert.match(answer.error, /HTTP 500/u);
  assert.deepEqual(calls, ['http://h/one', 'http://h/two'], 'the second call was attempted only once');
});

test('a settings rewrite reads the live object and posts the patched copy', async () => {
  const rewrite = {
    version: 1,
    cards: [{
      ...SPEC.cards[0],
      actions: [{
        post: '{base}/__save',
        settingsRewrite: { nsIncludes: 'workbuddy', read: 'regions.cn', set: 'pool.enabled', value: false },
        body: { field: 'regions', value: { cn: '{patched}' } },
      }],
    }],
  };
  const { cards } = normalizeExternalCards(rewrite);
  const live = {
    ns: 'dsh-connect-workbuddy',
    value: { regions: { cn: { pool: { enabled: true, memberAccountIds: ['a1'] }, enabled: true } } },
  };
  const calls = [];
  const answer = await applyCardActions(cards[0], { id: 'a1', label: 'x' }, {
    baseUrl: 'http://h',
    fetchImpl: fakeFetch({ calls }),
    settings: { describe: () => [live] },
  });
  assert.equal(answer.ok, true);
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.field, 'regions');
  assert.equal(sent.value.cn.pool.enabled, false, 'the one field was flipped');
  assert.deepEqual(sent.value.cn.pool.memberAccountIds, ['a1'], 'the pool members survive');
  assert.equal(live.value.regions.cn.pool.enabled, true, 'the live object was not mutated');
});

test('a settings rewrite refuses rather than writing through an unreadable row', async () => {
  const rewrite = {
    version: 1,
    cards: [{
      ...SPEC.cards[0],
      actions: [{
        post: '{base}/__save',
        settingsRewrite: { nsIncludes: 'workbuddy', read: 'regions.cn', set: 'pool.enabled', value: false },
        body: { field: 'regions', value: { cn: '{patched}' } },
      }],
    }],
  };
  const { cards } = normalizeExternalCards(rewrite);
  for (const settings of [
    undefined,
    { describe: () => [] },
    { describe: () => [{ ns: 'workbuddy', value: { regions: { cn: 'not an object' } } }] },
  ]) {
    const calls = [];
    const answer = await applyCardActions(cards[0], { id: 'a1', label: 'x' }, {
      baseUrl: 'http://h', fetchImpl: fakeFetch({ calls }), settings,
    });
    assert.ok(answer.error, `settings=${JSON.stringify(settings)?.slice(0, 40)}`);
    assert.equal(calls.length, 0, 'nothing was written');
  }
});

test('the card renders rows it can parse back, pages, and carries the note', () => {
  const listing = {
    title: 'Accounts',
    rows: Array.from({ length: 10 }, (_, i) => ({
      index: i + 1, id: `a${i + 1}`, label: `name ${i + 1}`, current: i === 0,
    })),
    note: 'pool is on',
  };
  const first = TELEGRAM_EXTERNAL_CARD.render(listing, { nonce: 'n1' });
  assert.equal(first.pages, 2);
  assert.match(first.text, /Accounts（共 10 个，第 1\/2 页）/u);
  assert.match(first.text, /pool is on/u);
  const presses = first.markup.inline_keyboard.flat()
    .map((button) => parseTelegramExternalCardCallback(button.callback_data));
  assert.deepEqual(presses.filter((p) => p.action === 's').map((p) => p.index), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(presses.some((p) => p.action === 'p'));
  const second = TELEGRAM_EXTERNAL_CARD.render(listing, { nonce: 'n1', page: 1 });
  assert.deepEqual(
    second.markup.inline_keyboard.flat()
      .map((button) => parseTelegramExternalCardCallback(button.callback_data))
      .filter((p) => p.action === 's').map((p) => p.index),
    [9, 10],
  );
});

test('a foreign payload is not parsed as an external card press', () => {
  for (const data of ['m1|abc|s|1', 'x1|abc|x', 'x1|abc|s|-1', 's1|abc|b|1', undefined]) {
    assert.equal(parseTelegramExternalCardCallback(data), null, String(data));
  }
});


test('the recorded loopback ports are read back, BOM and all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-cards-'));
  await mkdir(join(root, 'restart'), { recursive: true });
  // The restart helper writes its state with a UTF-8 BOM; JSON.parse rejects a
  // leading BOM, which silently disabled this fallback the first time.
  await writeFile(
    join(root, 'restart', 'restart-state.json'),
    '\uFEFF' + JSON.stringify({ newPorts: [62177, 62178, 62179] }),
    'utf8',
  );
  assert.deepEqual(await restartStateBaseUrls(root), [
    'http://127.0.0.1:62177',
    'http://127.0.0.1:62178',
    'http://127.0.0.1:62179',
  ]);
  // A missing record is "no candidates", never an error.
  assert.deepEqual(await restartStateBaseUrls(join(root, 'nope')), []);
  assert.deepEqual(await restartStateBaseUrls(''), []);
});

/** A card whose first action declares an effect, and whose pool starts in a given state. */
function rewriteSpec(poolEnabled) {
  return {
    version: 1,
    cards: [{
      ...SPEC.cards[0],
      actions: [{
        post: '{base}/__save',
        settingsRewrite: { nsIncludes: 'workbuddy', read: 'regions.cn', set: 'pool.enabled', value: false },
        effect: 'the pool was turned off',
        body: { field: 'regions', value: { cn: '{patched}' } },
      }],
    }],
    poolEnabled,
  };
}

test('a rewrite reports its declared effect when it actually changed something', async () => {
  const spec = rewriteSpec(true);
  const { cards } = normalizeExternalCards(spec);
  const answer = await applyCardActions(cards[0], { id: 'a1', label: 'x' }, {
    baseUrl: 'http://h',
    fetchImpl: fakeFetch({ calls: [] }),
    settings: { describe: () => [{ ns: 'workbuddy', value: { regions: { cn: { pool: { enabled: true } } } } }] },
  });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.effects, ['the pool was turned off']);
});

test('a rewrite stays silent when the field already held the target value', async () => {
  // Saying "the pool was turned off" when it was already off is a false report,
  // and it would appear on every press after the first.
  const { cards } = normalizeExternalCards(rewriteSpec(false));
  const answer = await applyCardActions(cards[0], { id: 'a1', label: 'x' }, {
    baseUrl: 'http://h',
    fetchImpl: fakeFetch({ calls: [] }),
    settings: { describe: () => [{ ns: 'workbuddy', value: { regions: { cn: { pool: { enabled: false } } } } }] },
  });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.effects, []);
});

test('a plain action always reports its effect, and a failure reports none', async () => {
  const withPlain = {
    version: 1,
    cards: [{
      ...SPEC.cards[0],
      actions: [{ post: '{base}/__save', body: {}, effect: 'done' }],
    }],
  };
  const { cards } = normalizeExternalCards(withPlain);
  const ok = await applyCardActions(cards[0], { id: 'a1', label: 'x' }, {
    baseUrl: 'http://h', fetchImpl: fakeFetch({ calls: [] }),
  });
  assert.deepEqual(ok.effects, ['done']);
  const failed = await applyCardActions(cards[0], { id: 'a1', label: 'x' }, {
    baseUrl: 'http://h', fetchImpl: fakeFetch({ calls: [], status: 500, text: 'boom' }),
  });
  assert.ok(failed.error);
  assert.equal(failed.effects, undefined, 'a failure must not claim anything happened');
});

test('an effect longer than the cap is truncated, not carried whole', () => {
  const long = { version: 1, cards: [{ ...SPEC.cards[0], actions: [{ post: 'u', body: {}, effect: 'x'.repeat(400) }] }] };
  const { cards } = normalizeExternalCards(long);
  assert.ok(cards[0].actions[0].effect.length <= 200);
});
