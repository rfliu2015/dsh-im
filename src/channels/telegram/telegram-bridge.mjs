import { harnessQuestionText } from '../shared/harness-question.mjs';
import { t } from '../shared/i18n.mjs';
import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';
import { workspaceLabels } from '../shared/workspace-labels.mjs';
import { TelegramApprovalCard } from './approval-card.mjs';

export const TELEGRAM_DESCRIPTOR = Object.freeze({
  key: 'telegram',
  label: 'Telegram',
  connectionLabel: ' Bot API 长轮询',
  // A finished turn leaves no reaction behind: Telegram keeps offering reaction
  // controls on a message that carries one, which repeats for the reader even
  // with reaction notifications off. A failure still keeps its mark.
  reactions: Object.freeze({ processing: '👀', success: null, error: '👎' }),
});

/** One keyboard row per option; beyond this the list stops being scannable. */
const MAX_CARD_OPTIONS = 8;

/**
 * Encode a press. Carries the presentation nonce so a keyboard left over from an
 * earlier question cannot answer a later one — a new request restarts its indexes
 * at zero, so the index alone would collide. Still far under Telegram's 64-byte
 * callback_data budget, so no server-side id table is needed.
 */
function cardCallbackData(nonce, questionIndex, optionIndex) {
  return `q|${nonce}|${questionIndex}|${optionIndex}`;
}

/** Parse a press produced by {@link cardCallbackData}; null for foreign payloads. */
export function parseTelegramCardCallback(data) {
  const match = typeof data === 'string'
    ? /^q\|([A-Za-z0-9_-]{1,16})\|(\d{1,4})\|(\d{1,4})$/u.exec(data)
    : null;
  if (!match) return null;
  return {
    nonce: match[1],
    questionIndex: Number(match[2]),
    optionIndex: Number(match[3]),
  };
}

/**
 * Inline-keyboard presentation for single-choice questions.
 *
 * Returns null — leaving the plain-text flow in charge — when a keyboard cannot
 * express every answer the request allows: no options, an unusable button label,
 * more options than fit, or multi-select (which needs an accumulating keyboard
 * plus a submit action this channel does not have yet).
 */
export const TELEGRAM_INTERACTION_CARD = Object.freeze({
  render(question, { questionIndex = 0, total = 1, requiresMention = false, nonce } = {}) {
    // Without an identity the press could not be attributed to this presentation.
    if (typeof nonce !== 'string' || !nonce) return null;
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length === 0 || options.length > MAX_CARD_OPTIONS) return null;
    if (question.multiSelect === true) return null;
    if (options.some((option) => typeof option?.label !== 'string' || !option.label.trim())) {
      return null;
    }
    return {
      text: harnessQuestionText(question, questionIndex, total, {
        requiresMention,
        hasButtons: true,
      }),
      markup: {
        inline_keyboard: options.map((option, optionIndex) => [{
          text: option.label,
          callback_data: cardCallbackData(nonce, questionIndex, optionIndex),
        }]),
      },
    };
  },
  parse: parseTelegramCardCallback,
});

/**
 * One page of workspace rows. Eight, same ceiling as the session and model
 * cards: a keyboard taller than a phone screen is a scroll, not a list. The
 * old single-screen card refused to render at all beyond 20 workspaces and
 * fell back to the text list; paging keeps the card for any number of them.
 * Labels are computed over the FULL list, because a title collision on
 * another page still has to be disambiguated on this one.
 */
const MAX_WORKSPACE_BUTTONS = 8;

/**
 * Encode one workspace-card press.
 *
 * A path cannot ride in `callback_data` (64-byte budget), so a press carries a
 * presentation nonce plus an action: `s` switches to an index into the cached
 * snapshot, `p` turns to a page. The index is the position in `listing.paths`,
 * not a position on the visible page, so a press on page two names the same
 * workspace the text list numbers.
 */
function workspaceCardCallbackData(nonce, action, argument) {
  // Versioned namespace (upstream convention, cf. openclaw tga1:/tgq1:): a
  // future payload change can tell an old card apart instead of mis-parsing it.
  // `w1` was the index-only payload; `w2` adds the action.
  const payload = `w2|${nonce}|${action}`;
  return argument === undefined ? payload : `${payload}|${argument}`;
}

