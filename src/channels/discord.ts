import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvByPrefix } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface DiscordBotConfig {
  token: string;
  /** Channel IDs this bot handles. null = default/fallback bot (handles all unmapped channels). */
  channelIds: string[] | null;
}

interface BotInstance {
  token: string;
  client: Client;
  channelIds: Set<string> | null;
  botUserId: string | null;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private bots: BotInstance[] = [];
  private opts: DiscordChannelOpts;
  private botConfigs: DiscordBotConfig[];

  constructor(botConfigs: DiscordBotConfig[], opts: DiscordChannelOpts) {
    this.botConfigs = botConfigs;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const connectPromises = this.botConfigs.map((config) => {
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });

      const bot: BotInstance = {
        token: config.token,
        client,
        channelIds: config.channelIds ? new Set(config.channelIds) : null,
        botUserId: null,
      };

      client.on(Events.MessageCreate, async (message: Message) => {
        if (message.author.bot) return;

        const channelId = message.channelId;

        // Only process messages for channels this bot is responsible for
        const responsible = this.findBotForChannel(channelId);
        if (responsible !== bot) return;

        const chatJid = `dc:${channelId}`;
        let content = message.content;
        const timestamp = message.createdAt.toISOString();
        const senderName =
          message.member?.displayName ||
          message.author.displayName ||
          message.author.username;
        const sender = message.author.id;
        const msgId = message.id;

        let chatName: string;
        if (message.guild) {
          const textChannel = message.channel as TextChannel;
          chatName = `${message.guild.name} #${textChannel.name}`;
        } else {
          chatName = senderName;
        }

        // Translate @bot mentions into trigger format
        if (bot.botUserId) {
          const botId = bot.botUserId;
          const isBotMentioned =
            message.mentions.users.has(botId) ||
            content.includes(`<@${botId}>`) ||
            content.includes(`<@!${botId}>`);

          if (isBotMentioned) {
            content = content
              .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
              .trim();
            if (!TRIGGER_PATTERN.test(content)) {
              content = `@${ASSISTANT_NAME} ${content}`;
            }
          }
        }

        // Handle attachments — download images, describe others
        const imagePaths: string[] = [];
        if (message.attachments.size > 0) {
          const attachmentDescriptions: string[] = [];
          for (const att of message.attachments.values()) {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/') && att.url) {
              // Download image to temp dir
              try {
                const imgDir = path.join(DATA_DIR, 'images');
                fs.mkdirSync(imgDir, { recursive: true });
                const ext = path.extname(att.name || '.png') || '.png';
                const imgPath = path.join(imgDir, `${msgId}-${att.id}${ext}`);
                const resp = await fetch(att.url);
                if (resp.ok) {
                  const buf = Buffer.from(await resp.arrayBuffer());
                  fs.writeFileSync(imgPath, buf);
                  imagePaths.push(imgPath);
                  attachmentDescriptions.push(`[Image: ${att.name || 'image'}]`);
                } else {
                  attachmentDescriptions.push(`[Image: ${att.name || 'image'} (download failed)]`);
                }
              } catch (err) {
                logger.debug({ err, att: att.name }, 'Failed to download Discord image');
                attachmentDescriptions.push(`[Image: ${att.name || 'image'} (download failed)]`);
              }
            } else if (contentType.startsWith('video/')) {
              attachmentDescriptions.push(`[Video: ${att.name || 'video'}]`);
            } else if (contentType.startsWith('audio/')) {
              attachmentDescriptions.push(`[Audio: ${att.name || 'audio'}]`);
            } else {
              attachmentDescriptions.push(`[File: ${att.name || 'file'}]`);
            }
          }
          if (attachmentDescriptions.length > 0) {
            if (content) {
              content = `${content}\n${attachmentDescriptions.join('\n')}`;
            } else {
              content = attachmentDescriptions.join('\n');
            }
          }
        }

        // Handle reply context
        if (message.reference?.messageId) {
          try {
            const repliedTo = await message.channel.messages.fetch(
              message.reference.messageId,
            );
            const replyAuthor =
              repliedTo.member?.displayName ||
              repliedTo.author.displayName ||
              repliedTo.author.username;
            content = `[Reply to ${replyAuthor}] ${content}`;
          } catch {
            // Referenced message may have been deleted
          }
        }

        const isGroup = message.guild !== null;
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          chatName,
          'discord',
          isGroup,
        );

        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Discord channel',
          );
          return;
        }

        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          images: imagePaths.length > 0 ? imagePaths : undefined,
        });

        logger.info(
          { chatJid, chatName, sender: senderName },
          'Discord message stored',
        );
      });

      client.on(Events.Error, (err) => {
        logger.error({ err: err.message }, 'Discord client error');
      });

      this.bots.push(bot);

      return new Promise<void>((resolve) => {
        client.once(Events.ClientReady, (readyClient) => {
          bot.botUserId = readyClient.user.id;
          const scope = bot.channelIds
            ? `channels: ${[...bot.channelIds].join(', ')}`
            : 'default (all unmapped channels)';
          logger.info(
            { username: readyClient.user.tag, id: readyClient.user.id, scope },
            'Discord bot connected',
          );
          console.log(`\n  Discord bot: ${readyClient.user.tag} [${scope}]`);
          resolve();
        });

        client.login(config.token);
      });
    });

    await Promise.all(connectPromises);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^dc:/, '');
    const bot = this.findBotForChannel(channelId);
    if (!bot || !bot.client.isReady()) {
      logger.warn({ jid }, 'No Discord bot available for channel');
      return;
    }

    try {
      const channel = await bot.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.bots.some((b) => b.client.isReady());
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    for (const bot of this.bots) {
      bot.client.destroy();
    }
    this.bots = [];
    logger.info('Discord bot(s) stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const channelId = jid.replace(/^dc:/, '');
    const bot = this.findBotForChannel(channelId);
    if (!bot || !bot.client.isReady()) return;
    try {
      const channel = await bot.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  private findBotForChannel(channelId: string): BotInstance | undefined {
    // Explicit mapping takes priority
    const explicit = this.bots.find((b) => b.channelIds?.has(channelId));
    if (explicit) return explicit;
    // Fall back to default bot (no channelIds restriction)
    return this.bots.find((b) => b.channelIds === null);
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvByPrefix('DISCORD_BOT_');
  const botConfigs: DiscordBotConfig[] = [];

  // Collect numbered bots: DISCORD_BOT_TOKEN_1 + DISCORD_BOT_CHANNELS_1
  const seen = new Set<string>();
  for (const key of Object.keys(envVars)) {
    const match = key.match(/^DISCORD_BOT_TOKEN_(\d+)$/);
    if (!match) continue;
    const idx = match[1];
    if (seen.has(idx)) continue;
    seen.add(idx);
    const token = envVars[`DISCORD_BOT_TOKEN_${idx}`];
    const channelsRaw = envVars[`DISCORD_BOT_CHANNELS_${idx}`] || '';
    const channelIds = channelsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (token && channelIds.length > 0) {
      botConfigs.push({ token, channelIds });
    }
  }

  // Legacy/default token — handles all unmapped channels
  const defaultToken =
    envVars['DISCORD_BOT_TOKEN'] || process.env.DISCORD_BOT_TOKEN || '';
  if (defaultToken) {
    botConfigs.push({ token: defaultToken, channelIds: null });
  }

  if (botConfigs.length === 0) {
    logger.warn('Discord: no bot tokens configured');
    return null;
  }

  return new DiscordChannel(botConfigs, opts);
});
