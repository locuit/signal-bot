import { Injectable, Logger } from '@nestjs/common';
import { TEST_USER_ID, TELEGRAM_TOKEN } from './telegram.constants';
import * as TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Redis from 'ioredis';
import { SocksProxyAgent } from 'socks-proxy-agent';

@Injectable()
export class TelegramService {
  private readonly bot: TelegramBot;
  private logger = new Logger(TelegramService.name);
  private readonly redis: Redis;
  private marginWatcherEnabled = new Map<string, boolean>();

  private readonly API_URLS = [
    {
      url: 'https://api-v1.zealy.io/communities/flipster/questboard/v2',
      redisKey: 'quest_ids_main',
    },
    {
      url: 'https://api-v1.zealy.io/communities/vnmflipstercommunity/questboard/v2',
      redisKey: 'quest_ids_vnm',
    },
  ];
  private readonly HEADERS = {
    accept: 'application/json',
    origin: 'https://zealy.io',
    referer: 'https://zealy.io/',
    'user-agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };

  constructor() {
    const proxy =
      'socks5://ac2mjefsxv5bhv1w:a7spy9rdhngxerby@198.12.102.25:19617';
    const agent = new SocksProxyAgent(proxy);

    this.bot = new TelegramBot(TELEGRAM_TOKEN, {
      polling: true,
      request: {
        agent,
        url: 'https://api.telegram.org',
      },
    });

    this.redis = new Redis({
      host: 'localhost',
      port: 6379,
      db: 1,
    });

    this.onReceiveMessage = this.onReceiveMessage.bind(this);
    this.bot.on('message', this.onReceiveMessage);

    this.scheduleFetch();

    setInterval(async () => {
      for (const [chatId, enabled] of this.marginWatcherEnabled.entries()) {
        if (!enabled) continue;
        const result = await this.analyzeMarginByInterval('btc', '1m');

        if (/long|short/i.test(result)) {
          await this.sendMessageToUser(
            chatId.toString(),
            `📈 Phát hiện tín hiệu trên BTC 1m:\n\n${result}`,
          );
        }
      }
    }, 60000);
  }

  async fetchData() {
    try {
      for (const api of this.API_URLS) {
        await this.trackQuests(api.url, api.redisKey);
      }
    } catch (error) {
      this.logger.error('❌ Lỗi khi fetch dữ liệu:', error.message);
    } finally {
      this.scheduleFetch();
    }
  }

  async trackQuests(apiUrl: string, redisKey: string) {
    try {
      const response = await axios.get(apiUrl, { headers: this.HEADERS });
      const questIds: string[] = [];

      response.data.forEach((quest: any) => {
        questIds.push(quest.id);
        if (quest.quests) {
          quest.quests.forEach((subQuest: any) => {
            questIds.push(subQuest.id);
          });
        }
      });

      const storedIds = await this.redis.smembers(redisKey);
      const newIds = questIds.filter((id) => !storedIds.includes(id));

      if (newIds.length > 0) {
        this.logger.log(`🔔 Found ${newIds.length} new quests from ${apiUrl}`);

        for (const id of newIds) {
          await this.sendMessageToUser(
            '-1002262345303',
            `🔔 Quest mới xuất hiện: ${id} từ ${
              apiUrl.split('/')[4]
            } @amibaobei @Bemin1602 @locltan`,
          );
          await this.sendMessageToUser(
            '-4678982803',
            `🔔 Quest mới xuất hiện: ${id} từ ${apiUrl.split('/')[4]}`,
          );
        }
        await this.redis.sadd(redisKey, ...newIds);
      } else {
        this.logger.log(`✅ Không có quest mới từ ${apiUrl}.`);
      }
    } catch (error) {
      this.logger.error(`❌ Lỗi khi fetch từ ${apiUrl}:`, error.message);
    }
  }

  scheduleFetch() {
    const delay = Math.random() * 60000;
    this.logger.log(
      `⏳ Lên lịch fetch tiếp theo sau ${Math.round(delay / 1000)} giây`,
    );
    setTimeout(() => this.fetchData(), delay);
  }

  async onReceiveMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id.toString();
    const text = msg.text?.trim();

    if (text?.startsWith('/price ')) {
      const symbol = text.split(' ')[1].toUpperCase();
      const message = await this.getFormattedPriceMessage(symbol);
      await this.sendMessageToUser(chatId, message);
    }
    if (text.startsWith('/val')) {
      const parts = text.split(' ');
      if (parts.length !== 3) {
        await this.sendMessageToUser(
          chatId,
          '❗ Định dạng đúng: /val <số lượng> <mã coin>. Ví dụ: `/val 200 btc`',
        );
        return;
      }

      const amount = parseFloat(parts[1]);
      const coin = parts[2];

      if (isNaN(amount) || amount <= 0) {
        await this.sendMessageToUser(
          chatId,
          '❗ Vui lòng nhập số lượng hợp lệ.',
        );
        return;
      }

      const price = await this.getCoinPrice(coin);
      if (!price) {
        await this.sendMessageToUser(
          chatId,
          `❌ Không tìm thấy giá cho ${coin.toUpperCase()}.`,
        );
        return;
      }

      const total = amount * price;
      const formattedTotal = total.toLocaleString('en-US', {
        maximumFractionDigits: 2,
      });
      const formattedPrice = price.toLocaleString('en-US', {
        maximumFractionDigits: 2,
      });

      await this.sendMessageToUser(
        chatId,
        `📊 Giá trị ${amount} ${coin.toUpperCase()} ≈ ${formattedTotal} USDT\n(Tỷ giá hiện tại: ${formattedPrice} USDT/${coin.toUpperCase()})`,
      );
    }
    if (text.startsWith('/p2p')) {
      const parts = text.split(' ');
      if (parts.length !== 3) {
        await this.sendMessageToUser(
          chatId,
          '❗ Định dạng đúng: /p2p <số lượng> <mã coin>. Ví dụ: `/p2p 200 usdt`',
        );
        return;
      }

      const amount = parseFloat(parts[1]);
      const coin = parts[2];

      if (isNaN(amount) || amount <= 0) {
        await this.sendMessageToUser(
          chatId,
          '❗ Vui lòng nhập số lượng hợp lệ.',
        );
        return;
      }

      const rate = await this.getP2PRateToVND(coin);
      if (!rate) {
        await this.sendMessageToUser(
          chatId,
          `❌ Không tìm thấy tỷ giá P2P cho ${coin.toUpperCase()}.`,
        );
        return;
      }

      const total = amount * rate;
      const formattedTotal = total.toLocaleString('vi-VN', {
        maximumFractionDigits: 0,
      });
      const formattedRate = rate.toLocaleString('vi-VN', {
        maximumFractionDigits: 0,
      });

      await this.sendMessageToUser(
        chatId,
        `🇻🇳 Tỷ giá P2P: 1 ${coin.toUpperCase()} ≈ ${formattedRate} VND\n💵 ${amount} ${coin.toUpperCase()} ≈ ${formattedTotal} VND`,
      );
    }
    if (text?.startsWith('/margin')) {
      const parts = text.split(' ');
      if (parts.length !== 3) {
        await this.sendMessageToUser(
          chatId,
          '❗ Cú pháp: /margin <mã coin> <khung thời gian>. Ví dụ: /margin btc 5m',
        );
        return;
      }

      const coin = parts[1].toLowerCase();
      const interval = parts[2].toLowerCase();

      // Kiểm tra interval có hợp lệ không
      const allowedIntervals = [
        '1m',
        '3m',
        '5m',
        '15m',
        '30m',
        '1h',
        '2h',
        '4h',
        '6h',
        '12h',
        '1d',
      ];
      if (!allowedIntervals.includes(interval)) {
        await this.sendMessageToUser(
          chatId,
          `❗ Khung thời gian không hợp lệ. Hỗ trợ: ${allowedIntervals.join(
            ', ',
          )}`,
        );
        return;
      }

      // Gọi hàm lấy và phân tích dữ liệu chart futures
      const analysis = await this.analyzeMarginByInterval(coin, interval);

      await this.sendMessageToUser(chatId, analysis);
      return;
    }
    if (text?.startsWith('/signal')) {
      const parts = text.split(' ');
      if (parts.length !== 2 || !['on', 'off'].includes(parts[1])) {
        await this.sendMessageToUser(
          chatId,
          '❗ Dùng: /signal on hoặc /signal off',
        );
        return;
      }

      const enable = parts[1] === 'on';
      this.marginWatcherEnabled.set(chatId.toString(), enable);

      await this.sendMessageToUser(
        chatId,
        `🔁 Tín hiệu Scalping BTC 1m đã được ${enable ? 'bật ✅' : 'tắt ❌'}`,
      );
      return;
    }
    if (text?.startsWith('/help')) {
      const helpMessage = `
      🤖 Danh sách lệnh bot hỗ trợ:
      
      /price <coin> – Xem giá hiện tại. Ví dụ: /price btc
      /val <số lượng> <coin> – Tính giá trị coin theo USDT. Ví dụ: /val 0.5 btc
      /p2p <số lượng> <coin> – Xem tỷ giá P2P và giá trị tương ứng. Ví dụ: /p2p 100 usdt
      /margin <coin> <khung thời gian> – Phân tích margin futures theo biểu đồ. Ví dụ: /margin eth 15m
      /signal on|off – Bật/tắt tín hiệu tự động khi có phân tích Long/Short BTC chart 1m
            
      📊 Khung thời gian hỗ trợ: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d
      🧠 Tín hiệu tự động chỉ áp dụng cho BTC khung 1m khi bật /signal on
        `;
      await this.sendMessageToUser(chatId, helpMessage);
      return;
    }
  }