/** Parse a workspace-card press; null for foreign payloads. */
export function parseTelegramWorkspaceCallback(data) {
  if (typeof data !== 'string') return null;
  const match = /^w2\|([A-Za-z0-9_-]{1,16})\|([sp])\|(\d{1,4})$/u.exec(data);
  if (match) {
    return { nonce: match[1], action: match[2], index: Number(match[3]) };
  }
  // A card delivered before paging existed named a switch by index alone. Keep
  // it working rather than leaving an old keyboard with an unparseable press.
  const legacy = /^w1\|([A-Za-z0-9_-]{1,16})\|(\d{1,3})$/u.exec(data);
  return legacy ? { nonce: legacy[1], action: 's', index: Number(legacy[2]) } : null;
}

/**
 * Inline-keyboard presentation for the merged `/ws` listing.
 *
 * The body deliberately states only count and page, never which workspace is
 * current: a switch elsewhere can change the current workspace while this card
 * is on screen. The ✓ marker lives in the keyboard and is re-marked in place.
 */
export const TELEGRAM_WORKSPACE_CARD = Object.freeze({
  render(listing, { nonce, page = 0 } = {}) {
    if (typeof nonce !== 'string' || !nonce) return null;
    const paths = Array.isArray(listing?.paths) ? listing.paths : [];
    if (paths.length === 0) return null;
    const pages = Math.max(1, Math.ceil(paths.length / MAX_WORKSPACE_BUTTONS));
    const current = Number.isSafeInteger(page) && page >= 0 && page < pages ? page : 0;
    const start = current * MAX_WORKSPACE_BUTTONS;
    const currentPath = typeof listing?.current === 'string' ? listing.current : null;
    const labels = workspaceLabels(paths, listing?.titles ?? {});
    const keyboard = paths.slice(start, start + MAX_WORKSPACE_BUTTONS).map((path, offset) => {
      const index = start + offset;
      return [{
        text: `${path === currentPath ? '✓ ' : ''}${index + 1}. ${labels[index].label}`,
        callback_data: workspaceCardCallbackData(nonce, 's', index),
      }];
    });
    // Only pages that exist get a button, so Telegram never sees an identical
    // keyboard edit (which it rejects as "message is not modified").
    const pager = [];
    if (current > 0) {
      pager.push({
        text: t('上一页'),
        callback_data: workspaceCardCallbackData(nonce, 'p', current - 1),
      });
    }
    if (current < pages - 1) {
      pager.push({
        text: t('下一页'),
        callback_data: workspaceCardCallbackData(nonce, 'p', current + 1),
      });
    }
    if (pager.length > 0) keyboard.push(pager);
    const heading = pages > 1
      ? t('选择要切换的工作区（共 {count} 个，第 {page}/{pages} 页）：', {
        count: paths.length, page: current + 1, pages,
      })
      : t('选择要切换的工作区（共 {count} 个）：', { count: paths.length });
    return {
      text: heading,
      markup: { inline_keyboard: keyboard },
      page: current,
      pages,
    };
  },
  parse: parseTelegramWorkspaceCallback,
});

/** Sessions one page carries: eight rows still fit one phone screen. */
const MAX_SESSION_BUTTONS = 8;

