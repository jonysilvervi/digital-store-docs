// Регрессионные тесты подтверждённых ошибок (аудит 21.10.2026) и охранные тесты.
// Правило (реестр В-07): тест сначала падает на версии с ошибкой (942e639), затем проходит после исправления
// без изменения самого теста. Тексты дословно не закрепляются: проверяется смысл по данным и словарю.
// Селекторы (#offers, .offer, #terms, #qtySec, #bar) — крючки текущего серого макета (уровень С).
//
// Запуск: BASE_URL=http://127.0.0.1:8099/index.html OUT_DIR=... node qa/regress.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const BASE = process.env.BASE_URL;
const OUT = process.env.OUT_DIR || "qa/regress-out";
const LABEL = process.env.LABEL || "local";
rmSync(OUT, { recursive: true, force: true }); mkdirSync(join(OUT, "shots"), { recursive: true });

const norm = (s) => String(s ?? "").replace(/[\s ]+/g, " ").trim();
const eur = (n) => { const c = Math.round(n * 100); return `${Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${String(c % 100).padStart(2, "0")} €`; };
// «N мес.» или «N месяц/месяца/месяцев» — допустимые формы по словарю (Г-02)
const termRe = (n) => new RegExp(`(^|[^0-9])${n}\\s*(мес\\.?|месяц(а|ев)?)(?![а-я])`, "i");