  async sendMessageToUser(userId: string, message: string) {
    try {
      await this.bot.sendMessage(userId, message);
    } catch (error) {
      this.logger.error('Error sending message:', error.message);
    }
  }

  private async getFormattedPriceMessage(symbol: string): Promise<string> {
    const pair = symbol.toUpperCase() + 'USDT';
    try {
      const response = await axios.get(
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`,
      );
      const data = response.data;

      const price = parseFloat(data.lastPrice);
      const change = parseFloat(data.priceChangePercent);
      const high = parseFloat(data.highPrice);
      const low = parseFloat(data.lowPrice);
      const volumeToken = parseFloat(data.volume);
      const volumeUSDT = parseFloat(data.quoteVolume);

      return (
        `$${symbol}/$USDT\n` +
        `💰 Price: ${price.toLocaleString(undefined, {
          minimumFractionDigits: 2,
        })} USDT\n` +
        `↕️ 24HR Change: ${change.toFixed(3)}%\n` +
        `📈 High: ${high.toLocaleString(undefined, {
          minimumFractionDigits: 2,
        })} USDT\n` +
        `📉 Low: ${low.toLocaleString(undefined, {
          minimumFractionDigits: 2,
        })} USDT\n` +
        `📊 Vol: ${volumeToken.toLocaleString(undefined, {
          minimumFractionDigits: 2,
        })} ${symbol}\n` +
        `📊 Vol: ${this.formatLargeNumber(volumeUSDT)} USDT`
      );
    } catch (err) {
      return `❌ Không thể lấy dữ liệu cho ${symbol}/USDT`;
    }
  }

  private formatLargeNumber(num: number): string {
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'b';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'm';
    return num.toFixed(2);
  }

  private async getCoinPrice(symbol: string): Promise<number | null> {
    try {
      const response = await axios.get(
        `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}USDT`,
      );
      return parseFloat(response.data.price);
    } catch (error) {
      this.logger.warn(`⚠️ Không lấy được giá ${symbol}: ${error.message}`);
      return null;
    }
  }

  private async getP2PRateToVND(asset: string): Promise<number | null> {
    try {
      const response = await axios.post(
        'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
        {
          page: 1,
          rows: 1,
          payTypes: ['BANK'],
          asset: asset.toUpperCase(),
          tradeType: 'BUY',
          fiat: 'VND',
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const price = response.data?.data?.[0]?.adv?.price;
      return price ? parseFloat(price) : null;
    } catch (error) {
      this.logger.warn(
        `⚠️ Không lấy được giá P2P cho ${asset}: ${error.message}`,
      );
      return null;
    }
  }

  async fetchBinanceFuturesKlines(
    symbol: string,
    interval: string,
    limit = 50,
  ) {
    try {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}USDT&interval=${interval}&limit=${limit}`;
      const response = await axios.get(url);
      return response.data; // Mảng mảng [ openTime, open, high, low, close, ... ]
    } catch (e) {
      return null;
    }
  }

