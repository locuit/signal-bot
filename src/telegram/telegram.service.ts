import { Injectable, Logger } from '@nestjs/common';
import { TEST_USER_ID, TELEGRAM_TOKEN } from './telegram.constants';
import * as TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Redis from 'ioredis';

@Injectable()
export class TelegramService {
  private readonly bot: TelegramBot;
  private logger = new Logger(TelegramService.name);
  private readonly redis: Redis;
  private readonly API_URL =
    'https://api-v1.zealy.io/communities/flipster/questboard/v2';
  private readonly HEADERS = {
    accept: 'application/json',
    origin: 'https://zealy.io',
    referer: 'https://zealy.io/',
    'user-agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };

  constructor() {
    this.bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    this.redis = new Redis({
      host: 'localhost',
      port: 6379,
      db: 1,
    });
    this.bot.on('message', this.onReceiveMessage);

    setInterval(() => this.fetchData(), 60000);
  }

  async fetchData() {
    try {
      const response = await axios.get(this.API_URL, {
        headers: this.HEADERS,
      });
      const newQuests = response.data.map((q: any) => q.id);

      // Lấy danh sách ID đã lưu trong Redis
      const storedIds = await this.redis.smembers('quest_ids');

      // Tìm các ID mới
      const newIds = newQuests.filter((id) => !storedIds.includes(id));

      if (newIds.length > 0) {
        this.logger.log(`Found ${newIds.length} new quests!`);

        // Gửi thông báo Telegram
        for (const id of newIds) {
          await this.sendMessageToUser(
            '-1002262345303',
            `🔔 Quest mới xuất hiện: ${id}, tiêu đề: ${
              response.data.find((q: any) => q.id === id).title
            }`,
          );
        }

        // Cập nhật Redis với danh sách ID mới
        await this.redis.sadd('quest_ids', ...newIds);
      } else {
        this.logger.log('Không có quest mới.');
      }
    } catch (error) {
      this.logger.error('Error fetching data:', error.message);
    }
  }

  async onReceiveMessage(msg: any) {
    if (msg?.text) {
      const tokenSplashRegex = /^token splash (\w+)$/;
      const match = msg.text.match(tokenSplashRegex);

      if (msg.text === 'token splash') {
        const response = await this.getTokenSplashBybit();
        const formattedResponse = response.result.map((item: any) => ({
          ...item,
          depositStart: this.formatTimestamp(item.depositStart),
          depositEnd: this.formatTimestamp(item.depositEnd),
          publishTime: this.formatTimestamp(item.publishTime),
          applyStart: this.formatTimestamp(item.applyStart),
          applyEnd: this.formatTimestamp(item.applyEnd),
          systemTime: this.formatTimestamp(item.systemTime),
        }));
        const message = this.formatForTelegram(formattedResponse);
        await this.sendMessageToUser(msg.chat.id, message);
      } else if (match) {
        const tokenName = match[1];
        const response = await this.getTokenSplashByTokenName(tokenName);
        if (typeof response === 'string') {
          await this.sendMessageToUser(msg.chat.id, response);
        } else {
          const formattedResponse = {
            ...response,
            applyStart: this.formatTimestamp(response.applyStart),
            applyEnd: this.formatTimestamp(response.applyEnd),
            depositStart: this.formatTimestamp(response.depositStart),
            depositEnd: this.formatTimestamp(response.depositEnd),
            systemTime: this.formatTimestamp(response.systemTime),
          };
          const message = this.formatDetailForTelegram(formattedResponse);
          await this.sendMessageToUser(msg.chat.id, message);
        }
      }
    }
  }

  async sendMessageToUser(userId: string, message: string) {
    try {
      await this.bot.sendMessage(userId, message);
    } catch (error) {
      this.logger.error('Error sending message:', error.message);
    }
  }

  async getTokenSplashBybit() {
    const url =
      'https://api2.bybit.com/spot/api/deposit-activity/v2/project/ongoing/projectList';
    const response = await axios.get(url);
    return response.data;
  }

  async getDetailsByToken(projectCode: string) {
    const url = `https://api2.bybit.com/spot/api/deposit-activity/v2/project/detail?projectCode=${projectCode}`;
    const response = await axios.get(url);
    return response.data;
  }

  async getTokenSplashByTokenName(tokenName: string) {
    const response = await this.getTokenSplashBybit();
    const token = response.result.find((item: any) => item.token === tokenName);
    if (!token) {
      return 'Token not found';
    }
    const details = await this.getDetailsByToken(token.code);
    return details.result;
  }

  formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
  }

  formatForTelegram(tokens: any[]): string {
    return tokens
      .map((token) => {
        return (
          `✦ 𝗧𝗼𝗸𝗲𝗻: (${token.token})\n` +
          `⏳ 𝗧𝗵𝗼̛̀𝗶 𝗴𝗶𝗮𝗻 đ𝗮̆𝗻𝗴 𝗸𝘆́: ${token.applyStart} - ${token.applyEnd}\n` +
          `💰 𝗧𝗵𝗼̛̀𝗶 𝗴𝗶𝗮𝗻 𝗯𝗮̆́𝘁 đ𝗮̂̀𝘂 𝗻𝗮̣𝗽: ${token.depositStart}\n` +
          `👥 𝗧𝗼̂̉𝗻𝗴 𝗻𝗴𝘂̛𝗼̛̀𝗶 𝘁𝗵𝗮𝗺 𝗴𝗶𝗮: ${token.participants}\n` +
          `🎁 𝗧𝗼̂̉𝗻𝗴 𝗽𝗼𝗼𝗹 𝘁𝗵𝘂̛𝗼̛̉𝗻𝗴: 💎 ${token.totalPrizePool} ${token.token}\n`
        );
      })
      .join('\n\n');
  }

  formatDetailForTelegram(token: any): string {
    return (
      `✦ 𝗧𝗼𝗸𝗲𝗻: (${token.token})\n` +
      `⏳ 𝗕𝗮̆́𝘁 đ𝗮̂̀𝘂: ⏰ ${token.applyStart}\n` +
      `⏳ 𝗞𝗲̂́𝘁 𝘁𝗵𝘂́𝗰: ⏰ ${token.applyEnd}\n` +
      `🏆 𝗣𝗵𝗮̂̀𝗻 𝘁𝗵𝘂̛𝗼̛̉𝗻𝗴 𝗻𝗴𝘂̛𝗼̛̀𝗶 𝗺𝗼̛́𝗶: 🎉 ${token.newUserPrize} ${token.newUserPrizeToken}\n` +
      `💰 𝗣𝗵𝗮̂̀𝗻 𝘁𝗵𝘂̛𝗼̛̉𝗻𝗴 𝘁𝗿𝗮𝗱𝗲 𝗹𝗲̂𝗻 đ𝗲̂́𝗻: 💎 ${token.tradeAirdropTop} ${token.tradeToken}\n`
    );
  }
}
