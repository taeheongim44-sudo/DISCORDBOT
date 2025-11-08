import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { execSync } from "child_process";

// ==========================
// 🌐 서버 설정 (Keep-alive용)
// ==========================
const app = express();
app.get("/", (req, res) => res.send("✅ Trickcal Bot is running"));
app.listen(3000, () => console.log("🌐 Keep-alive 서버 실행됨"));

// ==========================
// 🤖 Discord 클라이언트 설정
// ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN; // Render 환경변수에 토큰 저장
const UPDATE_URL = "https://m.cafe.naver.com/ca-fe/web/cafes/30131231/menus/67";
const COUPON_URL = "https://m.cafe.naver.com/ca-fe/web/cafes/30131231/menus/85";
const NOTICE_CHANNEL_ID = "1435644802052919326"; // ← 실제 Discord 채널 ID로 교체

// ==========================
// 🧩 중복 방지용
// ==========================
let postedTitles = new Set();

// ==========================
// 🧩 Puppeteer 공통 함수
// ==========================
async function fetchLatestPosts(url, limit = 5) {
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

    await page.waitForSelector("a.link_board, a[href*='/articles/']", { timeout: 10000 }).catch(() => {
      console.warn("⚠️ 게시글 렌더링 대기 시간 초과");
    });

    await new Promise((r) => setTimeout(r, 3000));

    const posts = await page.evaluate((limit) => {
      const anchors = Array.from(document.querySelectorAll("a.link_board, a[href*='/articles/']"));
      return anchors.slice(0, limit).map((a) => ({
        title: a.innerText.trim(),
        link: a.href.startsWith("http") ? a.href : `https://m.cafe.naver.com${a.getAttribute("href")}`,
      }));
    }, limit);

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
// 🎟️ 쿠폰 세부 정보 추출 함수
// ==========================
async function parseCouponDetails(link) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(link, { waitUntil: "networkidle2", timeout: 30000 });

    const data = await page.evaluate(() => {
      const html = document.body.innerText;
      const couponRegex = /(쿠폰번호|쿠폰 코드)[:：]?\s*([A-Z0-9\-]+)/i;
      const dateRegex = /(~|까지|유효기간)[:：]?\s*([0-9.월\s\-~]+)/i;

      const couponMatch = html.match(couponRegex);
      const dateMatch = html.match(dateRegex);

      return {
        code: couponMatch ? couponMatch[2].trim() : "❌ 없음",
        date: dateMatch ? dateMatch[2].trim() : "❌ 없음",
      };
    });

    return data;
  } catch (err) {
    console.error("❌ 쿠폰 세부정보 파싱 실패:", err);
    return { code: "❌ 없음", date: "❌ 없음" };
  } finally {
    if (browser) await browser.close();
  }
}

// ==========================
// 🧾 자동 공지 (중복 방지 포함)
// ==========================
async function checkTrickalNotices() {
  const posts = await fetchLatestPosts(UPDATE_URL, 5);
  if (!posts.length) return;

  const channel = await client.channels.fetch(NOTICE_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  for (const post of posts) {
    if (postedTitles.has(post.title)) continue;
    postedTitles.add(post.title);

    const embed = new EmbedBuilder()
      .setTitle("📢 트릭컬 리바이브 업데이트 공지")
      .setDescription(`**${post.title}**\n[게시글 보기](${post.link})`)
      .setColor(0xf6c90e)
      .setFooter({ text: "네이버 카페 자동 감지 시스템", iconURL: "https://i.imgur.com/VHb0nmn.png" })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }
}

// ==========================
// 🎮 명령어 처리
// ==========================
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  // !업데이트
  if (msg.content === "!업데이트") {
    const posts = await fetchLatestPosts(UPDATE_URL, 5);
    if (!posts.length) return msg.reply("❌ 현재 등록된 업데이트 공지가 없습니다.");

    const embed = new EmbedBuilder()
      .setTitle("🆕 최신 트릭컬 업데이트 공지")
      .setColor(0x5cc1ff)
      .setFooter({ text: "자동 수집된 트릭컬 카페 업데이트 게시글" });

    posts.forEach((p, i) => {
      embed.addFields({
        name: `#${i + 1}. ${p.title}`,
        value: `[게시글 보기](${p.link})`,
      });
    });

    await msg.channel.send({ embeds: [embed] });
  }

  // !쿠폰목록
  if (msg.content === "!쿠폰목록") {
    const posts = await fetchLatestPosts(COUPON_URL, 5);
    if (!posts.length) return msg.reply("❌ 현재 사용 가능한 쿠폰 정보가 없습니다.");

    const embed = new EmbedBuilder()
      .setTitle("🎟️ 현재 사용 가능한 쿠폰 목록")
      .setColor(0xf6c90e)
      .setFooter({ text: "쿠폰 정보는 네이버 카페 기준 자동 수집됩니다." });

    for (const [i, p] of posts.entries()) {
      const details = await parseCouponDetails(p.link);
      embed.addFields({
        name: `#${i + 1}. ${p.title}`,
        value: `🔢 **쿠폰번호:** ${details.code}\n⏰ **기간:** ${details.date}\n[게시글 보기](${p.link})`,
      });
    }

    await msg.channel.send({ embeds: [embed] });
  }
});

// ==========================
// 🚀 실행
// ==========================
client.once("clientReady", () => {
  console.log(`✅ ${client.user.tag} 실행됨`);
  checkTrickalNotices(); // 초기 1회 실행
});

setInterval(checkTrickalNotices, 10 * 60 * 1000); // 10분마다 확인
client.login(TOKEN);