  calculateRSI(closes: number[], period = 14) {
    let gains = 0,
      losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }

  formatNumber(n: number, digit = 2) {
    return Number(n).toFixed(digit);
  }

  async analyzeMarginByInterval(
    coin: string,
    interval: string,
  ): Promise<string> {
    const klines = await this.fetchBinanceFuturesKlines(coin, interval, 100);
    if (!klines)
      return `❌ Không thể lấy dữ liệu cho ${coin.toUpperCase()} (${interval})`;

    const closes = klines.map((k: any) => parseFloat(k[4]));
    const rsi = this.calculateRSI(closes);
    const ma7 = this.movingAverage(closes, 7);
    const ma21 = this.movingAverage(closes, 21);
    const { macd, signal } = this.calculateMACD(closes);
    const bands = this.calculateBollingerBands(closes);
    const latestClose = closes.at(-1)!;

    // MA trend
    let maTrend = 'Không rõ';
    if (ma7.length && ma21.length) {
      const latestMa7 = ma7.at(-1)!;
      const latestMa21 = ma21.at(-1)!;
      maTrend = latestMa7 > latestMa21 ? '🔼 Uptrend' : '🔽 Downtrend';
    }

    // MACD signal
    let macdSignal = 'Không rõ';
    const latestMacd = macd.at(-1) || 0;
    const latestSignal = signal.at(-1) || 0;
    if (macd.length > 2 && signal.length > 2) {
      const prevMacd = macd.at(-2)!;
      const prevSignal = signal.at(-2)!;
      if (prevMacd < prevSignal && latestMacd > latestSignal)
        macdSignal = '✅ Tín hiệu mua';
      else if (prevMacd > prevSignal && latestMacd < latestSignal)
        macdSignal = '❌ Tín hiệu bán';
    }

    // Bollinger
    const band = bands.at(-1)!;
    let bollSignal = '📉 Trong dải';
    if (latestClose > band.upper) bollSignal = '🟠 Vượt dải trên (Quá mua)';
    else if (latestClose < band.lower)
      bollSignal = '🟢 Dưới dải dưới (Quá bán)';

    // Nhận định cuối
    let decision = '⏸️ Không vào lệnh';
    if (
      rsi < 30 &&
      macdSignal.includes('mua') &&
      maTrend.includes('Uptrend') &&
      bollSignal.includes('Quá bán')
    ) {
      decision = '🟩 LONG (Mua)';
    } else if (
      rsi > 70 &&
      macdSignal.includes('bán') &&
      maTrend.includes('Downtrend') &&
      bollSignal.includes('Quá mua')
    ) {
      decision = '🟥 SHORT (Bán)';
    }

    return `📊 Phân tích margin ${coin.toUpperCase()} (${interval})\n
- RSI: ${this.formatNumber(rsi)} ${
      rsi < 30 ? '(Quá bán)' : rsi > 70 ? '(Quá mua)' : ''
    }
- MA7 vs MA21: ${maTrend}
- MACD: ${this.formatNumber(latestMacd)} / Signal: ${this.formatNumber(
      latestSignal,
    )} (${macdSignal})
- Bollinger Bands: ${bollSignal}
→ Nhận định: *${decision}*

⚠️ Chỉ báo mang tính tham khảo, không phải lời khuyên đầu tư.`;
  }

