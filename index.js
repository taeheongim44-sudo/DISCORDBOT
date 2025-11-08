import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { execSync } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json());

// 🧩 서버 유지용
app.get("/", (req, res) => res.send("✅ Discord Bot is running"));
app.listen(3000, () => console.log("🌐 Keep-alive 서버 실행됨"));

// ==========================
// 🎮 디스코드 클라이언트
// ==========================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const TOKEN = process.env.DISCORD_TOKEN; // Render 환경변수에 저장
const TRICKAL_NOTICE_URL = "https://m.cafe.naver.com/ca-fe/web/cafes/trickcal/menus/1/articles";
const NOTICE_CHANNEL_ID = "트릭컬공지채널_ID_여기에"; // ← 바꿔주세요

// ==========================
// 🧩 최근 게시글 기록용 (중복 방지)
// ==========================
let postedTitles = new Set();

// ==========================
// 🧩 Puppeteer 크롤링 함수
// ==========================
async function fetchLatestPosts(url) {
  let browser;
  try {
    const basePath = await chromium.executablePath();
    const tempPath = `/tmp/chromium-${Date.now()}`;
    execSync(`cp ${basePath} ${tempPath} && chmod 755 ${tempPath}`);
    console.log("✅ Chromium 임시 복사 및 권한 설정 완료:", tempPath);

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
        "--no-zygote",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: tempPath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    try {
      await page.waitForSelector("a[href*='/ArticleRead.nhn'], a[href*='/articles/']", {
        timeout: 10000,
      });
    } catch {
      console.warn("⚠️ 게시글 렌더링 대기 시간 초과, 재시도 시도");
    }

    await new Promise((r) => setTimeout(r, 3000));

    let posts = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll("a[href*='/ArticleRead.nhn'], a[href*='/articles/'], a.link_board")
      );
      return links.slice(0, 5).map((el) => ({
        title: el.innerText.trim(),
        link: el.href.startsWith("http")
          ? el.href
          : `https://m.cafe.naver.com${el.getAttribute("href")}`,
      }));
    });

    if (posts.length === 0) {
      console.warn("⚠️ 게시글이 0개 → 1회 재시도");
      await new Promise((r) => setTimeout(r, 5000));
      posts = await page.evaluate(() => {
        const links = Array.from(
          document.querySelectorAll("a[href*='/ArticleRead.nhn'], a[href*='/articles/'], a.link_board")
        );
        return links.slice(0, 5).map((el) => ({
          title: el.innerText.trim(),
          link: el.href.startsWith("http")
            ? el.href
            : `https://m.cafe.naver.com${el.getAttribute("href")}`,
        }));
      });
    }

    console.log("📋 발견된 게시물:", posts.length);
    return posts;
  } catch (err) {
    console.error("❌ Puppeteer 크롤링 오류:", err);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ==========================
// 🧾 트릭컬 공지 자동 게시
// ==========================
async function checkTrickalNotices() {
  const posts = await fetchLatestPosts(TRICKAL_NOTICE_URL);
  if (!posts || posts.length === 0) return;

  const channel = await client.channels.fetch(NOTICE_CHANNEL_ID);
  if (!channel) return;

  for (const post of posts) {
    if (postedTitles.has(post.title)) continue; // 🔹 중복 방지

    postedTitles.add(post.title);
    console.log("📢 새 공지:", post.title);

    const embed = new EmbedBuilder()
      .setTitle("📢 트릭컬 리바이브 공지사항")
      .setDescription(`**${post.title}**`)
      .setURL(post.link)
      .setColor(0xF6C90E)
      .setFooter({ text: "자동 수집된 네이버 카페 공지", iconURL: "https://i.imgur.com/VHb0nmn.png" })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }
}

// 10분마다 실행
setInterval(checkTrickalNotices, 10 * 60 * 1000);

// ==========================
// 🎟️ 쿠폰목록 명령어
// ==========================
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  if (msg.content === "!쿠폰목록") {
    const couponPosts = await fetchLatestPosts(TRICKAL_NOTICE_URL);

    if (couponPosts.length === 0) {
      return msg.reply("❌ 현재 사용 가능한 쿠폰 정보가 없습니다.");
    }

    const embed = new EmbedBuilder()
      .setTitle("🎟️ 현재 사용 가능한 쿠폰 목록")
      .setColor(0xF6C90E)
      .setFooter({ text: "쿠폰 정보는 네이버 카페 기준 자동 수집됩니다." });

    couponPosts.forEach((p, i) => {
      embed.addFields({
        name: `#${i + 1} ${p.title}`,
        value: `[게시글 보기](${p.link})`,
      });
    });

    await msg.channel.send({ embeds: [embed] });
  }
});

// ==========================
// 🟢 클라이언트 실행
// ==========================
client.once("clientReady", () => {
  console.log(`✅ ${client.user.tag} 실행됨`);
  checkTrickalNotices(); // 초기 1회 실행
});

client.login(TOKEN);
