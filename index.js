import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import "dotenv/config";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

// --------------------- 설정 ---------------------
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("❌ ERROR: .env에 TOKEN 변수가 없습니다.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = "!";
const NOTICE_CHANNEL_NAME = "트릭컬공지";
const UPDATE_URL = "https://m.cafe.naver.com/ca-fe/web/cafes/30131231/menus/67";
const COUPON_URL = "https://m.cafe.naver.com/ca-fe/web/cafes/30131231/menus/85";

// --------------------- Keep Alive ---------------------
const app = express();
app.get("/", (req, res) => res.send("✅ Trickcal 디스코드 봇 작동중"));
app.listen(3000, () => console.log("🌐 Keep-alive 서버 실행됨"));

// --------------------- 크롤러 ---------------------
async function fetchLatestPosts(url) {
  let browser;
  try {
    const executablePath = await chromium.executablePath();
    console.log("🧩 Chromium 실행 경로:", executablePath);

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
        "--no-zygote",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: "new", // Render에서 안정적인 모드
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 잠시 대기 (렌더링 안정화)
    await page.waitForTimeout(2000);

    const posts = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll("a[href*='/ArticleRead.nhn'], a[href*='/articles/']")
      );
      return links.slice(0, 5).map((el) => ({
        title: el.innerText.trim(),
        link: el.href.startsWith("http")
          ? el.href
          : `https://m.cafe.naver.com${el.getAttribute("href")}`,
      }));
    });

    console.log("📋 Found posts:", posts.length);
    return posts;
  } catch (err) {
    console.error("❌ Puppeteer 크롤링 오류:", err);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn("⚠️ 브라우저 종료 중 경고:", e.message);
      }
    }
  }
}
let lastUpdateTitle = "";
let lastCouponTitle = "";

// --------------------- 새글 자동 감지 ---------------------
async function checkNewPosts() {
  const updatePosts = await fetchLatestPosts(UPDATE_URL);
  const couponPosts = await fetchLatestPosts(COUPON_URL);

  const channel = client.channels.cache.find(
    (ch) => ch.name === NOTICE_CHANNEL_NAME
  );
  if (!channel) return;

  if (updatePosts[0] && updatePosts[0].title !== lastUpdateTitle) {
    lastUpdateTitle = updatePosts[0].title;
    const embed = new EmbedBuilder()
      .setColor(0x00bfff)
      .setTitle("📢 새 업데이트 공지")
      .setDescription(`**${updatePosts[0].title}**`)
      .setURL(updatePosts[0].link);
    channel.send({ embeds: [embed] });
  }

  if (couponPosts[0] && couponPosts[0].title !== lastCouponTitle) {
    lastCouponTitle = couponPosts[0].title;
    const embed = new EmbedBuilder()
      .setColor(0x00ff99)
      .setTitle("🎁 새 쿠폰 공지")
      .setDescription(`**${couponPosts[0].title}**`)
      .setURL(couponPosts[0].link);
    channel.send({ embeds: [embed] });
  }
}

setInterval(checkNewPosts, 5 * 60 * 1000); // 5분마다 확인

// --------------------- 명령어 ---------------------
client.on("messageCreate", async (m) => {
  if (m.author.bot) return;
  const content = m.content.trim();
  if (!content.startsWith(PREFIX)) return;

  const [cmd, arg] = content.slice(1).split(" ");

  if (cmd === "공지") {
    const isCoupon = arg === "쿠폰";
    const url = isCoupon ? COUPON_URL : UPDATE_URL;
    const posts = await fetchLatestPosts(url);

    if (posts.length === 0) return m.reply("불러올 수 없습니다 😢");

    const embed = new EmbedBuilder()
      .setColor(isCoupon ? 0x00ff99 : 0x00bfff)
      .setTitle(isCoupon ? "🎁 최신 쿠폰 공지" : "📢 최신 업데이트 공지")
      .setDescription(posts.map((p) => `• [${p.title}](${p.link})`).join("\n\n"));
    return m.reply({ embeds: [embed] });
  }

  if (cmd === "명령어") {
    const embed = new EmbedBuilder()
      .setTitle("📜 사용 가능한 명령어")
      .setDescription(
        [
          "`!공지 업데이트` - 최신 업데이트 공지 보기",
          "`!공지 쿠폰` - 최신 쿠폰 공지 보기",
          "`!명령어` - 명령어 목록 보기",
        ].join("\n")
      )
      .setColor(0x00ffff);
    return m.reply({ embeds: [embed] });
  }
});

// --------------------- Ready ---------------------
client.once("ready", () => {
  console.log(`✅ ${client.user.tag} 실행됨`);
  checkNewPosts(); // 시작 시 한 번 실행
});

client.login(TOKEN);
