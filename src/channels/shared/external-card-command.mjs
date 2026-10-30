/**
 * Declarative external cards: a `/command` that renders another plugin's HTTP
 * list as buttons and writes a choice back, WITHOUT this package importing that
 * other plugin or naming it anywhere in code.
 *
 * Why the indirection exists. A channel command that switches another plugin's
 * setting has three possible couplings (build-time import, discovery — knowing
 * a package/namespace/route name, contract — depending on a field shape). The
 * first is the one that breaks installs, the second is unavoidable in any
 * integration, and the third is what silently corrupts another plugin's data.
 * So: discovery and contract live in a JSON file the user owns, and the code
 * here knows only the shape of that file.
 *
 * Everything is fail-closed. A card that cannot read its list, cannot resolve a
 * settings row it was told to rewrite, or gets an upstream 4xx/5xx performs NO
 * write and reports why. Half-applied actions are the failure mode this file
 * exists to avoid.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where the user's card definitions live, relative to DSH_HOME. */
export const EXTERNAL_CARDS_FILENAME = 'external-cards.json';
const SPEC_VERSION = 1;
const MAX_CARDS = 20;
const MAX_ITEMS = 200;
const MAX_LABEL = 60;
const REQUEST_TIMEOUT_MS = 10_000;

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const COMMAND_RE = /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/u;
/** A path is a dot-separated list of plain keys, never an index into an array. */
const PATH_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;

