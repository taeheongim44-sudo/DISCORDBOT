import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import "dotenv/config";
import puppeteer from "puppeteer";
import googleTTS from "google-tts-api";
import fetch from "node-fetch";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} from "@discordjs/voice";
import { Readable } from "stream";

// --------------------- 기본설정 ---------------------
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("ERROR: .env에 TOKEN 변수가 없습니다.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const PREFIX = "!";
const NOTICE_CHANNEL_NAME = "트릭컬공지";
const UPDATE_URL =
  "https://m.cafe.naver.com/ca-fe/web/cafes/30131231/menus/67";
const COUPON_URL =
  "https://m.cafe.naver.com/ca-fe/web/cafes/30131231/menus/85";

// --------------------- TTS ---------------------
async function streamFromUrl(url) {
  const res = await fetch(url, {
    headers: { Referer: "https://translate.google.com" },
  });
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return Readable.from(buffer);
}

async function playTTSInConnection(voiceChannel, text) {
  try {
    const ttsUrl = googleTTS.getAudioUrl(text, {
      lang: "ko",
      slow: false,
    });
    const stream = await streamFromUrl(ttsUrl);
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });
    const player = createAudioPlayer();
    const resource = createAudioResource(stream);
    player.play(resource);
    connection.subscribe(player);
    player.on(AudioPlayerStatus.Idle, () => connection.destroy());
  } catch (err) {
    console.error("TTS 오류:", err);
  }
}

// --------------------- Puppeteer ---------------------
// ✅ Render 환경에서 동작하도록 launch 옵션 강화 + 로그 추가
async function openBrowser() {
  try {
    const browser = await puppeteer.launch({
      headless: "new", // puppeteer 최신 권장값, 안 되면 true로 바꿔도 OK
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
      // Docker 등에서 직접 chromium 설치했으면 CHROME_PATH 지정
      executablePath: process.env.CHROME_PATH || undefined,
    });
    return browser;
  } catch (err) {
    console.error("Puppeteer 실행 오류 (openBrowser):", err);
    throw err;
  }
}

