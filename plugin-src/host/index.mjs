import { installGroupHistoryTools } from '../../src/channels/shared/group-history-access.mjs';
import { apply as applyDingtalk } from './channels/dingtalk/index.mjs';
import { apply as applyDiscord } from './channels/discord/index.mjs';
import { apply as applyOffice } from './channels/office/index.mjs';
import { apply as applyFeishu } from './channels/feishu/index.mjs';
import { apply as applyQq } from './channels/qq/index.mjs';
import { apply as applySlack } from './channels/slack/index.mjs';
import { apply as applyTelegram } from './channels/telegram/index.mjs';
import { apply as applyWecom } from './channels/wecom/index.mjs';
import { apply as applyWecomApp } from './channels/wecom-app/index.mjs';
import { apply as applyWeixin } from './channels/weixin/index.mjs';
import { apply as applyWhatsapp } from './channels/whatsapp/index.mjs';
import { apply as applyIMessage } from './channels/imessage/index.mjs';
import { apply as applyEmail } from './channels/email/index.mjs';
import { apply as applyMatrix } from './channels/matrix/index.mjs';
import { installOutboundArtifactTool } from '../../src/channels/shared/semantic/artifact.mjs';
import { installHostLanguage } from './host-language.mjs';
import { installHostLanguageRpc } from './host-language-rpc.mjs';
import { installDeliveryRpc } from './delivery-rpc.mjs';
import { installDeliveryHttp } from './delivery-http.mjs';
import { createDeliveryService } from './delivery-service.mjs';
import { createDsBotClient } from './ds-bot-client.mjs';
import { installDsBotQuestionSync } from './ds-bot-question-sync.mjs';
import { installInboundTtlRpc } from './inbound-ttl-rpc.mjs';
import { installSidebarSettingsRpc } from './sidebar-settings.mjs';
import { installInjectedContext } from './injected-context.mjs';
import { installSessionSyncCoordinator } from './session-sync-coordinator.mjs';
import { installSessionTitlePrefix } from './session-title-prefix.mjs';
import { installUpdateRpc } from './update-rpc.mjs';

export const name = 'dsh-im-host';
export const inject = [
  'connection',
  'credentials',
  'typertGateway',
  // A card declared in `external-cards.json` may rewrite one field of another
  // plugin's settings section, and the only safe way to do that is to read the
  // live value back first. Without this injection the channel receives no
  // settings service and those actions refuse rather than write.
  'settings',
];

/**
 * The Host's own loopback origin, or null when the service exposes neither.
 *
 * `port` is a real number on this build (`getOrigin()` and a `port` getter are on
 * the prototype). Both are tried because a future Host could drop either, and a
 * wrong origin is worse than no origin: callers treat null as "ask somewhere
 * else", while a guessed URL would be attempted and fail confusingly.
 */