function cleanText(value, max = MAX_LABEL) {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNSAFE_TEXT, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function plainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one dot-path out of a parsed JSON value; undefined when it is missing. */
export function readPath(value, path) {
  if (typeof path !== 'string' || !PATH_RE.test(path)) return undefined;
  let cursor = value;
  for (const key of path.split('.')) {
    if (!plainRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Write one dot-path into a copy of `value`, creating plain objects on the way.
 *
 * A COPY, never in place: the caller passes the live settings object it just
 * read, and mutating it would leave the process holding a value the disk no
 * longer matches when the write fails.
 */
export function writePath(value, path, replacement) {
  if (typeof path !== 'string' || !PATH_RE.test(path)) return undefined;
  const keys = path.split('.');
  const root = plainRecord(value) ? { ...value } : {};
  let cursor = root;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    cursor[key] = plainRecord(next) ? { ...next } : {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = replacement;
  return root;
}

function validUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  return value;
}

/**
 * `{base}` and `{field}` substitution, kept to string interpolation only.
 *
 * Deliberately not a template engine: a spec file is user data, and anything
 * that can compute is a thing that can compute wrongly in someone else's
 * settings.
 */
function expand(value, context) {
  if (typeof value === 'string') {
    return value.replace(/\{(base|id|label)\}/gu, (match, key) => (
      typeof context[key] === 'string' ? context[key] : match
    ));
  }
  if (Array.isArray(value)) return value.map((entry) => expand(entry, context));
  if (plainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expand(entry, context)]),
    );
  }
  return value;
}

function normalizeAction(raw, index) {
  if (!plainRecord(raw)) return { error: `actions[${index}] must be an object` };
  const post = validUrl(raw.post);
  if (post === null) return { error: `actions[${index}].post must be a URL` };
  // The declaration's own word for what this action changed. Kept out of the
  // code because only the person who wrote the action knows what it does to the
  // other side; the engine can report that it ran, not what it meant.
  const effect = cleanText(raw.effect, 200);
  const withEffect = (action) => (effect ? { ...action, effect } : action);
  if (raw.settingsRewrite !== undefined) {
    const rewrite = raw.settingsRewrite;
    if (!plainRecord(rewrite)) return { error: `actions[${index}].settingsRewrite must be an object` };
    const nsIncludes = cleanText(rewrite.nsIncludes, 120);
    if (!nsIncludes) return { error: `actions[${index}].settingsRewrite.nsIncludes is required` };
    const read = typeof rewrite.read === 'string' ? rewrite.read : '';
    if (!read || !PATH_RE.test(read)) {
      return { error: `actions[${index}].settingsRewrite.read must be a dot path` };
    }
    const set = typeof rewrite.set === 'string' ? rewrite.set : '';
    if (!set || !PATH_RE.test(set)) {
      return { error: `actions[${index}].settingsRewrite.set must be a dot path` };
    }
    return {
      action: withEffect({
        post,
        ...(raw.body === undefined ? {} : { body: raw.body }),
        settingsRewrite: { nsIncludes, read, set, value: rewrite.value ?? false },
      }),
    };
  }
  return { action: withEffect({ post, ...(raw.body === undefined ? {} : { body: raw.body }) }) };
}

function normalizeCard(raw, index) {
  if (!plainRecord(raw)) return { error: `cards[${index}] must be an object` };
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!COMMAND_RE.test(command)) {
    return { error: `cards[${index}].command must look like /name` };
  }
  const title = cleanText(raw.title, 120);
  if (!title) return { error: `cards[${index}].title is required` };
  const list = raw.list;
  if (!plainRecord(list)) return { error: `cards[${index}].list must be an object` };
  const url = validUrl(list.url);
  if (url === null) return { error: `cards[${index}].list.url must be a URL` };
  const items = typeof list.items === 'string' ? list.items : '';
  if (!items || !PATH_RE.test(items)) {
    return { error: `cards[${index}].list.items must be a dot path to the array` };
  }
  const id = typeof list.id === 'string' ? list.id : '';
  if (!id || !PATH_RE.test(id)) {
    return { error: `cards[${index}].list.id must be a field name` };
  }
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  if (actions.length === 0) return { error: `cards[${index}].actions must not be empty` };
  const normalizedActions = [];
  for (const [offset, action] of actions.entries()) {
    const result = normalizeAction(action, offset);
    if (result.error) return { error: `cards[${index}].${result.error}` };
    normalizedActions.push(result.action);
  }
  const noteSpec = normalizeNote(list.note);
  if (noteSpec === null) {
    return { error: `cards[${index}].list.note must be a dot path or {path,is,text}` };
  }
  return {
    card: {
      command,
      title,
      list: {
        url,
        items,
        id,
        label: typeof list.label === 'string' && PATH_RE.test(list.label) ? list.label : '',
        current: typeof list.current === 'string' && PATH_RE.test(list.current) ? list.current : '',
        note: noteSpec,
      },
      actions: normalizedActions,
    },
  };
}

/**
 * A note is either a dot path whose non-empty string value is shown, or
 * `{ path, is, text }` which shows `text` only while `path` equals `is`.
 *
 * The second form exists because the fact worth stating is usually a BOOLEAN
 * that is not itself readable text — "the pool is enabled" is `true`, and a
 * card that printed `true` under a list of accounts would say nothing about
 * whether pressing a row would have any effect.
 */
function normalizeNote(raw) {
  if (raw === undefined) return '';
  if (typeof raw === 'string' && PATH_RE.test(raw)) return { path: raw, is: undefined, text: '' };
  if (!plainRecord(raw)) return null;
  const path = typeof raw.path === 'string' ? raw.path : '';
  if (!path || !PATH_RE.test(path)) return null;
  const text = cleanText(raw.text, 200);
  if (!text) return null;
  return { path, is: raw.is, text };
}

/**
 * Validate one parsed spec document.
 *
 * Returns `{ cards }` or `{ error }` — a spec that cannot be fully understood is
 * rejected whole rather than partially honoured: a card whose second action was
 * silently dropped would look like it worked and leave half the write applied.
 */