  // Tính MA (đơn giản trung bình cộng)
  movingAverage(data: number[], period: number): number[] {
    const ma = [];
    for (let i = 0; i <= data.length - period; i++) {
      const slice = data.slice(i, i + period);
      const avg = slice.reduce((a, b) => a + b, 0) / period;
      ma.push(avg);
    }
    return ma;
  }

  // Tính MACD: EMA12 - EMA26 (EMA tính đơn giản)
  exponentialMovingAverage(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
      ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }

  calculateMACD(closes: number[]) {
    const ema12 = this.exponentialMovingAverage(closes, 12);
    const ema26 = this.exponentialMovingAverage(closes, 26);
    const macd = ema12.map((val, idx) => val - ema26[idx]);
    // Tính signal line (EMA9 của MACD)
    const signal = this.exponentialMovingAverage(macd.slice(26 - 12), 9);
    return { macd, signal };
  }

  // Tính Bollinger Bands (MA20 ± 2*stdDev)
  standardDeviation(values: number[]) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map((v) => Math.pow(v - avg, 2));
    const avgSquareDiff =
      squareDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquareDiff);
  }

  calculateBollingerBands(closes: number[], period = 20) {
    const bands = [];
    for (let i = 0; i <= closes.length - period; i++) {
      const slice = closes.slice(i, i + period);
      const ma = slice.reduce((a, b) => a + b, 0) / period;
      const stdDev = this.standardDeviation(slice);
      bands.push({
        middle: ma,
        upper: ma + 2 * stdDev,
        lower: ma - 2 * stdDev,
      });
    }
    return bands;
  }
}
