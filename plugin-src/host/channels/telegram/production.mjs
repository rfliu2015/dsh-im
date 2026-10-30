import { TelegramConfigStore } from '../../../../src/channels/telegram/config-store.mjs';
import { TelegramHarnessClient } from '../../../../src/channels/telegram/harness-client.mjs';
import { TelegramController } from '../../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramRuntime } from '../../../../src/channels/telegram/telegram-runtime.mjs';
import { TelegramStateStore } from '../../../../src/channels/telegram/state-store.mjs';
import { createTelegramVoiceTranscriber } from '../../../../src/channels/telegram/voice.mjs';
import { createTokenProductionController } from '../shared/production.mjs';

export { normalizeTelegramAllowedUsers } from '../../../../src/channels/telegram/config-store.mjs';

export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'telegram',
    ConfigStore: TelegramConfigStore,
    StateStore: TelegramStateStore,
    HarnessClient: TelegramHarnessClient,
    Controller: TelegramController,
    Runtime: TelegramRuntime,
    // The per-group reply rules list chats from the shared group archive.
    controllerGroupHistory: true,
    // /notify drives the per-target Session sync the settings page also owns,
    // so the Host's delivery service has to reach the channel runtime.
    runtimeOptions: (config) => ({
      ...(config.deliveryService ? { deliveryService: config.deliveryService } : {}),
      // A card declared in `external-cards.json` may rewrite one field of
      // another plugin's settings section. The bridge refuses that action when
      // this is missing, rather than writing through a path it cannot read back.
      ...(typeof ctx?.get === 'function' && ctx.get('settings') ? { settings: ctx.get('settings') } : {}),
      // Resolve the declaration file from the Host's own configuration when it
      // sets one, so the bridge does not have to guess from the environment.
      ...(config.dshHome ? { dshHome: config.dshHome } : {}),
      // The Host's own loopback origin. A card declared in `external-cards.json`
      // calls a sibling plugin's route, and this is the only source that stays
      // correct without that sibling: it is what the Host is actually listening
      // on right now, not a port written down by a restart helper.
      ...(typeof config.hostOrigin === 'function' ? { hostOrigin: config.hostOrigin } : {}),
    }),
    // Speech recognition is a Host service (@deepseek-ai/dsh-experimental-speech-to-text);
    // the channel only converts the attachment and forwards the transcript.
    createVoiceTranscriber: (ctx) => createTelegramVoiceTranscriber({
      speechToText: typeof ctx?.get === 'function' ? ctx.get('speechToText') : ctx?.speechToText,
      logger: typeof ctx?.logger === 'function' ? ctx.logger('dsh-im:telegram-voice') : ctx?.logger,
    }),
  });
}