/* ---------- синтетические каталоги (подставляются в загружаемую страницу) ---------- */
const offer = (id, t, kind, name, terms, extra = {}) => ({ id, t, kind, name, fact: name + " — описание", max: 3, unit: ["место", "места", "мест", false], terms, req: [], limits: [], ...extra });
const FIX = {
  cheapestNotFirst: { product: { id: "x", name: "Тест" }, tariffs: ["Plus"], offers: [
    offer("a", "Plus", "own", "Способ А", { 1: { price: 20, st: "ok" }, 3: { price: 15, st: "ok" } }),
    offer("b", "Plus", "sep", "Способ Б", { 1: { price: 30, st: "ok" } }) ] },
  stockOne: { product: { id: "x", name: "Тест" }, tariffs: ["Plus"], offers: [
    offer("s", "Plus", "sep", "Способ С", { 1: { price: 10, st: "low", left: 1 } }, { max: 3 }),
    offer("o", "Plus", "own", "Способ О", { 1: { price: 12, st: "ok" } }) ] },
  fiveTariffs: { product: { id: "x", name: "Тест" }, tariffs: ["T1", "T2", "T3", "T4", "T5"], offers: ["T1", "T2", "T3", "T4", "T5"].map((t, k) =>
    offer("o" + k, t, "own", "Способ " + t, { 1: { price: 5 + k, st: "ok" } })) },
};
async function withCatalog(page, fixture) {
  await page.route((u) => u.href.split("?")[0] === BASE.split("?")[0], async (route) => {
    const r = await route.fetch(); let body = await r.text();
    body = body.replace(/(<script type="application\/json" id="catalog">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(fixture)}$2`);
    await route.fulfill({ response: r, body, headers: { ...r.headers(), "content-type": "text/html; charset=utf-8" } });
  });
}

/* ---------- инструменты ---------- */
const results = [];
let browser;
async function newPage(w = 390, h = 844, dpr = 1) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(4000);
  page.__errors = []; page.on("pageerror", (e) => page.__errors.push(String(e)));
  return page;
}
const open = (page, q) => page.goto(BASE + "?demo" + q);
const vis = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const txt = async (page, sel) => norm(await page.locator(sel).first().innerText().catch(() => ""));
const pressedTerm = (page) => page.evaluate(() => { const b = document.querySelector('#terms button[aria-pressed="true"]'); return b ? +b.dataset.term : null; });
const qty = async (page) => ((await vis(page, "#qtySec")) ? Number(await txt(page, "#qv")) : null);
const activeKey = (page) => page.evaluate(() => { const a = document.activeElement; if (!a || a === document.body) return "BODY";
  return a.dataset.tariff ? "tariff:" + a.dataset.tariff : a.dataset.offerId ? "offer:" + a.dataset.offerId : a.dataset.term ? "term:" + a.dataset.term : a.id ? "#" + a.id : a.tagName; });

async function test(id, reqs, title, kind, fn) {
  const page = await newPage();
  let ok = false, detail = "", shot = null;
  try { const r = await fn(page); ok = r.ok; detail = r.detail || ""; }
  catch (e) { ok = false; detail = "исключение: " + String(e.message || e).split("\n")[0]; }
  if (page.__errors.length) { ok = false; detail += " · ошибки JS: " + page.__errors.join("; "); }
  if (!ok) { shot = `shots/${id}.png`; await page.screenshot({ path: join(OUT, shot) }).catch(() => (shot = null)); }
  results.push({ id, reqs, title, kind, ok, detail: norm(detail).slice(0, 500), shot });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${title} :: ${norm(detail).slice(0, 200)}`);
  await page.context().close();
}

/* ---------- регрессионные тесты (должны падать на 942e639) ---------- */
async function main() {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  await test("R-01", ["А7-01", "А7-02"], "Способ A → недоступный B → A: срок и количество восстанавливаются", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=3&q=2");
    const before = { term: await pressedTerm(p), q: await qty(p) };
    await p.click('.offer[data-offer-id="plus-shared"]');
    await p.click('.offer[data-offer-id="plus-own"]');
    const after = { term: await pressedTerm(p), q: await qty(p) };
    return { ok: after.term === 3 && after.q === 2, detail: `до: срок ${before.term}, кол-во ${before.q}; после возврата: срок ${after.term}, кол-во ${after.q}` };
  });

  await test("R-02", ["А7-01", "А7-02"], "Срок 1 → недоступный срок 3 → 1: количество восстанавливается", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-shared&term=1&q=3");
    await p.click('#terms button[data-term="3"]');
    await p.click('#terms button[data-term="1"]');
    const q = await qty(p);
    return { ok: q === 3, detail: `после возврата к 1 мес. количество ${q}, ожидалось 3` };
  });

  await test("R-04", ["А10-05"], "Клавиатура: фокус остаётся на нажатом элементе", "регрессия", async (p) => {
    const lost = [];
    const check = async (sel, key, expect) => { await p.focus(sel); await p.keyboard.press(key); const a = await activeKey(p); if (a !== expect) lost.push(`${expect} → ${a}`); };
    await open(p, "&t=Plus");
    await check('#tariffs button[data-tariff="Pro"]', "Enter", "tariff:Pro");
    await open(p, "&t=Plus");
    await check('.offer[data-offer-id="plus-own"]', "Enter", "offer:plus-own");
    await check('#terms button[data-term="3"]', "Enter", "term:3");
    await check("#qp", "Enter", "#qp");            // 1 → 2
    await check("#qm", "Enter", "#qm");            // 2 → 1: «−» достигает минимума и не должна терять фокус
    return { ok: !lost.length, detail: lost.length ? "фокус потерян: " + lost.join("; ") : "" };
  });

  await test("R-05", ["Г-09", "А10-05"], "Способы доступа — одна точка Tab и стрелки", "регрессия", async (p) => {
    await open(p, "&t=Plus");
    const stops = await p.evaluate(() => [...document.querySelectorAll("#offers [tabindex], #offers button, #offers a")].filter((e) => e.tabIndex >= 0 && e.offsetParent).length);
    await p.focus('.offer[data-offer-id="plus-own"]'); await p.keyboard.press("Space");
    await p.keyboard.press("ArrowDown");
    const sel = await p.evaluate(() => document.querySelector('.offer[aria-checked="true"]')?.dataset.offerId || null);
    const foc = await activeKey(p);
    const ok = stops === 1 && sel === "plus-sep" && foc === "offer:plus-sep";
    return { ok, detail: `точек Tab в группе: ${stops}; после стрелки вниз выбран: ${sel}, фокус: ${foc}` };
  });

  await test("R-06", ["А10-05"], "Рамка фокуса строки способа видна со всех четырёх сторон", "регрессия", async (p) => {
    await p.setViewportSize({ width: 390, height: 1200 });
    await open(p, "&t=Plus");
    const row = '.offer[data-offer-id="plus-sep"]';
    const bb = await p.locator(row).boundingBox();
    const clip = { x: Math.max(0, bb.x - 8), y: bb.y - 8, width: Math.min(390, bb.width + 16) - Math.max(0, bb.x - 8) + Math.max(0, bb.x - 8), height: bb.height + 16 };
    clip.width = Math.min(390 - clip.x, bb.width + 16);
    const a = PNG.sync.read(await p.screenshot({ clip }));
    await p.focus(row); await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Tab"); // фокус с клавиатуры → :focus-visible
    if ((await activeKey(p)) !== "offer:plus-sep") await p.focus(row);
    const b = PNG.sync.read(await p.screenshot({ clip }));
    const ox = bb.x - clip.x, oy = bb.y - clip.y, W = a.width, H = a.height;
    const changed = (x0, y0, x1, y1) => { let n = 0, c = 0; for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { const i = (y * W + x) * 4; n++; if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 40) c++; } return n ? c / n : 0; };
    const band = 6; // зона рамки: от 3 px внутри до 5 px снаружи края строки
    const sides = {
      верх: changed(ox + 10, oy - 5, ox + bb.width - 10, oy + 3),
      низ: changed(ox + 10, oy + bb.height - 3, ox + bb.width - 10, oy + bb.height + 5),
      лево: changed(ox - 5, oy + 10, ox + 3, oy + bb.height - 10),
      право: changed(ox + bb.width - 3, oy + 10, ox + bb.width + 5, oy + bb.height - 10),
    };
    const weak = Object.entries(sides).filter(([, v]) => v < 0.05).map(([k]) => k);
    return { ok: !weak.length, detail: `доля изменившихся пикселей у краёв: ${Object.entries(sides).map(([k, v]) => k + " " + (v * 100).toFixed(0) + "%").join(", ")}${weak.length ? "; рамки не видно: " + weak.join(", ") : ""}` };
  });

  await test("R-07", ["А1-04"], "В области презентации нет цены", "регрессия", async (p) => {
    await open(p, "");
    const t = await txt(p, ".hero");
    return { ok: !/\d\s*€|€\s*\d/.test(t), detail: `текст области: «${t}»` };
  });

  await test("R-08", ["А3-02"], "Начальная цена способа указывает фактический срок (демо-данные)", "регрессия", async (p) => {
    await open(p, "&t=Plus");
    const t = await txt(p, '.offer[data-offer-id="plus-own"] .op');
    return { ok: t.includes(norm(eur(14.9))) && termRe(1).test(t), detail: `цена способа: «${t}», ожидалось 14,90 € с указанием срока 1 мес.` };
  });

  await test("R-08b", ["А3-02", "А11-03"], "Самый дешёвый срок — не первый: указан именно он", "регрессия", async (p) => {
    await withCatalog(p, FIX.cheapestNotFirst); await open(p, "&t=Plus");
    const t = await txt(p, '.offer[data-offer-id="a"] .op');
    return { ok: t.includes(norm(eur(15))) && termRe(3).test(t) && !termRe(1).test(t), detail: `цена способа: «${t}», ожидалось 15,00 € за 3 мес.` };
  });

  await test("R-09", ["А3-05", "А8-05"], "Месячный эквивалент всего заказа в итоге (3 мес. × 2 шт.)", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=3&q=2");
    const bar = await txt(p, "#sum");
    const okTotal = bar.includes(norm(eur(84))), okMonthly = bar.includes(norm(eur(28))) && /мес/.test(bar);
    return { ok: okTotal && okMonthly, detail: `итог: «${bar}»; ожидалось 84,00 € и ≈ 28,00 € в месяц за весь заказ` };
  });

  await test("R-10a", ["А4-07"], "Пока «+» доступна, подписи об ограничении нет", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=1");
    const plusOn = !(await p.isDisabled("#qp"));
    const extra = await p.evaluate(() => { const s = document.getElementById("qtySec"); if (!s) return ""; const c = s.cloneNode(true);
      c.querySelectorAll("h2, .step, [hidden]").forEach((e) => e.remove()); return c.innerText.trim(); });
    return { ok: plusOn && !extra, detail: `«+» доступна: ${plusOn}; лишний текст у счётчика: «${norm(extra)}»` };
  });

  await test("G-05", ["А4-07"], "На пределе — объяснение; для наличия и для лимита заказа оно разное", "охранный", async (p) => {
    const msg = async () => p.evaluate(() => { const s = document.getElementById("qtySec"); if (!s || s.hidden) return ""; const c = s.cloneNode(true);
      c.querySelectorAll("h2, .step, [hidden]").forEach((e) => e.remove()); return c.innerText.trim(); });
    await open(p, "&t=Plus&o=plus-own&term=1&q=3"); const limitMsg = norm(await msg()); const limDis = await p.isDisabled("#qp");
    await open(p, "&t=Plus&o=plus-sep&term=1&q=2"); const stockMsg = norm(await msg()); const stDis = await p.isDisabled("#qp");
    const ok = limDis && stDis && limitMsg && stockMsg && limitMsg !== stockMsg && /3/.test(limitMsg) && /2/.test(stockMsg);
    return { ok, detail: `лимит заказа (3): «${limitMsg}»; наличие (2): «${stockMsg}»` };
  });

  await test("R-10c", ["А4-07", "А11-01"], "Наличие 1 при лимите 3: ограничение объяснено у счётчика", "регрессия", async (p) => {
    await withCatalog(p, FIX.stockOne); await open(p, "&t=Plus&o=s&term=1");
    const shown = await vis(p, "#qtySec");
    const t = shown ? await txt(p, "#qtySec") : "";
    return { ok: shown && /1/.test(t.replace(/^\D*/, "")) && t.length > 0, detail: shown ? `у счётчика: «${t}»` : "блок количества скрыт — покупатель не узнает, почему нельзя взять больше" };
  });

  await test("R-11", ["А11-06"], "Склонение числа тарифов (5 тарифов)", "регрессия", async (p) => {
    await withCatalog(p, FIX.fiveTariffs); await open(p, "");
    const t = await txt(p, "body"); const m = t.match(/(?<![0-9])5\s+тариф[а-я]*/);
    return { ok: !m || m[0].endsWith("тарифов"), detail: m ? `на странице: «${m[0]}»` : "число тарифов не показывается" };
  });

  await test("R-12", ["Г-06"], "Недоступный вариант: корзины рядом с «Уведомить» нет", "регрессия", async (p) => {
    await open(p, "&t=Pro&o=pro-sep&term=1");
    const notify = await vis(p, "#notifyBar"), cart = await vis(p, "#toCart");
    return { ok: notify && !cart, detail: `«Уведомить» видна: ${notify}; корзина видна: ${cart}` };
  });

  await test("R-13", ["Г-04"], "Единственный способ доступа в тарифе выбран сразу", "регрессия", async (p) => {
    await open(p, "&t=Go");
    const sel = await p.locator('.offer[aria-checked="true"]').count(), terms = await vis(p, "#termSec"), buy = await p.isEnabled("#buyNow").catch(() => false);
    return { ok: sel === 1 && terms && buy, detail: `выбрано способов: ${sel}; сроки видны: ${terms}; покупка доступна: ${buy}` };
  });

  await test("R-14", ["Г-05", "А6-01"], "Приватность общего аккаунта заметна до выбора способа", "регрессия", async (p) => {
    await open(p, "&t=Plus");
    const t = await txt(p, '.offer[data-offer-id="plus-shared"]');
    const ok = /(чат|переписк|данн|истори)/i.test(t) && /(вид(ят|ны|еть)|доступ)/i.test(t);
    return { ok, detail: `строка до выбора: «${t}»` };
  });

  /* ---------- охранные тесты (уже выполняются; должны оставаться зелёными) ---------- */
  await test("G-01", ["А7-03"], "Тариф A → B → A: сброс с пояснением, прежний выбор не восстанавливается", "охранный", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=3&q=2");
    await p.click('#tariffs button[data-tariff="Pro"]');
    const n1 = (await vis(p, "#notice")) ? await txt(p, "#notice") : "";
    await p.click('#tariffs button[data-tariff="Plus"]');
    const sel = await p.locator('.offer[aria-checked="true"]').count();
    return { ok: !!n1 && sel === 0, detail: `пояснение при смене: «${n1}»; выбрано способов после возврата: ${sel}` };
  });
  await test("G-02", ["А3-03"], "Все сроки способа недоступны — статус без цены", "охранный", async (p) => {
    await open(p, "&t=Pro"); const t = await txt(p, '.offer[data-offer-id="pro-sep"] .op');
    return { ok: !!t && !/€/.test(t), detail: `«${t}»` };
  });
  await test("G-03", ["А2-04"], "Показаны все способы тарифа, включая недоступные", "охранный", async (p) => {
    await open(p, "&t=Pro"); const n = await p.locator(".offer").count();
    return { ok: n === 3, detail: `способов: ${n} из 3` };
  });
  await test("G-04", ["А3-04"], "Сумма = цена × количество", "охранный", async (p) => {
    await open(p, "&t=Business&o=biz-team&term=1&q=7"); const b = await txt(p, "#sum b");
    return { ok: b === norm(eur(154)), detail: `«${b}», ожидалось 154,00 €` };
  });

  await browser.close();
  const reg = results.filter((r) => r.kind === "регрессия"), grd = results.filter((r) => r.kind === "охранный");
  const L = [`# Регрессионные тесты — прогон на ${LABEL}`, "", `Время (UTC): ${new Date().toISOString().replace("T", " ").slice(0, 19)}`, `Страница: ${BASE}`, "",
    `- Регрессионных: ${reg.length}, прошло ${reg.filter((r) => r.ok).length}, упало ${reg.filter((r) => !r.ok).length}`,
    `- Охранных: ${grd.length}, прошло ${grd.filter((r) => r.ok).length}, упало ${grd.filter((r) => !r.ok).length}`, ""];
  for (const r of results) L.push(`- **${r.ok ? "ПРОШЁЛ" : "УПАЛ"}** \`${r.id}\` (${r.kind}; ${r.reqs.join(", ")}) ${r.title}${r.detail ? ` — ${r.detail}` : ""}${r.shot ? ` · [снимок](${r.shot})` : ""}`);
  writeFileSync(join(OUT, "report.md"), L.join("\n") + "\n");
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ label: LABEL, base: BASE, results }, null, 1));
}
main().catch((e) => { console.error(e); process.exitCode = 2; });
