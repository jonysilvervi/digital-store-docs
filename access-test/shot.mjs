// Снимает опубликованную страницу GitHub Pages (не локальный файл) и записывает,
// какая версия gh-pages была на сайте в момент съёмки.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const REPO = "jonysilvervi/digital-store-docs";
const PAGE = "https://jonysilvervi.github.io/digital-store-docs/index.html";

const sha = execSync(`git ls-remote https://github.com/${REPO} refs/heads/gh-pages`).toString().split(/\s/)[0];
const expected = await (await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/index.html`)).text();

// Ждём, пока опубликованная страница совпадёт с файлом последнего коммита gh-pages (до 10 минут).
let live = "", match = false;
for (let i = 0; i < 40 && !match; i++) {
  const r = await fetch(`${PAGE}?nocache=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
  live = await r.text();
  match = r.ok && live === expected;
  if (!match) await new Promise((res) => setTimeout(res, 15000));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${PAGE}?nocache=${Date.now()}`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
const title = await page.title();
await page.screenshot({ path: "access-test/chatgpt-390.png" });
await browser.close();

const info = [
  "Тест доступа: настоящий скриншот опубликованной страницы (снят GitHub Actions, Chromium, Playwright 1.48.2).",
  `Снято (UTC): ${new Date().toISOString()}`,
  `Адрес: ${PAGE}`,
  `Окно: 390x844 CSS px, масштаб 2 (PNG 780x1688)`,
  `Последний коммит gh-pages: ${sha}`,
  `HTML на сайте совпадает с этим коммитом: ${match ? "да" : "НЕТ — снимок может показывать другую версию"}`,
  `Заголовок страницы: ${title}`,
  `Ошибки JavaScript: ${errors.length ? errors.join("; ") : "нет"}`,
].join("\n");
writeFileSync("access-test/info.txt", info + "\n");
console.log(info);
if (!match) process.exitCode = 1;
