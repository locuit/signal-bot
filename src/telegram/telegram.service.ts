import { Injectable, Logger } from '@nestjs/common';
import { TEST_USER_ID, TELEGRAM_TOKEN } from './telegram.constants';
import * as TelegramBot from 'node-telegram-bot-api';
import * as axios from 'axios';

@Injectable()
export class TelegramService {
  private readonly bot: TelegramBot;
  private logger = new Logger(TelegramService.name);

  constructor() {
    this.bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

    this.bot.on('message', this.onReceiveMessage);

    // this.sendMessageToUser(TEST_USER_ID, `Server started at ${new Date()}`);

    // this.getChannelMessages('-1002351920230');
  }

  onReceiveMessage = async (msg: any) => {
    if(msg?.text) {
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
  };

  sendMessageToUser = async (userId: string, message: string) => {
    try {
      await this.bot.sendMessage(userId, message);
    } catch (error) {
      console.error(error);
    }
  };

  getChannelMessages = async (channelName: string) => {
    try {
      const chat = await this.bot.getChat(channelName);
      this.logger.debug(chat);
    } catch (error) {
      console.error(error);
    }
  };

  async getTokenSplashBybit() {
    const url =
      'https://api2.bybit.com/spot/api/deposit-activity/v2/project/ongoing/projectList';
    const response = await axios.default.get(url);
    return response.data;
  }

  async getDetailsByToken(projectCode: string) {
    const url = `https://api2.bybit.com/spot/api/deposit-activity/v2/project/detail?projectCode=${projectCode}`;
    const response = await axios.default.get(url);
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
    const ss = String(date.getSeconds()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const DD = String(date.getDate()).padStart(2, '0');
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const YYYY = date.getFullYear();
    return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}-UTC`;
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