function webServerOrigin(webServer) {
  try {
    if (!webServer) return null;
    if (typeof webServer.getOrigin === 'function') {
      const origin = webServer.getOrigin();
      if (typeof origin === 'string' && origin) return origin.replace(/\/+$/u, '');
    }
    const port = webServer.port;
    if (Number.isSafeInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
    return null;
  } catch {
    return null;
  }
}

function channelConfig(config, name, deliveryService, originRef) {
  const channel = { ...(config.dshHome ? { dshHome: config.dshHome } : {}), ...config[name] };
  const withAuthority = config.rpcAuthority === undefined
    ? channel
    : { ...channel, rpcAuthority: config.rpcAuthority };
  // A live getter, not a value: the channel asks when a command needs the origin
  // rather than at start-up, so the answer survives either injection order.
  const withOrigin = typeof originRef?.value !== 'undefined'
    ? { ...withAuthority, hostOrigin: () => originRef.value }
    : withAuthority;
  return name === 'office' ? withOrigin : { ...withOrigin, deliveryService };
}

export function createImHostPlugin(internals = {}) {
  const startHostLanguage = internals.installHostLanguage ?? installHostLanguage;
  const startHostLanguageRpc = internals.installHostLanguageRpc ?? installHostLanguageRpc;
  const startUpdate = internals.installUpdateRpc ?? installUpdateRpc;
  const startInboundTtl = internals.installInboundTtlRpc ?? installInboundTtlRpc;
  const startSidebarSettings = internals.installSidebarSettingsRpc ?? installSidebarSettingsRpc;
  const startInjectedContext = internals.installInjectedContext ?? installInjectedContext;
  const startDelivery = internals.installDeliveryRpc ?? installDeliveryRpc;
  const startDeliveryHttp = internals.installDeliveryHttp ?? installDeliveryHttp;
  const startSessionSync = internals.installSessionSyncCoordinator
    ?? installSessionSyncCoordinator;
  const makeDeliveryService = internals.createDeliveryService ?? createDeliveryService;
  const startFeishu = internals.applyFeishu ?? applyFeishu;
  const startWeixin = internals.applyWeixin ?? applyWeixin;
  const startDingtalk = internals.applyDingtalk ?? applyDingtalk;
  const startWecom = internals.applyWecom ?? applyWecom;
  const startWecomApp = internals.applyWecomApp ?? applyWecomApp;
  const startQq = internals.applyQq ?? applyQq;
  const startSlack = internals.applySlack ?? applySlack;
  const startTelegram = internals.applyTelegram ?? applyTelegram;
  const startDiscord = internals.applyDiscord ?? applyDiscord;
  const startOffice = internals.applyOffice ?? applyOffice;
  const startWhatsapp = internals.applyWhatsapp ?? applyWhatsapp;
  const startIMessage = internals.applyIMessage ?? applyIMessage;
  const startEmail = internals.applyEmail ?? applyEmail;
  const startMatrix = internals.applyMatrix ?? applyMatrix;
  const channels = [
    ['feishu', startFeishu],
    ['weixin', startWeixin],
    ['dingtalk', startDingtalk],
    ['wecom', startWecom],
    ['wecomApp', startWecomApp],
    ['qq', startQq],
    ['slack', startSlack],
    ['telegram', startTelegram],
    ['discord', startDiscord],
    ['whatsapp', startWhatsapp],
    ['imessage', startIMessage],
    ['email', startEmail],
    ['matrix', startMatrix],
    ['office', startOffice],
  ];
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      // Mutable so the webServer injection can publish the origin after the
      // channels have already been activated: the two injections are
      // independent and nothing orders them. A command that runs before the
      // origin is known simply finds no candidate, which is the same failure
      // mode as before this existed.
      const originRef = { value: null };
      const unavailableSessionSyncChannels = channels
        .map(([channel]) => channel)
        .filter((channel) => channel !== 'office'
          && config[channel]?.harnessBaseUrl !== undefined);
      const deliveryService = makeDeliveryService({
        unavailableSessionSyncChannels: unavailableSessionSyncChannels.map((channel) => channel === 'wecomApp' ? 'wecom-app' : channel),
        dsBot: createDsBotClient(ctx),
      });
      if (typeof ctx?.provide === 'function') {
        ctx.provide('dshIm', Object.freeze({
          contractVersion: 1,
          receiptVersion: 1,
          inboundVersion: 1,
          consumeInbound: (botId, options) => deliveryService.consumeInbound(botId, options),
          historyChecked: (botId, route, query, options) => deliveryService.historyChecked(botId, route, query, options),
          replyChecked: (botId, route, text, options) => deliveryService.replyChecked(botId, route, text, options),
          describeBot: (botId) => deliveryService.describeBot(botId),
          sendChecked: (botId, targetId, text, options) => deliveryService.sendChecked(botId, targetId, text, options),
          send: (botId, targetId, text, options) => (
            deliveryService.send(botId, targetId, text, options)
          ),
          listTargets: async (botId) => (await deliveryService.listTargets(botId)).targets,
          createTarget: (botId, target) => deliveryService.createTarget(botId, target),
          listBots: () => deliveryService.listBots(),
        }));
      }
      const activate = async (readyCtx) => {
        await activateChannels(readyCtx, config, deliveryService, originRef);
      };
      if (typeof ctx?.inject === 'function') {
        await ctx.inject(
          ['sessionController', 'workspaceController'],
          activate,
        );
        ctx.inject(['webServer'], (httpCtx) => {
          // The origin the Host itself listens on, for channels that must call a
          // sibling plugin's route. Read here so it is published before any
          // command can run, and re-read lazily by the channel in case this
          // injection resolves after activation.
          originRef.value = webServerOrigin(httpCtx?.webServer);
          startDeliveryHttp(httpCtx, deliveryService);
        });
        return;
      }
      await activate(ctx);
      if (ctx?.webServer?.register && typeof ctx?.effect === 'function') {
        originRef.value = webServerOrigin(ctx.webServer);
        startDeliveryHttp(ctx, deliveryService);
      }
    },
  });

  async function activateChannels(ctx, config, deliveryService, originRef = { value: null }) {
    // Bind the bot message language before any channel connects, so the first
    // command menu a platform stores is already in the interface language.
    const hostLanguage = startHostLanguage(ctx, config);
    await hostLanguage?.ready;
    const startTitlePrefix = (titleCtx) => {
      // The installer owns its cleanup through ctx.effect(). Cordis startup
      // callbacks must not return its controller object as an effect.
      installSessionTitlePrefix(titleCtx, {
        logger: typeof titleCtx?.logger === 'function'
          ? titleCtx.logger('dsh-im:session-title') : (titleCtx?.logger ?? console),
      });
    };
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['sessions'], startTitlePrefix);
    } else if (ctx?.sessions && typeof ctx.on === 'function') {
      startTitlePrefix(ctx);
    }
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['tools', 'systemPrompt'], (artifactCtx) => {
        installOutboundArtifactTool(artifactCtx);
        installGroupHistoryTools(artifactCtx);
      });
    } else {
      installOutboundArtifactTool(ctx);
      installGroupHistoryTools(ctx);
    }
    const logger = typeof ctx?.logger === 'function'
      ? ctx.logger(name)
      : (ctx?.logger ?? console);
    try {
      startInjectedContext(ctx, { logger });
    } catch (error) {
      logger.error?.('[dsh-im] failed to activate injected-context pairing; prompts keep the inline prefix', error);
    }
    if (ctx?.connection?.fetch) {
      if (hostLanguage) {
        try {
          startHostLanguageRpc(ctx, hostLanguage, config.rpcAuthority);
        } catch (error) {
          logger.error?.('[dsh-im] failed to activate interface language mirroring; continuing with channels', error);
        }
      }
      try {
        startUpdate(ctx);
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate update management; continuing with channels', error);
      }
      try {
        startSidebarSettings(ctx, { config });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate sidebar settings; continuing with channels', error);
      }
      try {
        startInboundTtl(ctx, { config });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate inbound TTL settings; continuing with channels', error);
      }
      try {
        startDelivery(ctx, deliveryService, { authority: config.rpcAuthority });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate delivery management; continuing with channels', error);
      }
    }
    const failures = [];
    // Each channel mounts its management RPC before awaiting initialization.
    // Start them together so a slow channel cannot leave later routes absent.
    await Promise.all(channels.map(async ([channel, start]) => {
      try {
        await start(ctx, channelConfig(config, channel, deliveryService, originRef));
      } catch (error) {
        failures.push(error);
        logger.error?.(`[dsh-im] failed to activate ${channel}; continuing with the remaining channels`, error);
      }
    }));
    if (failures.length === channels.length) {
      throw new AggregateError(failures, 'dsh-im failed to activate every channel');
    }
    if (typeof ctx?.on === 'function') {
      try {
        startSessionSync(ctx, deliveryService, {
          logger,
          inputScope: ctx.root ?? ctx,
        });
        installDsBotQuestionSync(ctx, deliveryService, { logger });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate Session sync; continuing with channels', error);
      }
    }
  }
}

export async function apply(ctx, config = {}) {
  return createImHostPlugin().apply(ctx, config);
}
