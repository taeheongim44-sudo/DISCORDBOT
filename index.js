import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import "dotenv/config";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import fetch from "node-fetch";
import express from "express";
import * as cheerio from "cheerio";

dotenv.config();

// ─────────────────────────────
// Discord 클라이언트 설정
// ─────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("❌ 오류: .env에 TOKEN 변수가 없습니다.");
  process.exit(1);
}

// 자동 공지 채널 ID (트릭컬 공지 채널 ID 숫자만)
const NOTICE_CHANNEL_ID = process.env.NOTICE_CHANNEL_ID;

// ─────────────────────────────
// 크롤링 대상 URL
// ─────────────────────────────
const UPDATE_URL = "https://m.cafe.naver.com/ca-fe/web/cafes/30131231/menus/67";
const COUPON_URL = "https://m.cafe.naver.com/ca-fe/web/cafes/30131231/menus/85";

// ─────────────────────────────
// 게시글 크롤링
// ─────────────────────────────
async function fetchPosts(target) {
  const url = target === "update" ? UPDATE_URL : COUPON_URL;
  console.log(`[크롤링 시작] ${url}`);

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const html = await page.content();
  const $ = cheerio.load(html);

  const posts = [];
  $("a[href*='/ArticleRead.nhn']").each((_, el) => {
    const title = $(el).text().trim();
    const link = $(el).attr("href");
    if (title && link) {
      posts.push({
        title,
        url: `https://m.cafe.naver.com${link}`,
      });
    }
  });

  await browser.close();
  console.log(`[크롤링 완료] ${target} 게시글 ${posts.length}개`);
  return posts.slice(0, 5);
}

// ─────────────────────────────
// 자동 공지 중복 방지용 저장소
// ─────────────────────────────
let sentPosts = new Set();

// ─────────────────────────────
// 자동 공지 기능
// ─────────────────────────────
async function autoNotify() {
  if (!NOTICE_CHANNEL_ID) return;
  const channel = await client.channels.fetch(NOTICE_CHANNEL_ID);
  if (!channel) return console.log("⚠️ 공지 채널을 찾을 수 없습니다.");

  // 업데이트 게시글
  const updates = await fetchPosts("update");
  for (const post of updates) {
    if (!sentPosts.has(post.title)) {
      await channel.send(`🆕 **[업데이트]** ${post.title}\n${post.url}`);
      sentPosts.add(post.title);
    }
  }

  // 쿠폰 게시글 (중복 방지)
  const coupons = await fetchPosts("coupon");
  for (const post of coupons) {
    if (!sentPosts.has(post.title)) {
      await channel.send(`🎟️ **[쿠폰]** ${post.title}\n${post.url}`);
      sentPosts.add(post.title);
    }
  }
}

// 10분마다 새 게시글 확인
setInterval(autoNotify, 10 * 60 * 1000);

// ─────────────────────────────
// 명령어 처리
// ─────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim();

  // !업데이트
  if (content === "!업데이트") {
    msg.channel.send("🔍 트릭컬 최신 업데이트 정보를 불러오는 중...");
    try {
      const posts = await fetchPosts("update");
      if (posts.length === 0) {
        msg.channel.send("❌ 업데이트 게시글을 찾을 수 없습니다.");
      } else {
        const formatted = posts
          .map((p, i) => `📘 ${i + 1}. [${p.title}](${p.url})`)
          .join("\n");
        msg.channel.send(`✅ **트릭컬 업데이트 게시글**\n${formatted}`);
      }
    } catch (err) {
      console.error(err);
      msg.channel.send("⚠️ 업데이트 정보를 불러오는 중 오류가 발생했습니다.");
    }
  }

  // !쿠폰목록 → 사용 가능한 쿠폰만
  if (content === "!쿠폰목록") {
    msg.channel.send("🎟️ 현재 사용 가능한 쿠폰을 확인 중입니다...");
    try {
      const posts = await fetchPosts("coupon");
      const available = posts.filter((p) =>
        /(사용|가능|유효|입력)/i.test(p.title)
      );
      if (available.length === 0) {
        msg.channel.send("❌ 현재 사용 가능한 쿠폰이 없습니다.");
      } else {
        const formatted = available
          .map((p, i) => `🎫 ${i + 1}. [${p.title}](${p.url})`)
          .join("\n");
        msg.channel.send(`✅ **사용 가능한 쿠폰 목록**\n${formatted}`);
      }
    } catch (err) {
      console.error(err);
      msg.channel.send("⚠️ 쿠폰 정보를 불러오는 중 오류가 발생했습니다.");
    }
  }
});

// ─────────────────────────────
// 봇 로그인 및 서버 유지
// ─────────────────────────────
client.once("clientReady", () => {
  console.log(`✅ ${client.user.tag} 실행됨`);
  autoNotify(); // 봇 시작 시 1회 즉시 실행
});

client.login(TOKEN);

// ─────────────────────────────
// Keep-alive 서버
// ─────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🌐 Keep-alive 서버 실행 중\n✅ 버터의옐로카드(노예) 정상 작동!");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Keep-alive 서버 실행됨 (포트: ${PORT})`);
});
