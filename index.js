import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { execSync } from "child_process";

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("✅ Discord Bot is running"));
app.listen(3000, () => console.log("🌐 Keep-alive 서버 실행됨"));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const NOTICE_CHANNEL_ID = "1435644802052919326"; // 꼭 바꿔주세요
const TRICKAL_NOTICE_URL = "https://m.cafe.naver.com/ca-fe/web/cafes/trickcal/menus/1/articles";
let postedTitles = new Set();

// 🧩 Puppeteer 크롤링 함수
async function fetchLatestPosts(url) {
  let browser;
  try {
    const basePath = await chromium.executablePath();
    const tempPath = `/tmp/chromium-${Date.now()}`;
    execSync(`cp ${basePath} ${tempPath} && chmod 755 ${tempPath}`);
    console.log("✅ Chromium 임시 복사 및 권한 설정 완료:", tempPath);

    browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-dev-shm-usage"],
      defaultViewport: chromium.defaultViewport,
      executablePath: tempPath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    await page.waitForSelector("a.link_item", { timeout: 10000 }).catch(() => {
      console.warn("⚠️ 게시글 렌더링 대기 시간 초과");
    });

    const posts = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a.link_item"));
      return anchors.slice(0, 10).map((a) => ({
        title: a.innerText.trim(),
        link: a.href.startsWith("http") ? a.href : `https://m.cafe.naver.com${a.getAttribute("href")}`,
      }));
    });

    console.log("📋 발견된 게시물:", posts.length);
    return posts;
  } catch (e) {
    console.error("❌ Puppeteer 크롤링 오류:", e);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// 🧾 트릭컬 공지 자동 게시
async function checkTrickalNotices() {
  const posts = await fetchLatestPosts(TRICKAL_NOTICE_URL);
  if (!posts.length) return;

  const channel = await client.channels.fetch(NOTICE_CHANNEL_ID);
  if (!channel) return;

  for (const post of posts) {
    if (postedTitles.has(post.title)) continue;
    postedTitles.add(post.title);

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

// 🎟️ 명령어
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  console.log("📩 명령어 감지됨:", msg.content);

  if (msg.content === "!쿠폰목록") {
    const posts = await fetchLatestPosts(TRICKAL_NOTICE_URL);
    const couponPosts = posts.filter((p) => p.title.includes("쿠폰"));

    if (!couponPosts.length) {
      return msg.reply("❌ 현재 사용 가능한 쿠폰 정보가 없습니다.");
    }

    const embed = new EmbedBuilder()
      .setTitle("🎟️ 현재 사용 가능한 쿠폰 목록")
      .setColor(0xF6C90E)
      .setFooter({ text: "쿠폰 정보는 네이버 카페 기준 자동 수집됩니다." });

    couponPosts.forEach((p, i) => {
      embed.addFields({ name: `#${i + 1} ${p.title}`, value: `[게시글 보기](${p.link})` });
    });

    await msg.channel.send({ embeds: [embed] });
  }
});

// ✅ 봇 실행
client.once("ready", () => {
  console.log(`✅ ${client.user.tag} 실행됨`);
  checkTrickalNotices();
  setInterval(checkTrickalNotices, 10 * 60 * 1000);
});

client.login(TOKEN);
