const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET,
};
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// スケジュール調整（投票管理）
const schedulePolls = {};

function createSchedulePoll(dates) {
  const id = Date.now().toString();
  schedulePolls[id] = { dates, votes: {} };
  dates.forEach(d => (schedulePolls[id].votes[d] = []));
  return id;
}

function voteSchedule(pollId, date, userId) {
  if (!schedulePolls[pollId]) return false;
  const poll = schedulePolls[pollId];
  if (!poll.votes[date]) return false;
  if (!poll.votes[date].includes(userId)) poll.votes[date].push(userId);
  return true;
}

function getScheduleResult(pollId) {
  if (!schedulePolls[pollId]) return null;
  const poll = schedulePolls[pollId];
  return Object.entries(poll.votes)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([date, users]) => `${date}：${users.length}票`)
    .join('\n');
}

// 飲食店探し
async function searchRestaurants(query) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const searchRes = await axios.get(
    'https://maps.googleapis.com/maps/api/place/textsearch/json',
    { params: { query, language: 'ja', key: apiKey } }
  );
  const places = searchRes.data.results.slice(0, 3);
  if (!places.length) return 'お店が見つかりませんでした😢';
  return places
    .map((p, i) => {
      const rating = p.rating ? `⭐${p.rating}` : '評価なし';
      const mapUrl = `https://www.google.com/maps/place/?q=place_id:${p.place_id}`;
      return `${i + 1}. ${p.name}\n${rating} | ${p.formatted_address}\n🔗 ${mapUrl}`;
    })
    .join('\n\n');
}

// AI質問
async function askClaude(question) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: question }],
  });
  return msg.content[0].text;
}

// メッセージハンドラ
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const text = event.message.text.trim();
  const userId = event.source.userId;
  let replyText = '';

  if (text.startsWith('@bot スケジュール')) {
    const dateMatches = text.match(/\d+\/\d+/g);
    if (dateMatches && dateMatches.length > 0) {
      const pollId = createSchedulePoll(dateMatches);
      replyText =
        `📅 スケジュール調整を開始します！\n\n` +
        dateMatches.map(d => `・${d}`).join('\n') +
        `\n\n参加できる日付を以下の形式で教えてください！\n「投票 ${pollId} 日付」\n例：投票 ${pollId} ${dateMatches[0]}`;
    } else {
      replyText = '日付を入れてください！\n例：@bot スケジュール 7/20 7/21 7/22';
    }
  }

  else if (text.startsWith('投票 ')) {
    const parts = text.split(' ');
    if (parts.length >= 3) {
      const pollId = parts[1];
      const date = parts[2];
      const ok = voteSchedule(pollId, date, userId);
      replyText = ok ? `✅ ${date} に投票しました！` : '投票できませんでした。IDか日付を確認してください。';
    }
  }

  else if (text.startsWith('結果 ')) {
    const pollId = text.split(' ')[1];
    const result = getScheduleResult(pollId);
    replyText = result ? `📊 集計結果：\n${result}` : '集計データが見つかりません。';
  }

  else if (text.startsWith('@bot') && (
    text.includes('探して') || text.includes('おすすめ') ||
    text.includes('ランチ') || text.includes('ディナー') ||
    text.includes('飯') || text.includes('ご飯') ||
    text.includes('カフェ') || text.includes('レストラン')
  )) {
    const query = text.replace('@bot', '').trim();
    replyText = await searchRestaurants(query);
  }

  else if (text.startsWith('@bot ')) {
    const question = text.replace('@bot', '').trim();
    replyText = await askClaude(question);
  }

  else if (text === 'ヘルプ' || text === 'help') {
    replyText =
      `🤖 使い方ガイド\n\n` +
      `🗓 スケジュール調整\n「@bot スケジュール 7/20 7/21 7/22」\n\n` +
      `🍽 お店探し\n「@bot 梅田でコスパいい焼肉探して」\n\n` +
      `💬 AI質問\n「@bot 明日の天気は？」\n\n` +
      `📊 投票・結果\n「投票 [ID] [日付]」\n「結果 [ID]」`;
  }

  if (replyText) {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: replyText }],
    });
  }
}

// Webhook
app.post(
  '/webhook',
  line.middleware(lineConfig),
  (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
      .then(() => res.json({ status: 'ok' }))
      .catch(err => { console.error(err); res.status(500).end(); });
  }
);

// 管理者一斉送信
app.use(express.json());
app.post('/broadcast', async (req, res) => {
  const { message, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: '認証エラー' });
  }
  await client.broadcast({ type: 'text', text: message });
  res.json({ status: 'sent' });
});

app.get('/', (req, res) => res.send('LINE Bot is running! 🤖'));

app.listen(3000, () => console.log('Server running on port 3000'));
