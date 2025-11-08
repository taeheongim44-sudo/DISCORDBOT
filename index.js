import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import "dotenv/config";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { execSync } from "child_process";
import fs from "fs";

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

// --------------------- Puppeteer 실행 ---------------------
async function launchBrowser() {
  const originalPath = await chromium.executablePath();
  const tempPath = `/tmp/chromium-${Date.now()}`;
  try {
    fs.copyFileSync(originalPath, tempPath);
    fs.chmodSync(tempPath, 0o755);
    console.log(`✅ Chromium 임시 복사 및 권한 설정 완료: ${tempPath}`);
  } catch (err) {
    console.warn("⚠️ Chromium 복사 실패:", err);
  }

  return puppeteer.launch({
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--no-zygote",
    ],
    defaultViewport: chromium.defaultViewport,
    executablePath: tempPath,
    headless: chromium.headless,
  });
}

// --------------------- 크롤러 ---------------------
async function fetchLatestPosts(url) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));

    const posts = await page.evaluate(() => {
      // ✅ 현재 모바일 카페 구조 대응
      const links = Array.from(document.querySelectorAll("a.link_board, a[href*='/articles/']"));
      return links.slice(0, 5).map((el) => ({
        title: el.innerText.trim(),
        link: el.href.startsWith("http")
          ? el.href
          : `https://m.cafe.naver.com${el.getAttribute("href")}`,
      }));
    });

    console.log("📋 발견된 게시물:", posts.length);
    return posts;
  } catch (err) {
    console.error("❌ Puppeteer 크롤링 오류:", err);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// --------------------- 새글 자동 감지 ---------------------
let lastPostedTitles = new Set();

async function checkNewPosts() {
  const updatePosts = await fetchLatestPosts(UPDATE_URL);
  const couponPosts = await fetchLatestPosts(COUPON_URL);

  const channel = client.channels.cache.find(
    (ch) => ch.name === NOTICE_CHANNEL_NAME
  );
  if (!channel) return;

  for (const post of [...updatePosts, ...couponPosts]) {
    if (lastPostedTitles.has(post.title)) continue; // ✅ 중복 방지
    lastPostedTitles.add(post.title);

    const isCoupon = post.link.includes("menus/85");
    const embed = new EmbedBuilder()
      .setColor(isCoupon ? 0x00ff99 : 0x00bfff)
      .setTitle(isCoupon ? "🎁 새 쿠폰 공지" : "📢 새 업데이트 공지")
      .setDescription(`**[${post.title}](${post.link})**`)
      .setTimestamp();

    channel.send({ embeds: [embed] });
  }
}

setInterval(checkNewPosts, 5 * 60 * 1000);

// --------------------- 명령어 ---------------------
client.on("messageCreate", async (m) => {
  if (m.author.bot) return;
  const content = m.content.trim();
  if (!content.startsWith(PREFIX)) return;

  const [cmd, arg] = content.slice(1).split(" ");

  // 📢 공지 명령어
  if (cmd === "공지") {
    const isCoupon = arg === "쿠폰";
    const url = isCoupon ? COUPON_URL : UPDATE_URL;
    const posts = await fetchLatestPosts(url);
    if (posts.length === 0) return m.reply("불러올 수 없습니다 😢");

    const embed = new EmbedBuilder()
      .setColor(isCoupon ? 0x00ff99 : 0x00bfff)
      .setTitle(isCoupon ? "🎁 최신 쿠폰 공지" : "📢 최신 업데이트 공지")
      .setDescription(
        posts.map((p, i) => `**${i + 1}. [${p.title}](${p.link})**`).join("\n\n")
      )
      .setFooter({ text: "네이버 카페 게시글 기준 자동 수집" });
    return m.reply({ embeds: [embed] });
  }

  // 🧾 명령어 목록
  if (cmd === "명령어") {
    const embed = new EmbedBuilder()
      .setTitle("📜 사용 가능한 명령어")
      .setDescription(
        [
          "`!공지 업데이트` - 최신 업데이트 공지 보기",
          "`!공지 쿠폰` - 최신 쿠폰 공지 보기",
          "`!쿠폰목록` - 쿠폰 번호와 기간 확인",
          "`!명령어` - 명령어 목록 보기",
        ].join("\n")
      )
      .setColor(0x00ffff);
    return m.reply({ embeds: [embed] });
  }

  // 🎟️ 쿠폰목록
  if (cmd === "쿠폰목록") {
    await m.reply("🔍 쿠폰 정보를 불러오는 중입니다... 잠시만 기다려주세요.");

    const posts = await fetchLatestPosts(COUPON_URL);
    if (posts.length === 0) return m.reply("쿠폰 게시글을 불러올 수 없습니다 😢");

    const couponDetails = [];

    for (const post of posts) {
      try {
        const browser = await launchBrowser();
        const page = await browser.newPage();
        await page.goto(post.link, { waitUntil: "networkidle2", timeout: 60000 });

        const text = await page.evaluate(() => document.body.innerText);
        await browser.close();

        const codeMatch = text.match(/\b[A-Z0-9]{8,20}\b/g);
        const dateMatch = text.match(
          /(\d{4}[.-]\d{1,2}[.-]\d{1,2}|~\s*\d{1,2}[./]\d{1,2}|\d{2}[.]\d{1,2}[.]\d{1,2}|~\s*\d{1,2}월?\s*\d{1,2}일?)/g
        );

        couponDetails.push({
          title: post.title,
          link: post.link,
          code: codeMatch ? codeMatch.join(", ") : "❌ 쿠폰번호 없음",
          period: dateMatch ? dateMatch.join(", ") : "❌ 유효기간 없음",
        });
      } catch (err) {
        console.error("❌ 쿠폰 본문 분석 오류:", err);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0xffc107)
      .setTitle("🎟️ 현재 사용 가능한 쿠폰 목록")
      .setDescription(
        couponDetails
          .map(
            (c, i) =>
              `**${i + 1}. [${c.title}](${c.link})**\n` +
              `> 🔢 쿠폰번호: \`${c.code}\`\n> ⏰ 기간: ${c.period}`
          )
          .join("\n\n──────────────\n\n")
      )
      .setFooter({
        text: "※ 쿠폰 정보는 네이버 카페 게시글을 기준으로 자동 수집됩니다.",
      });

    return m.reply({ embeds: [embed] });
  }
});

// --------------------- Ready ---------------------
client.once("ready", () => {
  console.log(`✅ ${client.user.tag} 실행됨`);
  checkNewPosts();
});

client.login(TOKEN);
