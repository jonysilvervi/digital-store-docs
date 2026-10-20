// Снимки по типам состояний, сравнение с предыдущей проверкой и эталоном, сводные листы.
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { stateClasses, U, go } from "./oracle.mjs";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");

// Быстрый режим — небольшой обязательный набор; полный — все классы состояний.
const FAST = ["none", "selected-qty2", "out", "sheet-cond"];

export function shotPlan(cat, mode) {
  const cls = stateClasses(cat);
  const plan = [];
  const use = mode === "full" ? cls : cls.filter((c) => FAST.includes(c.name));
  for (const c of use) plan.push({ ...c, w: 390, kind: "viewport" });
  const desk = mode === "full" ? cls : cls.filter((c) => c.name === "selected-qty2");
  for (const c of desk) plan.push({ ...c, w: 1280, kind: "viewport" });
  if (mode === "full") {
    for (const c of cls.filter((c) => ["none", "max-total", "longest-name", "sheet-cond"].includes(c.name))) plan.push({ ...c, w: 320, kind: "viewport" });
    for (const c of cls.filter((c) => ["none", "selected-qty2"].includes(c.name))) plan.push({ ...c, w: 390, kind: "fullpage" });
    for (const c of cls.filter((c) => ["selected-qty2", "sheet-cond"].includes(c.name))) plan.push({ ...c, w: 390, kind: "viewport", dark: true });
  }
  return plan.map((p) => ({ ...p, file: `${p.name}--${p.w}${p.kind === "fullpage" ? "--full" : ""}${p.dark ? "--dark" : ""}.png` }));
}

export async function takeShots(browser, base, plan, outDir) {
  mkdirSync(join(outDir, "shots"), { recursive: true });
  const groups = {};
  for (const p of plan) (groups[`${p.w}|${!!p.dark}`] ||= []).push(p);
  for (const key of Object.keys(groups)) {
    const [w, dark] = key.split("|");
    const width = +w, desktop = width >= 1000;
    const ctx = await browser.newContext({ viewport: { width, height: desktop ? 900 : 740 }, deviceScaleFactor: desktop ? 1 : 2, reducedMotion: "reduce", colorScheme: dark === "true" ? "dark" : "light" });
    const page = await ctx.newPage(); page.setDefaultTimeout(6000);
    for (const p of groups[key]) {
      await go(page, base, p.url);
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await page.addStyleTag({ content: "*{caret-color:transparent!important} #openDemo{visibility:hidden!important}" }); // снимок как у покупателя
      if (p.kind !== "fullpage") await page.evaluate(() => { const h = document.getElementById("hT"); if (h) window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 12); }); // в кадре — выбор и панель
      const opt = { path: join(outDir, "shots", p.file) };
      if (p.kind === "fullpage") { opt.fullPage = true; }
      else if (desktop) { opt.clip = { x: (width - 600) / 2, y: 0, width: 600, height: 900 }; }
      await page.screenshot(opt);
    }
    await ctx.close();
  }
}

// Сравнение: отличие пикселей — это информация, а не ошибка. Ошибки находят правила отображения.
export function compare(plan, outDir, refDir, label) {
  const res = [];
  if (!refDir || !existsSync(refDir)) return { available: false, items: res };
  mkdirSync(join(outDir, "diff"), { recursive: true });
  for (const p of plan) {
    const a = join(refDir, p.file), b = join(outDir, "shots", p.file);
    if (!existsSync(a)) { res.push({ file: p.file, title: p.title, status: "new" }); continue; }
    const A = PNG.sync.read(readFileSync(a)), B = PNG.sync.read(readFileSync(b));
    if (A.width !== B.width || A.height !== B.height) { res.push({ file: p.file, title: p.title, status: "size", detail: `${A.width}×${A.height} → ${B.width}×${B.height}` }); continue; }
    const D = new PNG({ width: A.width, height: A.height });
    const n = pixelmatch(A.data, B.data, D.data, A.width, A.height, { threshold: 0.1, includeAA: false });
    const ratio = n / (A.width * A.height);
    if (ratio > 0.001) {
      const df = `${label}--${p.file}`;
      writeFileSync(join(outDir, "diff", df), PNG.sync.write(D));
      res.push({ file: p.file, title: p.title, status: "changed", ratio, diff: `diff/${df}` });
    } else res.push({ file: p.file, title: p.title, status: "same", ratio });
  }
  return { available: true, items: res };
}

