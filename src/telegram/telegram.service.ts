import { Injectable, Logger } from '@nestjs/common';
import { TEST_USER_ID, TELEGRAM_TOKEN } from './telegram.constants';
import * as TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import Redis from 'ioredis';
import { SocksProxyAgent } from 'socks-proxy-agent';
import OpenAI from 'openai';

interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

interface SignalResult {
  type: 'LONG' | 'SHORT';
  entry: number;
  stoploss: number;
  takeProfit: number;
  confidence: number;
}

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
  private openai: OpenAI;

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
    // this.openai = new OpenAI({
    //   apiKey:
    // });

    this.scheduleFetch();

    setInterval(async () => {
      for (const [chatId, enabled] of this.marginWatcherEnabled.entries()) {
        if (!enabled) continue;

        const candles = await this.fetchCandleData('btc', '1m', 50);
        if (!candles) {
          this.logger.warn(`⚠️ Failed to fetch candle data for BTCUSDT (1m)`);
          continue;
        }

        const { signal, rsi } = this.simpleSignalAnalysis(candles);
        if (signal) {
          const message = this.formatSignal(signal, 'BTCUSDT', rsi);
          await this.sendMessageToUser(
            chatId.toString(),
            `📈 Phát hiện tín hiệu trên BTC 1m:\n\n${message}`,
          );
        }
      }
    }, 10000);
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
    if (!msg.text || !msg.chat || !msg.chat.id) {
      this.logger.warn('❌ Tin nhắn không hợp lệ:', msg);
      return;
    }
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
    if (text.startsWith('/smargin')) {
      await this.handleSimpleMargin(chatId, text);
    }
    // if (text.startsWith('/aimargin')) {
    //   await this.handleAIMargin(chatId, text);
    // }
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

  private async fetchCandleData(
    symbol: string,
    interval = '1m',
    limit = 50,
  ): Promise<CandleData[] | null> {
    try {
      const klines = await this.fetchBinanceFuturesKlines(
        symbol,
        interval,
        limit,
      );
      if (!klines) {
        this.logger.warn(`⚠️ No data returned for ${symbol} (${interval})`);
        return null;
      }

      // Transform Binance kline data to CandleData format
      const candleData: CandleData[] = klines.map((kline: any) => ({
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
        timestamp: parseInt(kline[0]),
      }));
      return candleData;
    } catch (error) {
      this.logger.error(
        `❌ Error fetching candle data for ${symbol}: ${error.message}`,
      );
      return null;
    }
  }

  private async handleSimpleMargin(chatId: string, text: string) {
    const parts = text.split(' ');
    if (parts.length < 2) {
      return this.sendMessageToUser(
        chatId,
        'Vui lòng gửi lệnh đúng định dạng: /smargin BTCUSDT',
      );
    }

    const symbol = parts[1].toUpperCase();
    const candles = await this.fetchCandleData(symbol);
    if (!candles) {
      return this.sendMessageToUser(
        chatId,
        `❌ Không thể lấy dữ liệu nến cho ${symbol}`,
      );
    }

    const { signal, rsi } = this.simpleSignalAnalysis(candles);
    if (!signal) {
      const rsiStatus =
        rsi < 30 ? '(Quá bán)' : rsi > 70 ? '(Quá mua)' : '(Trung lập)';
      return this.sendMessageToUser(
        chatId,
        `📊 Phân tích ${symbol} (SimpleSignal)\n- RSI: ${rsi.toFixed(
          2,
        )} ${rsiStatus}\n→ Không có tín hiệu rõ ràng`,
      );
    }

    await this.sendMessageToUser(
      chatId,
      this.formatSignal(signal, symbol, rsi),
    );
  }

  private simpleSignalAnalysis(data: CandleData[]): {
    signal: SignalResult | null;
    rsi: number;
  } {
    if (data.length < 15) {
      this.logger.warn(
        `⚠️ Insufficient data: ${data.length} candles, need at least 15`,
      );
      return { signal: null, rsi: 0 };
    }

    const rsi = this.calcRSI(data, 14);
    const latest = data[data.length - 1];

    if (rsi < 30) {
      return {
        signal: {
          type: 'LONG',
          entry: latest.close,
          stoploss: latest.close * 0.985, // 1.5% below entry
          takeProfit: latest.close * 1.02, // 2% above entry
          confidence: 0.7,
        },
        rsi,
      };
    }

    if (rsi > 70) {
      return {
        signal: {
          type: 'SHORT',
          entry: latest.close,
          stoploss: latest.close * 1.015, // 1.5% above entry
          takeProfit: latest.close * 0.98, // 2% below entry
          confidence: 0.7,
        },
        rsi,
      };
    }

    return { signal: null, rsi };
  }

  private calcRSI(data: CandleData[], period: number): number {
    let gains = 0;
    let losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
      const delta = data[i].close - data[i - 1].close;
      if (delta > 0) gains += delta;
      else losses -= delta;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }

  private calcEMA(data: CandleData[], period: number): number {
    const k = 2 / (period + 1);
    let ema = data[data.length - period].close;
    for (let i = data.length - period + 1; i < data.length; i++) {
      ema = data[i].close * k + ema * (1 - k);
    }
    return ema;
  }

  private formatSignal(
    signal: SignalResult,
    symbol: string,
    rsi?: number,
  ): string {
    const emoji = signal.type === 'LONG' ? '🟢' : '🔴';
    let message = `${emoji} *${
      signal.type
    } ${symbol}*\nEntry: ${signal.entry.toFixed(
      2,
    )}\nSL: ${signal.stoploss.toFixed(2)}\nTP: ${signal.takeProfit.toFixed(
      2,
    )}\n🎯 Độ tin cậy: ${(signal.confidence * 100).toFixed(0)}%`;

    if (rsi !== undefined) {
      const rsiStatus =
        rsi < 30 ? '(Quá bán)' : rsi > 70 ? '(Quá mua)' : '(Trung lập)';
      message = `${emoji} *${signal.type} ${symbol}*\n- RSI: ${rsi.toFixed(
        2,
      )} ${rsiStatus}\nEntry: ${signal.entry.toFixed(
        2,
      )}\nSL: ${signal.stoploss.toFixed(2)}\nTP: ${signal.takeProfit.toFixed(
        2,
      )}\n🎯 Độ tin cậy: ${(signal.confidence * 100).toFixed(0)}%`;
    }

    return message;
  }

  private async handleAIMargin(chatId: string, text: string) {
    const parts = text.split(' ');
    if (parts.length < 2) {
      return this.sendMessageToUser(
        chatId,
        'Vui lòng gửi đúng định dạng: /aimargin BTCUSDT',
      );
    }

    const symbol = parts[1].toUpperCase();
    const candles = await this.fetchCandleData(symbol);
    if (!candles) {
      return this.sendMessageToUser(
        chatId,
        `❌ Không thể lấy dữ liệu nến cho ${symbol}`,
      );
    }

    const prompt =
      `Bạn là chuyên gia phân tích kỹ thuật margin crypto.\n` +
      `Dữ liệu nến 1 phút mới nhất:\n${JSON.stringify(candles.slice(-20))}\n` +
      `Hãy đưa ra nhận định nên LONG hay SHORT với các mức entry, stoploss, takeProfit chính xác.\n` +
      `Trả về kết quả dạng JSON như sau: {"type":"LONG","entry":..., "stoploss":..., "takeProfit":..., "confidence":...}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Bạn là chuyên gia phân tích kỹ thuật margin crypto.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
      });

      const aiText = response.choices[0].message?.content;
      if (!aiText)
        return this.sendMessageToUser(chatId, 'AI không trả về nội dung.');

      let signal: SignalResult;
      try {
        signal = JSON.parse(aiText);
      } catch {
        return this.sendMessageToUser(
          chatId,
          'AI trả về định dạng không đúng JSON.',
        );
      }

      return this.sendMessageToUser(chatId, this.formatSignal(signal, symbol));
    } catch (err) {
      this.logger.error(`❌ AI error: ${err.message}`);
      return this.sendMessageToUser(
        chatId,
        'Lỗi khi gọi AI, vui lòng thử lại sau.',
      );
    }
  }
}