// ✅ 에러 캐치 + 로그 추가
async function fetchPostsFromMenu(menuUrl) {
  let browser;
  try {
    browser = await openBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"
    );
    await page.goto(menuUrl, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    const posts = await page.$$eval("a", (anchors) => {
      const results = [];
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const text = (a.innerText || "").trim();
        if (!text) continue;
        // 필요하면 여기를 실제 구조에 맞게 튜닝
        if (href.includes("ArticleRead") || href.includes("article")) {
          results.push({ title: text, href });
        }
      }
      return results;
    });

    console.log(
      `[fetchPostsFromMenu] ${menuUrl} 에서 ${posts.length}개 링크 탐색`
    );
    return posts;
  } catch (err) {
    console.error("fetchPostsFromMenu 에러:", err);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchPostPreview(href) {
  let browser;
  try {
    browser = await openBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"
    );
    const url = href.startsWith("http")
      ? href
      : `https://m.cafe.naver.com${href}`;
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    const preview = await page.evaluate(() => {
      const el =
        document.querySelector(".se-main-container") ||
        document.querySelector(".article_text") ||
        document.querySelector(".board_main") ||
        document.querySelector(".content");
      if (el) {
        const text = el.innerText.trim().replace(/\s+/g, " ");
        return text.length > 200 ? text.slice(0, 200) + "..." : text;
      }
      return "내용 미리보기를 불러올 수 없습니다.";
    });

    return preview;
  } catch (err) {
    console.error("fetchPostPreview 에러:", err, "href:", href);
    return "내용 미리보기를 불러올 수 없습니다. (서버 에러)";
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function getLatestPost(type) {
  try {
    const menuUrl = type === "update" ? UPDATE_URL : COUPON_URL;
    const posts = await fetchPostsFromMenu(menuUrl);
    if (!posts || posts.length === 0) {
      console.warn(`[getLatestPost] ${type} 게시글 없음`);
      return null;
    }
    const filtered = posts.filter(
      (p) => !p.title.includes("공지") && !p.title.includes("안내")
    );
    const target = filtered.length > 0 ? filtered[0] : posts[0];
    const preview = await fetchPostPreview(target.href);
    const link = target.href.startsWith("http")
      ? target.href
      : `https://m.cafe.naver.com${target.href}`;
    return { title: target.title, link, preview };
  } catch (err) {
    console.error("getLatestPost 에러:", err);
    return null;
  }
}

async function getCouponList() {
  try {
    const posts = await fetchPostsFromMenu(COUPON_URL);
    if (!posts || posts.length === 0) return [];
    const coupons = [];
    const limit = Math.min(posts.length, 10);
    for (let i = 0; i < limit; i++) {
      const p = posts[i];
      const preview = await fetchPostPreview(p.href);
      const combined = `${p.title}\n${preview}`;

      const codeMatches =
        combined.match(/\b[A-Za-z0-9]{5,20}\b/g) || [];
      const dateMatches =
        combined.match(/\b\d{1,4}[./]\d{1,2}[./]?\d{0,4}\b/g) || [];
      const codesFiltered = codeMatches.filter(
        (c) => /[A-Za-z]/.test(c) || c.length >= 6
      );

      if (codesFiltered.length > 0) {
        coupons.push({
          code: codesFiltered[0],
          expires: dateMatches[0] || "유효기간 없음",
          title: p.title,
          link: p.href.startsWith("http")
            ? p.href
            : `https://m.cafe.naver.com${p.href}`,
        });
      }
    }
    console.log(
      `[getCouponList] 쿠폰 후보 ${coupons.length}개`
    );
    return coupons;
  } catch (err) {
    console.error("getCouponList 에러:", err);
    return [];
  }
}

// --------------------- 스케줄 ---------------------
// ✅ 스케줄 내에서 에러 나도 전체 봇이 죽지 않도록 try/catch
async function doScheduledChecks() {
  try {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const date = now.getDate();

    // 업데이트: 수요일 17시
    if (day === 3 && hour === 17) {
      for (const g of client.guilds.cache.values()) {
        const ch = g.channels.cache.find(
          (c) =>
            c.name === NOTICE_CHANNEL_NAME && c.isTextBased()
        );
        if (!ch) continue;
        const post = await getLatestPost("update");
        if (!post) continue;
        const embed = new EmbedBuilder()
          .setColor(0x00bfff)
          .setTitle("⚙️ 트릭컬 리바이브 업데이트")
          .setDescription(
            `**${post.title}**\n\n${post.preview}`
          )
          .setURL(post.link);
        await ch.send({ embeds: [embed] });
      }
    }

    // 쿠폰: 3일마다 12시
    if (hour === 12 && date % 3 === 0) {
      for (const g of client.guilds.cache.values()) {
        const ch = g.channels.cache.find(
          (c) =>
            c.name === NOTICE_CHANNEL_NAME && c.isTextBased()
        );
        if (!ch) continue;
        const post = await getLatestPost("coupon");
        if (!post) continue;
        const embed = new EmbedBuilder()
          .setColor(0x00ff99)
          .setTitle("🎁 트릭컬 리바이브 쿠폰")
          .setDescription(
            `**${post.title}**\n\n${post.preview}`
          )
          .setURL(post.link);
        await ch.send({ embeds: [embed] });

        const coupons = await getCouponList();
        if (coupons.length > 0) {
          const text = coupons
            .map(
              (c) => `▫️ **${c.code}** — ${c.expires}`
            )
            .join("\n");
          await ch.send({
            embeds: [
              new EmbedBuilder()
                .setTitle("🎫 사용 가능한 쿠폰")
                .setDescription(text)
                .setColor(0xffcc00),
            ],
          });
        }
      }
    }
  } catch (err) {
    console.error("doScheduledChecks 에러:", err);
  }
}

// --------------------- 명령어 ---------------------
client.on("messageCreate", async (m) => {
  if (m.author.bot) return;
  const content = m.content.trim();

  // TTS
  if (m.channel.name === "tts" && !content.startsWith("~")) {
    const vc = m.member?.voice?.channel;
    if (vc) playTTSInConnection(vc, content);
  }

  if (!content.startsWith(PREFIX)) return;
  const [cmd, arg] = content.slice(1).split(" ");

  if (cmd === "공지") {
    const type = arg === "쿠폰" ? "coupon" : "update";
    const post = await getLatestPost(type);
    if (!post) return m.reply("불러올 수 없습니다.");
    const embed = new EmbedBuilder()
      .setColor(type === "update" ? 0x00bfff : 0x00ff99)
      .setTitle(
        type === "update" ? "📢 최신 업데이트" : "🎁 최신 쿠폰"
      )
      .setDescription(
        `**${post.title}**\n\n${post.preview}`
      )
      .setURL(post.link);
    return m.reply({ embeds: [embed] });
  }

  if (cmd === "쿠폰목록") {
    const coupons = await getCouponList();
    if (coupons.length === 0)
      return m.reply("쿠폰을 불러올 수 없습니다.");
    const embed = new EmbedBuilder()
      .setTitle("🎫 사용 가능한 쿠폰 목록")
      .setDescription(
        coupons
          .map(
            (c) =>
              `**${c.code}** — ${c.expires}\n${c.title}`
          )
          .join("\n\n")
      )
      .setColor(0xffcc00);
    return m.reply({ embeds: [embed] });
  }

  if (cmd === "명령어") {
    const embed = new EmbedBuilder()
      .setTitle("📜 사용 가능한 명령어 목록")
      .setDescription(
        [
          "`!공지 업데이트` - 최신 업데이트 공지 불러오기",
          "`!공지 쿠폰` - 최신 쿠폰 공지 불러오기",
          "`!쿠폰목록` - 사용 가능한 쿠폰 목록 보기",
          "`!명령어` - 이 도움말 보기",
        ].join("\n")
      )
      .setColor(0x00ffff);
    return m.reply({ embeds: [embed] });
  }
});

// --------------------- 새 멤버 환영 ---------------------
client.on("guildMemberAdd", async (member) => {
  const ch =
    member.guild.systemChannel ||
    member.guild.channels.cache.find(
      (c) => c.name === "일반"
    );
  if (ch && ch.isTextBased()) {
    const embed = new EmbedBuilder()
      .setColor(0x00ffcc)
      .setTitle(
        "안녕하세요!! 버터의옐로카드에 오신걸 환영합니다!! !명령어로 시작해보세요"
      )
      .setDescription(
        `환영합니다, ${member.user.username}님! 즐거운 시간 되세요 🎉`
      );
    await ch.send({ embeds: [embed] });
  }
});

// --------------------- Ready ---------------------
client.once("ready", () => {
  console.log(`✅ ${client.user.tag} 실행됨`);
  // 1시간마다 체크
  setInterval(doScheduledChecks, 1000 * 60 * 60);
});

client.login(TOKEN);