/** Inline-keyboard labels sit in the message body, so keep them one short line. */
function cardLabel(value, max = 60) {
  const text = typeof value === 'string'
    ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
    : '';
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * Encode one session-card press.
 *
 * A Session id cannot ride in `callback_data` (64-byte budget), so a press
 * carries the presentation nonce plus, for a bind, the index of that session in
 * the snapshot the bridge cached when it sent the card. The index is the
 * `visibleSessions()` position, the same number `/sessionlist` prints and
 * `/session N` resolves, so the button and the command cannot disagree.
 */
function sessionCardCallbackData(nonce, action, argument) {
  const payload = `s1|${nonce}|${action}`;
  return argument === undefined ? payload : `${payload}|${argument}`;
}

/**
 * Parse a press produced by {@link sessionCardCallbackData}; null for foreign
 * payloads. Actions: `b` bind an indexed session, `n` create and bind a new
 * one, `r` return to the workspace picker, `p` show another page.
 */
export function parseTelegramSessionCallback(data) {
  const match = typeof data === 'string'
    ? /^s1\|([A-Za-z0-9_-]{1,16})\|([bnrp])(?:\|(\d{1,4}))?$/u.exec(data)
    : null;
  if (!match) return null;
  return {
    nonce: match[1],
    action: match[2],
    ...(match[3] === undefined ? {} : { index: Number(match[3]) }),
  };
}

/**
 * Inline-keyboard presentation of one workspace's sessions.
 *
 * The card is a separate message from the workspace picker that opened it, so
 * the picker's text — and its "current" marker — stay untouched. Rows come from
 * the snapshot the bridge cached; the keyboard only ever names a position in it.
 */
export const TELEGRAM_SESSION_CARD = Object.freeze({
  render(listing, { nonce, page = 0 } = {}) {
    if (typeof nonce !== 'string' || !nonce) return null;
    if (!Array.isArray(listing?.sessions)) return null;
    const workspace = typeof listing?.workspace === 'string' ? listing.workspace : '';
    if (!workspace) return null;
    const sessions = listing.sessions;
    const pages = Math.max(1, Math.ceil(sessions.length / MAX_SESSION_BUTTONS));
    const current = Number.isSafeInteger(page) && page >= 0 && page < pages ? page : 0;
    const start = current * MAX_SESSION_BUTTONS;
    const keyboard = [];
    for (const [offset, session] of sessions.slice(start, start + MAX_SESSION_BUTTONS).entries()) {
      const position = start + offset;
      // An untitled Session has no name to show, and its id is long enough to
      // crowd the row out. The row already leads with its number, which is what
      // a press needs, so the label only has to be readable -- never identifying.
      const title = cardLabel(session?.title)
        || t('未命名会话 {number}', { number: position + 1 });
      keyboard.push([{
        text: `${position + 1}. ${title}`,
        callback_data: sessionCardCallbackData(nonce, 'b', position),
      }]);
    }
    keyboard.push([
      { text: t('新增会话'), callback_data: sessionCardCallbackData(nonce, 'n') },
      { text: t('返回'), callback_data: sessionCardCallbackData(nonce, 'r') },
    ]);
    // Only a page that actually exists gets a button. A next-page button that
    // resolves to the page already shown would send Telegram an identical
    // keyboard, which it refuses with a not-modified error -- a press the user
    // reads as a failure even though nothing is wrong.
    const pager = [];
    if (current > 0) {
      pager.push({
        text: t('上一页'),
        callback_data: sessionCardCallbackData(nonce, 'p', current - 1),
      });
    }
    if (current < pages - 1) {
      pager.push({
        text: t('下一页'),
        callback_data: sessionCardCallbackData(nonce, 'p', current + 1),
      });
    }
    if (pager.length > 0) keyboard.push(pager);
    // The page number belongs in the body because turning a page now rewrites
    // both the keyboard and the text: the reader can see the total and their
    // position without pressing anything. A single page says nothing extra.
    const heading = pages > 1
      ? t('选择要绑定的会话（共 {count} 个，第 {page}/{pages} 页）：', {
        count: sessions.length, page: current + 1, pages,
      })
      : t('选择要绑定的会话（共 {count} 个）：', { count: sessions.length });
    return {
      text: [
        t('工作区：{workspace}', { workspace }),
        heading,
      ].join('\n'),
      markup: { inline_keyboard: keyboard },
      page: current,
      pages,
    };
  },
  parse: parseTelegramSessionCallback,
});

/**
 * Models one card page carries. Same eight-row ceiling as the session card and
 * for the same reason — a keyboard taller than a phone screen is a scroll, not
 * a list — but its own constant: the two pages have no reason to move together.
 */
const MAX_MODEL_BUTTONS = 8;

/**
 * Encode one model-card press.
 *
 * A model id cannot ride in `callback_data` (64-byte budget) and is not stable
 * across catalog refreshes, so a press carries the presentation nonce plus the
 * index of that model in the `modelListing` snapshot the bridge cached when it
 * sent the card. The index IS the number `/model <n>` accepts — both walk the
 * catalog in the same order — so a button and a typed command cannot name
 * different models.
 */
function modelCardCallbackData(nonce, action, argument) {
  const payload = `m1|${nonce}|${action}`;
  return argument === undefined ? payload : `${payload}|${argument}`;
}

/**
 * Parse a press produced by {@link modelCardCallbackData}; null for foreign
 * payloads. Actions: `s` switch to an indexed model, `p` show another page.
 */
export function parseTelegramModelCallback(data) {
  const match = typeof data === 'string'
    ? /^m1\|([A-Za-z0-9_-]{1,16})\|([sp])(?:\|(\d{1,4}))?$/u.exec(data)
    : null;
  if (!match) return null;
  return {
    nonce: match[1],
    action: match[2],
    ...(match[3] === undefined ? {} : { index: Number(match[3]) }),
  };
}

/**
 * Inline-keyboard presentation of `/models`.
 *
 * Same shape as the session card on purpose: one row per model, a pager, and a
 * body that states the count so a press does not have to be tried to learn how
 * many pages there are. The current model is marked in the row label rather
 * than removed, because its position is what `/model <n>` still resolves — a
 * gap in the numbering would make the printed list and the buttons disagree.
 *
 * There is deliberately no separate "switch account" row: pressing the CURRENT
 * model's row already switches to the model it is on and then offers that
 * provider's account list, so a second entry point would be the same action
 * wearing two labels.
 */
export const TELEGRAM_MODEL_CARD = Object.freeze({
  render(listing, { nonce, page = 0 } = {}) {
    if (typeof nonce !== 'string' || !nonce) return null;
    if (!Array.isArray(listing?.items)) return null;
    const items = listing.items;
    const pages = Math.max(1, Math.ceil(items.length / MAX_MODEL_BUTTONS));
    const current = Number.isSafeInteger(page) && page >= 0 && page < pages ? page : 0;
    const start = current * MAX_MODEL_BUTTONS;
    const currentId = typeof listing.current === 'string' ? listing.current : null;
    const keyboard = [];
    for (const item of items.slice(start, start + MAX_MODEL_BUTTONS)) {
      const isCurrent = currentId !== null && item.id === currentId;
      keyboard.push([{
        text: `${isCurrent ? '✓ ' : ''}${item.index}. ${cardLabel(item.id)}`,
        callback_data: modelCardCallbackData(nonce, 's', item.index),
      }]);
    }
    const pager = [];
    if (current > 0) {
      pager.push({
        text: t('上一页'),
        callback_data: modelCardCallbackData(nonce, 'p', current - 1),
      });
    }
    if (current < pages - 1) {
      pager.push({
        text: t('下一页'),
        callback_data: modelCardCallbackData(nonce, 'p', current + 1),
      });
    }
    if (pager.length > 0) keyboard.push(pager);
    const heading = pages > 1
      ? t('可用模型（共 {count} 个，第 {page}/{pages} 页）：', {
        count: items.length, page: current + 1, pages,
      })
      : t('可用模型（共 {count} 个）：', { count: items.length });
    return {
      text: [
        currentId === null ? heading : t('当前模型：{model}', { model: currentId }),
        ...(currentId === null ? [] : [heading]),
        ...(Array.isArray(listing.failures) && listing.failures.length > 0
          ? ['', t('以下模型提供方暂时不可用：'), ...listing.failures.map((name) => `- ${name}`)]
          : []),
      ].join('\n'),
      markup: { inline_keyboard: keyboard },
      page: current,
      pages,
    };
  },
  parse: parseTelegramModelCallback,
});

/**
 * Encode one external-card press (a card declared in `external-cards.json`).
 *
 * `x1|` rather than a per-declaration namespace: the snapshot behind the nonce
 * already records which declaration produced the card, so a second namespace
 * would only add a way for the two to disagree.
 */
function externalCardCallbackData(nonce, action, argument) {
  const payload = `x1|${nonce}|${action}`;
  return argument === undefined ? payload : `${payload}|${argument}`;
}

/** Parse a press produced by {@link externalCardCallbackData}; null otherwise. */
export function parseTelegramExternalCardCallback(data) {
  const match = typeof data === 'string'
    ? /^x1\|([A-Za-z0-9_-]{1,16})\|([sp])(?:\|(\d{1,4}))?$/u.exec(data)
    : null;
  if (!match) return null;
  return {
    nonce: match[1],
    action: match[2],
    ...(match[3] === undefined ? {} : { index: Number(match[3]) }),
  };
}

/**
 * Inline-keyboard presentation of a user-declared external list.
 *
 * The body repeats the declaration's own note (e.g. "an override is currently
 * in charge") above the rows, because a press whose effect is being overridden
 * by something else has to say so before the reader presses it, not after.
 *
 * A row may carry a `detail` (a balance, a quota): it goes AFTER the label in
 * the same button, because the figure exists to help choose between rows and a
 * separate line would separate it from the thing it describes. The label is
 * shortened first so the detail is never the part that gets clipped — the label
 * is how a reader recognises the account, but the detail is why they are
 * reading the list at all.
 */
export const TELEGRAM_EXTERNAL_CARD = Object.freeze({
  render(listing, { nonce, page = 0 } = {}) {
    if (typeof nonce !== 'string' || !nonce) return null;
    if (!Array.isArray(listing?.rows)) return null;
    const rows = listing.rows;
    const pages = Math.max(1, Math.ceil(rows.length / MAX_MODEL_BUTTONS));
    const current = Number.isSafeInteger(page) && page >= 0 && page < pages ? page : 0;
    const start = current * MAX_MODEL_BUTTONS;
    const title = typeof listing.title === 'string' ? listing.title : '';
    const keyboard = [];
    for (const row of rows.slice(start, start + MAX_MODEL_BUTTONS)) {
      const detail = typeof row.detail === 'string' ? row.detail : '';
      const label = cardLabel(row.label, detail ? 28 : 60);
      keyboard.push([{
        text: `${row.current ? '✓ ' : ''}${row.index}. ${label}${detail ? ` · ${detail}` : ''}`,
        callback_data: externalCardCallbackData(nonce, 's', row.index),
      }]);
    }
    const pager = [];
    if (current > 0) {
      pager.push({ text: t('上一页'), callback_data: externalCardCallbackData(nonce, 'p', current - 1) });
    }
    if (current < pages - 1) {
      pager.push({ text: t('下一页'), callback_data: externalCardCallbackData(nonce, 'p', current + 1) });
    }
    if (pager.length > 0) keyboard.push(pager);
    const heading = pages > 1
      ? t('{title}（共 {count} 个，第 {page}/{pages} 页）：', {
        title, count: rows.length, page: current + 1, pages,
      })
      : t('{title}（共 {count} 个）：', { title, count: rows.length });
    return {
      text: [heading, ...(listing.note ? [listing.note] : [])].join('\n'),
      markup: { inline_keyboard: keyboard },
      page: current,
      pages,
    };
  },
  parse: parseTelegramExternalCardCallback,
});

export class TelegramHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    // Approval cards are on by default; `approvalCard: null` keeps the
    // plain-text approval flow for a caller that wants it (tests/tools).
    // The controller owns the per-conversation nonce registry.
    super({
      descriptor: TELEGRAM_DESCRIPTOR,
      interactionCard: TELEGRAM_INTERACTION_CARD,
      workspaceCard: TELEGRAM_WORKSPACE_CARD,
      sessionCard: TELEGRAM_SESSION_CARD,
      modelCard: TELEGRAM_MODEL_CARD,
      externalCard: TELEGRAM_EXTERNAL_CARD,
      ...options,
      approvalCard: options && Object.hasOwn(options, 'approvalCard')
        ? options.approvalCard
        : new TelegramApprovalCard({ logger: options?.logger }),
    });
  }
}

export { createTextBridgeStatus as createTelegramBridgeStatus };