export function normalizeExternalCards(document) {
  if (!plainRecord(document)) return { cards: [], error: 'spec must be an object' };
  if (document.version !== SPEC_VERSION) {
    return { cards: [], error: `spec version must be ${SPEC_VERSION}` };
  }
  const rawCards = Array.isArray(document.cards) ? document.cards : [];
  if (rawCards.length > MAX_CARDS) return { cards: [], error: `at most ${MAX_CARDS} cards` };
  const cards = [];
  for (const [index, raw] of rawCards.entries()) {
    const result = normalizeCard(raw, index);
    if (result.error) return { cards: [], error: result.error };
    cards.push(result.card);
  }
  const seen = new Set();
  for (const card of cards) {
    const key = card.command.toLowerCase();
    if (seen.has(key)) return { cards: [], error: `duplicate command ${card.command}` };
    seen.add(key);
  }
  return { cards };
}

/** Load and validate the file. A missing file is not an error — it is "no cards". */
export async function loadExternalCards(dshHome) {
  const file = join(dshHome, EXTERNAL_CARDS_FILENAME);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { cards: [], file };
    return { cards: [], file, error: `cannot read ${file}: ${error?.message ?? error}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { cards: [], file, error: `${file} is not valid JSON: ${error?.message ?? error}` };
  }
  return { ...normalizeExternalCards(parsed), file };
}

/** The card a message names, or undefined. Only the bare command matches. */
export function externalCardFor(text, cards) {
  if (typeof text !== 'string') return undefined;
  const command = text.trim();
  if (!COMMAND_RE.test(command)) return undefined;
  return (cards ?? []).find((card) => card.command.toLowerCase() === command.toLowerCase());
}

/** Load one parsed JSON document; `undefined` when it is absent or unreadable. */
async function readJsonFile(file) {
  try {
    // The restart helper writes its state with a UTF-8 BOM, and JSON.parse
    // rejects a leading BOM outright — without this strip the port fallback
    // silently found nothing and the discovery looked broken.
    const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/u, '');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Loopback base URLs recorded by the restart helper, first port first.
 *
 * The Host does not export its listening port to plugin code — not in argv, and
 * not in the environment of the process that hosts plugins — so a plugin that
 * must call a sibling plugin's route has no direct way to learn it. The restart
 * helper records the ports it bound, and the FIRST one is the one that serves
 * `/plugins/…`. This is a fallback, and it is verified by actually calling the
 * route rather than trusted on its own.
 */
export async function restartStateBaseUrls(dshHome) {
  if (typeof dshHome !== 'string' || !dshHome) return [];
  const state = await readJsonFile(join(dshHome, 'restart', 'restart-state.json'));
  const ports = Array.isArray(state?.newPorts) ? state.newPorts : [];
  return ports
    .filter((port) => Number.isSafeInteger(port) && port > 0)
    .map((port) => `http://127.0.0.1:${port}`);
}

async function requestJson(url, { method = 'GET', body, fetchImpl, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { error: 'no fetch implementation available' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const response = await doFetch(url, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { error: `HTTP ${response.status}${text ? `: ${cleanText(text, 200)}` : ''}` };
    }
    if (!text) return { value: undefined };
    try {
      return { value: JSON.parse(text) };
    } catch {
      return { error: 'upstream did not answer with JSON' };
    }
  } catch (error) {
    if (controller.signal.aborted) return { error: 'request timed out' };
    return { error: `request failed: ${error?.message ?? error}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * One card's rows, ready to render.
 *
 * `note` is read from the same document rather than derived here: only the
 * remote plugin knows whether its own override is currently in charge, and a
 * card that guessed would tell the reader a switch happened that could not.
 */
export async function fetchCardListing(card, { baseUrl, fetchImpl, signal } = {}) {
  const url = expand(card.list.url, { base: baseUrl });
  const answer = await requestJson(url, { fetchImpl, signal });
  if (answer.error) return { error: answer.error };
  const items = readPath(answer.value, card.list.items);
  if (!Array.isArray(items)) {
    return { error: `no array at "${card.list.items}" in the answer` };
  }
  const rows = [];
  for (const [offset, item] of items.slice(0, MAX_ITEMS).entries()) {
    const id = readPath(item, card.list.id);
    if (typeof id !== 'string' || !id) continue;
    const label = card.list.label ? cleanText(readPath(item, card.list.label)) : '';
    const isCurrent = card.list.current ? readPath(item, card.list.current) === true : false;
    rows.push({ index: offset + 1, id, label: label || id, current: isCurrent });
  }
  const note = resolveNote(answer.value, card.list.note);
  return { listing: { title: card.title, rows, note } };
}

/** The note a card should show, or '' when it does not apply. */
function resolveNote(document, note) {
  if (note === '') return '';
  const value = readPath(document, note.path);
  if (note.text !== '') return value === note.is ? note.text : '';
  return typeof value === 'string' ? cleanText(value, 200) : '';
}

/**
 * Apply one card's actions, in order, stopping at the first failure.
 *
 * A `settingsRewrite` action reads the CURRENT value of the named settings row,
 * writes the one field it was told to in a copy, and posts that copy back
 * through the owning plugin's own endpoint. It exists because the obvious
 * shortcut — posting a nested partial object — is not a merge: an endpoint that
 * does `{ ...prior, ...incoming }` per region replaces the whole nested object,
 * so a "turn the pool off" write that carried only `pool.enabled` would erase
 * the pool's members, target model and probe size. Fail-closed: a row that
 * cannot be read, or a `read` path that is not an object, writes NOTHING.
 */
export async function applyCardActions(card, row, { baseUrl, fetchImpl, signal, settings } = {}) {
  const context = { base: baseUrl, id: row.id, label: row.label };
  // What the actions actually changed, in the declaration's own words. Reported
  // back with the success message: an action that quietly turns something off is
  // exactly the side effect a reader must not have to discover later.
  const effects = [];
  for (const action of card.actions) {
    const url = expand(action.post, context);
    let body = action.body === undefined ? undefined : expand(action.body, context);
    // A rewrite whose field already holds the target value changes nothing, so
    // announcing its effect would be a lie. A plain POST cannot be inspected the
    // same way, so its declared effect is always reported.
    let changed = true;
    if (action.settingsRewrite) {
      const rewrite = action.settingsRewrite;
      if (!settings || typeof settings.describe !== 'function') {
        return { error: 'settings service unavailable' };
      }
      let described;
      try {
        described = settings.describe();
      } catch (error) {
        return { error: `cannot read settings: ${error?.message ?? error}` };
      }
      const target = (Array.isArray(described) ? described : [])
        .find((entry) => String(entry?.ns ?? '').includes(rewrite.nsIncludes));
      if (!target) return { error: `no settings section matching "${rewrite.nsIncludes}"` };
      const value = target.value;
      const current = readPath(value, rewrite.read);
      if (!plainRecord(current)) {
        return { error: `"${rewrite.read}" is not an object; refusing to rewrite it` };
      }
      changed = readPath(current, rewrite.set) !== rewrite.value;
      const patched = writePath(current, rewrite.set, rewrite.value);
      if (patched === undefined) return { error: `cannot rewrite "${rewrite.set}"` };
      // The wrapper is how the owning plugin's endpoint names the field it is
      // replacing; the patched object is spliced into `body` at `{patched}`.
      body = splicePatched(body ?? {}, patched);
    }
    const answer = await requestJson(url, { method: 'POST', body, fetchImpl, signal });
    if (answer.error) return { error: answer.error };
    if (changed && action.effect) effects.push(action.effect);
  }
  return { ok: true, effects };
}

/** Replace every `{patched}` placeholder in a body with the patched object. */
function splicePatched(value, patched) {
  if (value === '{patched}') return patched;
  if (Array.isArray(value)) return value.map((entry) => splicePatched(entry, patched));
  if (plainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, splicePatched(entry, patched)]),
    );
  }
  return value;
}
