import { harnessQuestionText } from '../shared/harness-question.mjs';
import { t } from '../shared/i18n.mjs';
import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';
import { workspaceLabels } from '../shared/workspace-labels.mjs';

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
 * One keyboard row per workspace. Rows stack with no pagination: beyond this
 * the phone view becomes a wall of buttons, so the bridge falls back to the
 * text list that already answers `/ws <index>` (explicit degradation).
 */
const MAX_WORKSPACE_BUTTONS = 20;

/**
 * Encode one workspace button. The path cannot ride in `callback_data` (64-byte
 * budget), so the press carries a presentation nonce plus the index into the
 * snapshot the bridge cached when it sent the card. A stale card therefore
 * cannot switch to a workspace that a fresher list no longer contains.
 */
function workspaceCardCallbackData(nonce, index) {
  // Versioned namespace (upstream convention, cf. openclaw tga1:/tgq1:): a future
  // payload change can tell an old card apart instead of mis-parsing it.
  return `w1|${nonce}|${index}`;
}

/** Parse a press produced by {@link workspaceCardCallbackData}; null for foreign payloads. */
export function parseTelegramWorkspaceCallback(data) {
  const match = typeof data === 'string'
    ? /^w1\|([A-Za-z0-9_-]{1,16})\|(\d{1,3})$/u.exec(data)
    : null;
  if (!match) return null;
  return { nonce: match[1], index: Number(match[2]) };
}

/**
 * Inline-keyboard presentation for the merged `/ws` listing.
 *
 * The card text is deliberately state-free: after a press only the keyboard is
 * replaced (`editMessageReplyMarkup`), so a "current: …" sentence in the body
 * would immediately lie about which workspace is current.
 */
export const TELEGRAM_WORKSPACE_CARD = Object.freeze({
  render(listing, { nonce } = {}) {
    if (typeof nonce !== 'string' || !nonce) return null;
    const paths = Array.isArray(listing?.paths) ? listing.paths : [];
    if (paths.length === 0 || paths.length > MAX_WORKSPACE_BUTTONS) return null;
    const current = typeof listing?.current === 'string' ? listing.current : null;
    const labels = workspaceLabels(paths, listing?.titles ?? {});
    return {
      text: t('选择要切换的工作区（共 {count} 个）：', { count: paths.length }),
      markup: {
        inline_keyboard: paths.map((path, index) => [{
          text: `${path === current ? '✓ ' : ''}${index + 1}. ${labels[index].label}`,
          callback_data: workspaceCardCallbackData(nonce, index),
        }]),
      },
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

export class TelegramHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    super({
      descriptor: TELEGRAM_DESCRIPTOR,
      interactionCard: TELEGRAM_INTERACTION_CARD,
      workspaceCard: TELEGRAM_WORKSPACE_CARD,
      sessionCard: TELEGRAM_SESSION_CARD,
      ...options,
    });
  }
}

export { createTextBridgeStatus as createTelegramBridgeStatus };