// Сводные листы: не больше 6 экранов, чтобы текст оставался читаемым.
export async function contactSheets(browser, plan, outDir) {
  mkdirSync(join(outDir, "sheets"), { recursive: true });
  const made = [];
  const groups = [
    ["mobile", "Телефон 390 px", plan.filter((p) => p.w === 390 && p.kind === "viewport" && !p.dark), 3, 390],
    ["mobile-320", "Телефон 320 px", plan.filter((p) => p.w === 320), 3, 320],
    ["dark", "Тёмная тема, 390 px", plan.filter((p) => p.dark), 3, 390],
    ["desktop", "Компьютер 1280 px (центральная колонка)", plan.filter((p) => p.w === 1280), 2, 600],
  ];
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const [key, title, items, cols, iw] of groups) {
    for (let i = 0, n = 1; i < items.length; i += 6, n++) {
      const chunk = items.slice(i, i + 6);
      const html = `<html><body style="margin:0;padding:16px;background:#fff;font:15px system-ui,sans-serif;color:#111">
        <div style="font-weight:600;margin-bottom:10px">${title} · лист ${n}</div>
        <div style="display:grid;grid-template-columns:repeat(${cols},${iw}px);gap:16px">
        ${chunk.map((p) => `<figure style="margin:0"><figcaption style="margin-bottom:6px;font-size:14px"><b>${p.title}</b><br><span style="color:#555">${p.file}</span></figcaption>
          <img src="file://${join(outDir, "shots", p.file)}" style="width:${iw}px;border:1px solid #bbb;display:block"></figure>`).join("")}
        </div></body></html>`;
      const tmp = join(outDir, "sheets", `_tmp.html`);
      writeFileSync(tmp, html);
      await page.goto("file://" + tmp); await page.waitForLoadState("load");
      const f = `sheets/${key}-${n}.png`;
      await page.screenshot({ path: join(outDir, f), fullPage: true });
      made.push({ file: f, title: `${title} · лист ${n}`, count: chunk.length });
      rmSync(tmp, { force: true });
    }
  }
  await ctx.close();
  return made;
}

// Снимки ошибок: проблемный элемент обведён рамкой.
export async function failureShots(browser, failures, outDir, limit = 12) {
  mkdirSync(join(outDir, "failures"), { recursive: true });
  const out = []; const seen = new Set();
  for (const f of failures) {
    if (out.length >= limit) break;
    if (!f.url) continue;
    const key = `${f.url}|${f.width}|${f.sel}`; if (seen.has(key)) { f.shot = [...out].reverse().find((x) => x.key === key)?.file; continue; }
    seen.add(key);
    const ctx = await browser.newContext({ viewport: { width: f.width, height: f.width < 1000 ? 740 : 900 }, deviceScaleFactor: f.width < 1000 ? 2 : 1, reducedMotion: "reduce" });
    const page = await ctx.newPage(); page.setDefaultTimeout(5000);
    try {
      await page.goto(f.url);
      if (f.sel) await page.evaluate((s) => { const el = document.querySelector(s); if (el) { el.style.outline = "3px solid #e00000"; el.style.outlineOffset = "2px"; el.scrollIntoView({ block: "center" }); } }, f.sel);
      const file = `failures/${String(out.length + 1).padStart(2, "0")}.png`;
      await page.screenshot({ path: join(outDir, file) });
      out.push({ key, file }); f.shot = file;
    } catch (e) { f.shotError = String(e).slice(0, 120); }
    await ctx.close();
  }
  return out.length;
}
