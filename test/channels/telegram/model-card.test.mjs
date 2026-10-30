import assert from 'node:assert/strict';
import test from 'node:test';

import { runModelCommand } from '../../../src/channels/shared/model-command.mjs';
import {
  TELEGRAM_MODEL_CARD,
  parseTelegramModelCallback,
} from '../../../src/channels/telegram/telegram-bridge.mjs';

/** Three groups so a single page cannot hold everything and page order matters. */
const CATALOG = Object.freeze({
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
        { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4' },
      ],
    },
    {
      id: 'workbuddy',
      name: 'WorkBuddy',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'V4.1 Flash' },
        { id: 'glm-5.3', name: 'GLM 5.3' },
        { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
        { id: 'step-5-preview', name: 'Step 5' },
      ],
    },
  ],
  failures: [{ id: 'broken-provider', name: 'Broken' }],
  current: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
});

function fakeHarness(catalog = CATALOG) {
  return { listModels: async () => catalog };
}

/** Every index /model <n> would accept, in the order formatCatalog prints. */
function printedOrder(catalog) {
  const ids = [];
  for (const group of catalog.groups) {
    for (const model of group.models) ids.push(`${group.id}/${model.id}`);
  }
  return ids;
}

async function runModels(catalog = CATALOG) {
  const state = { sessionFor: () => null };
  return runModelCommand('/models', fakeHarness(catalog), state, 'direct:1', {});
}

test('the /models result carries a modelListing whose indices ARE the printed numbers', async () => {
  const result = await runModels();
  assert.equal(result.handled, true);
  const listing = result.modelListing;
  assert.ok(listing, 'modelListing must be present for a channel to render');
  assert.equal(listing.current, 'workbuddy/deepseek-v4.1-flash');
  assert.deepEqual(listing.failures, ['Broken']);

  const expected = printedOrder(CATALOG);
  assert.equal(listing.items.length, expected.length);
  listing.items.forEach((item, offset) => {
    assert.equal(item.index, offset + 1, 'indices are 1-based and contiguous');
    assert.equal(item.id, expected[offset]);
  });
});

test('the text list and the card describe the same model at the same number', async () => {
  const result = await runModels();
  // The printed row appends the "current" marker; the id is what precedes it.
  const printed = result.message
    .split('\n')
    .map((line) => /^(\d+)\. (\S+?)(?:（当前）)?$/u.exec(line))
    .filter(Boolean)
    .map((match) => ({ index: Number(match[1]), id: match[2] }));
  assert.equal(printed.length, result.modelListing.items.length);
  printed.forEach((row, offset) => {
    assert.equal(row.index, result.modelListing.items[offset].index);
    assert.equal(row.id, result.modelListing.items[offset].id);
  });
});

test('a models command with extra words keeps the usage text and no listing', async () => {
  const state = { sessionFor: () => null };
  const result = await runModelCommand('/models 3', fakeHarness(), state, 'direct:1', {});
  assert.equal(result.handled, true);
  assert.equal(result.modelListing, undefined);
});

test('a failed catalogue read produces no listing to render', async () => {
  const state = { sessionFor: () => null };
  const harness = { listModels: async () => { throw new Error('boom'); } };
  const result = await runModelCommand('/models', harness, state, 'direct:1', {});
  assert.equal(result.handled, true);
  assert.equal(result.modelListing, undefined);
  assert.match(result.message, /无法获取模型列表/u);
});

test('the card renders one row per model, marks the current one, and pages', () => {
  const listing = {
    current: 'workbuddy/deepseek-v4.1-flash',
    items: printedOrder(CATALOG).map((id, offset) => ({
      index: offset + 1,
      id,
      provider: id.slice(0, id.indexOf('/')),
      model: id.slice(id.indexOf('/') + 1),
    })),
    failures: ['Broken'],
  };
  const first = TELEGRAM_MODEL_CARD.render(listing, { nonce: 'nonce1' });
  assert.ok(first);
  // Eight models fit one page exactly, so there is no pager to draw.
  assert.equal(first.pages, 1);
  assert.equal(first.page, 0);
  const rows = first.markup.inline_keyboard.filter((row) => row.length === 1);
  assert.ok(rows.length > 0);
  // The current model's row is marked but still present: its number is what
  // /model <n> resolves, so removing it would make the buttons and the printed
  // list disagree about every model after it.
  const currentRow = rows.find((row) => row[0].text.includes('deepseek-v4.1-flash'));
  assert.ok(currentRow, 'the current model keeps its row');
  assert.match(currentRow[0].text, /^✓ /u);
  assert.match(first.text, /当前模型：workbuddy\/deepseek-v4\.1-flash/u);
  assert.match(first.text, /Broken/u);
});

test('every rendered row decodes back to the index it was drawn for', () => {
  const listing = {
    current: null,
    items: Array.from({ length: 10 }, (_, offset) => ({
      index: offset + 1, id: `p/m${offset + 1}`, provider: 'p', model: `m${offset + 1}`,
    })),
    failures: [],
  };
  const card = TELEGRAM_MODEL_CARD.render(listing, { nonce: 'abc', page: 0 });
  assert.equal(card.pages, 2);
  const seen = [];
  for (const row of card.markup.inline_keyboard) {
    const press = parseTelegramModelCallback(row[0].callback_data);
    assert.ok(press, 'the card only emits payloads its own parser accepts');
    assert.equal(press.nonce, 'abc');
    if (press.action === 's') seen.push(press.index);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
  // Page two carries the remaining numbers, so an index is never lost by paging.
  const second = TELEGRAM_MODEL_CARD.render(listing, { nonce: 'abc', page: 1 });
  const secondIndexes = second.markup.inline_keyboard
    .map((row) => parseTelegramModelCallback(row[0].callback_data))
    .filter((press) => press?.action === 's')
    .map((press) => press.index);
  assert.deepEqual(secondIndexes, [9, 10]);
});

test('a page press round-trips through the parser', () => {
  const listing = {
    current: null,
    items: Array.from({ length: 10 }, (_, offset) => ({
      index: offset + 1, id: `p/m${offset + 1}`, provider: 'p', model: `m${offset + 1}`,
    })),
    failures: [],
  };
  const card = TELEGRAM_MODEL_CARD.render(listing, { nonce: 'abc', page: 0 });
  const pager = card.markup.inline_keyboard[card.markup.inline_keyboard.length - 1];
  const next = pager.find((button) => button.callback_data.includes('|p|'));
  assert.ok(next, 'a multi-page card offers a next page');
  assert.deepEqual(parseTelegramModelCallback(next.callback_data), {
    nonce: 'abc', action: 'p', index: 1,
  });
});

test('the card refuses to render without a nonce or without items', () => {
  assert.equal(TELEGRAM_MODEL_CARD.render({ items: [] }, {}), null);
  assert.equal(TELEGRAM_MODEL_CARD.render({ items: [{ index: 1, id: 'a/b' }] }, {}), null);
  assert.equal(TELEGRAM_MODEL_CARD.render(null, { nonce: 'x' }), null);
});

test('a foreign payload is not parsed as a model press', () => {
  for (const data of ['w1|abc|1', 's1|abc|b|1', 'q|abc|0|0', 'm1|abc|x', 'm1|abc|s|-1', undefined]) {
    assert.equal(parseTelegramModelCallback(data), null, String(data));
  }
});
