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
  tariffs: (n) => { const ts = Array.from({ length: n }, (_, k) => "T" + (k + 1)); return { product: { id: "x", name: "Тест" }, tariffs: ts,
    offers: ts.map((t, k) => offer("o" + k, t, "own", "Способ " + t, { 1: { price: 5 + k, st: "ok" } })) }; },
  nearestTerm: { product: { id: "x", name: "Тест" }, tariffs: ["Plus"], offers: [
    offer("a", "Plus", "own", "Способ А", { 2: { price: 8, st: "ok" }, 12: { price: 40, st: "ok" } }),
    offer("b", "Plus", "sep", "Способ Б", { 1: { price: 5, st: "ok" }, 3: { price: 12, st: "ok" } }),
    offer("c", "Plus", "shared", "Способ В", { 3: { price: 10, st: "ok" }, 6: { price: 18, st: "ok" } }) ] },
  manyUnits: { product: { id: "x", name: "Тест" }, tariffs: ["Plus"], offers: [
    offer("u", "Plus", "team", "Места", { 1: { price: 2, st: "ok" } }, { max: 25, req: [{ text: "почта участника", scope: "unit" }] }) ] },
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
  if (process.env.ONLY && !process.env.ONLY.split(",").includes(id)) return; // выборочный запуск: ONLY=R-24,R-01
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

  await test("R-04", ["А10-05"], "Клавиатура: действие выполнено, фокус остаётся на нажатом элементе и виден", "регрессия", async (p) => {
    const bad = [];
    const step = async (sel, key, expectKey, effect, label) => {
      await p.focus(sel); await p.keyboard.press(key);
      const a = await activeKey(p);
      const fv = await p.evaluate(() => { const e = document.activeElement; return !!e && e !== document.body && e.matches(":focus-visible"); });
      const eff = await effect();
      if (!eff) bad.push(`${label}: действие не выполнено`);
      if (a !== expectKey) bad.push(`${label}: фокус ${a} вместо ${expectKey}`);
      else if (!fv) bad.push(`${label}: фокус не виден (:focus-visible)`);
    };
    await open(p, "&t=Plus");
    await p.keyboard.press("Tab"); // включает режим клавиатуры для :focus-visible
    await step('#tariffs button[data-tariff="Pro"]', "Enter", "tariff:Pro",
      async () => (await p.getAttribute('#tariffs button[data-tariff="Pro"]', "aria-pressed")) === "true" || (await p.getAttribute('#tariffs button[data-tariff="Pro"]', "aria-checked")) === "true", "тариф");
    await open(p, "&t=Plus"); await p.keyboard.press("Tab");
    await step('.offer[data-offer-id="plus-own"]', "Enter", "offer:plus-own",
      async () => (await p.getAttribute('.offer[data-offer-id="plus-own"]', "aria-checked")) === "true", "способ");
    await step('#terms [data-term="3"]', "Enter", "term:3", async () => (await pressedTerm(p)) === 3, "срок");
    await step("#qp", "Enter", "#qp", async () => (await qty(p)) === 2, "«+» (1 → 2)");
    await step("#qm", "Enter", "#qm", async () => (await qty(p)) === 1, "«−» до минимума (2 → 1)");
    return { ok: !bad.length, detail: bad.join("; ") };
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

  await test("R-09", ["А3-05", "А8-05"], "Итог: месячный эквивалент всего заказа подписан и рассчитан верно", "регрессия", async (p) => {
    const monthlyRe = /(≈|в\s*мес|\/\s*мес|в\s*месяц)/i, orderRe = /(заказ|итого|всего|за\s+все)/i;
    const lines = async () => (await p.locator("#sum").innerText()).split("\n").map(norm).filter(Boolean);
    const bad = [];
    for (const [q, term, unit] of [[2, 3, 42], [3, 3, 42], [1, 3, 42], [2, 12, 159]]) {
      await open(p, `&t=Plus&o=plus-own&term=${term}&q=${q}`);
      const L = await lines(), total = unit * q;
      const want = norm(eur(total / term)), wrong = norm(eur(unit / term));
      const hit = L.find((l) => l.includes(want) && monthlyRe.test(l));
      if (!hit) bad.push(`${q} шт. × ${term} мес.: нет строки с ${want} в месяц (итог: ${L.join(" | ")})`);
      else if (q > 1 && !orderRe.test(hit)) bad.push(`${q} шт.: «${hit}» не указывает, что это весь заказ`);
      if (q > 1 && L.some((l) => l.includes(wrong) && monthlyRe.test(l))) bad.push(`${q} шт.: в итоге месячная цена одной штуки ${wrong} выглядит как цена заказа`);
    }
    await open(p, "&t=Plus&o=plus-own&term=1&q=2");
    if ((await lines()).some((l) => /≈/.test(l))) bad.push("срок 1 мес.: лишний месячный эквивалент");
    return { ok: !bad.length, detail: bad.join("; ") };
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

  await test("R-10c", ["А4-07", "А11-01"], "Наличие 1 при лимите 3: виден счётчик и объяснение именно про наличие", "регрессия", async (p) => {
    await withCatalog(p, FIX.stockOne); await open(p, "&t=Plus&o=s&term=1");
    if (!(await vis(p, "#qtySec"))) return { ok: false, detail: "блок количества скрыт — покупатель не узнает, почему нельзя взять больше одной штуки" };
    const q = await qty(p);
    const plusBlocked = await p.evaluate(() => { const b = document.getElementById("qp"); return b.disabled || b.getAttribute("aria-disabled") === "true"; });
    const msg = norm(await p.evaluate(() => { const s = document.getElementById("qtySec"); const c = s.cloneNode(true); c.querySelectorAll("h2, .step, [hidden]").forEach((e) => e.remove()); return c.innerText; }));
    const nums = (msg.match(/\d+/g) || []).map(Number);
    const aboutStock = /(налич|доступн|остал|склад)/i.test(msg), aboutLimit = /(заказ|максимум|не больше|лимит)/i.test(msg);
    const ok = q === 1 && plusBlocked && nums.includes(1) && !nums.includes(3) && aboutStock && !aboutLimit;
    return { ok, detail: `количество ${q}; «+» заблокирована: ${plusBlocked}; объяснение: «${msg}» (про наличие: ${aboutStock}, про лимит заказа: ${aboutLimit})` };
  });

  await test("R-11", ["А11-06", "А6-03"], "Числа и склонения: «из N мест» для 2, 5, 11, 21, 22; число тарифов, если показано", "регрессия", async (p) => {
    const gen = (n) => (n % 10 === 1 && n % 100 !== 11 ? "места" : "мест"); // родительный падеж после «из N»
    const bad = [];
    await withCatalog(p, FIX.manyUnits);
    for (const n of [2, 5, 11, 21, 22]) {
      await open(p, `&t=Plus&o=u&term=1&q=${n}`);
      const t = await txt(p, "#req");
      const m = t.match(new RegExp(`(?<![0-9])${n}\\s+(мест[а-я]*)`));
      if (!m) bad.push(`${n} шт.: в требованиях нет количества («${t}»)`);
      else if (m[1] !== gen(n)) bad.push(`«${n} ${m[1]}» вместо «${n} ${gen(n)}»`);
    }
    for (const [n, w] of [[5, "тарифов"], [21, "тариф"], [3, "тарифа"]]) {
      const q = await newPage(); await withCatalog(q, FIX.tariffs(n)); await q.goto(BASE + "?demo");
      const m = (await txt(q, "body")).match(new RegExp(`(?<![0-9])${n}\\s+(тариф[а-я]*)`));
      if (m && m[1] !== w) bad.push(`«${n} ${m[1]}» вместо «${n} ${w}»`);
      await q.context().close();
    }
    return { ok: !bad.length, detail: bad.join("; ") };
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

  await test("R-14", ["Г-05", "А6-01"], "Предупреждение о приватности из данных видно в строке общего аккаунта до выбора", "регрессия", async (p) => {
    await open(p, "&t=Plus");
    const cat = await p.evaluate(() => JSON.parse(document.getElementById("catalog").textContent));
    const shared = cat.offers.filter((o) => o.t === "Plus" && o.kind === "shared");
    const bad = [];
    for (const o of shared) {
      const warn = o.privacy || o.limits[0]; // источник текста — данные каталога
      const row = `.offer[data-offer-id="${o.id}"]`;
      if ((await p.getAttribute(row, "aria-checked")) === "true") { bad.push("способ уже выбран — проверка невозможна"); continue; }
      const found = await p.evaluate(([sel, w]) => { const norm = (s) => s.replace(/[\s\u00a0]+/g, " ").trim().toLowerCase().replace(/[.]$/, "");
        const r = document.querySelector(sel); if (!r) return null; const target = norm(w);
        for (const el of r.querySelectorAll("*")) { if (el.children.length && [...el.children].some((c) => norm(c.innerText || "").includes(target))) continue;
          if (norm(el.innerText || "").includes(target)) { const b = el.getBoundingClientRect(), rb = r.getBoundingClientRect(), cs = getComputedStyle(el);
            return { w: b.width, h: b.height, inside: b.left >= rb.left - 1 && b.right <= rb.right + 1 && b.top >= rb.top - 1 && b.bottom <= rb.bottom + 1, fs: parseFloat(cs.fontSize), vis: cs.visibility !== "hidden" && cs.display !== "none" }; } }
        return null; }, [row, warn]);
      if (!found) bad.push(`«${o.name}»: в строке нет предупреждения «${warn}»`);
      else if (!found.vis || !found.inside || found.w < 1) bad.push(`«${o.name}»: предупреждение скрыто или выходит за строку`);
      else if (found.fs < 13) bad.push(`«${o.name}»: предупреждение мельче 13 px (${found.fs})`);
    }
    return { ok: shared.length > 0 && !bad.length, detail: bad.join("; ") || `проверено способов: ${shared.length}` };
  });

  /* ---------- находки независимого повторного аудита 21.10 (на b507dc5 падают) ---------- */
  const noticeText = async (p) => ((await vis(p, "#notice")) ? await txt(p, "#notice") : "");
  await test("R-15", ["А7-03"], "Тариф A → B → A: прежний срок не восстанавливается", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=12");
    await p.click('#tariffs button[data-tariff="Pro"]'); await p.click('#tariffs button[data-tariff="Plus"]');
    await p.click('.offer[data-offer-id="plus-own"]');
    const t = await pressedTerm(p);
    return { ok: t !== null && t !== 12, detail: `после возврата к Plus и выбора того же способа срок ${t}; прежний выбор был 12 мес.` };
  });
  await test("R-16", ["А7-03", "Г-04"], "Смена тарифа: срок не переносится, единственный способ выбран с доступным сроком", "регрессия", async (p) => {
    const bad = [];
    for (const [t, id] of [["Business", "biz-team"], ["Go", "go-own"]]) {
      await open(p, "&t=Plus&o=plus-own&term=12");
      await p.click(`#tariffs button[data-tariff="${t}"]`);
      const sel = await p.evaluate(() => document.querySelector('.offer[aria-checked="true"]')?.dataset.offerId || null);
      const term = await pressedTerm(p), canBuy = await vis(p, "#buyNow"), n = await noticeText(p);
      if (sel !== id) bad.push(`${t}: выбран ${sel}`);
      if (term === 12) bad.push(`${t}: перенесён срок 12 мес.`);
      if (!canBuy) bad.push(`${t}: показан недоступный срок, хотя есть доступные`);
      if (!n) bad.push(`${t}: нет пояснения о новом выборе`);
    }
    return { ok: !bad.length, detail: bad.join("; ") || "срок выбран заново, пояснение есть" };
  });
  await test("R-17", ["А7-01"], "Собственный выбор срока не сопровождается пояснением об автоматическом изменении", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=1");
    const seen = [];
    for (const k of [3, 12, 3]) { await p.click(`#terms [data-term="${k}"]`); const n = await noticeText(p); if (n) seen.push(`${k} мес.: «${n}»`); }
    return { ok: !seen.length, detail: seen.join("; ") || "пояснений нет" };
  });
  await test("R-18", ["А7-02"], "Явный выбор уже стоящего срока запоминается", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=12");
    await p.click('.offer[data-offer-id="plus-sep"]');
    const auto = await pressedTerm(p);
    await p.click(`#terms [data-term="${auto}"]`);
    await p.click('.offer[data-offer-id="plus-own"]');
    const t = await pressedTerm(p);
    return { ok: t === auto, detail: `у «Отдельного аккаунта» срок стал ${auto}, покупатель нажал его; после возврата срок ${t}` };
  });
  await test("R-19", ["А4-07", "А10-05"], "Объяснение предела количества видно на экране, когда счётчик над панелью", "регрессия", async (p) => {
    const bad = [];
    for (const [w, h] of [[320, 700], [390, 740], [1280, 900]]) {
      await p.setViewportSize({ width: w, height: h });
      await open(p, "&t=Plus&o=plus-own&term=12&q=2");
      await p.evaluate(() => { const st = document.querySelector("#qp").getBoundingClientRect(), bar = document.getElementById("bar").getBoundingClientRect(); window.scrollBy(0, st.bottom - bar.top + 4); });
      await p.click("#qp");
      const r = await p.evaluate(() => { const m = document.getElementById("qmsg"); if (!m || m.hidden || !m.offsetParent) return { shown: false };
        const b = m.getBoundingClientRect(), pts = [[b.left + 4, b.top + 3], [b.left + 4, b.bottom - 3], [b.right - 4, b.bottom - 3]];
        const all = pts.every(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && m.contains(e); });
        return { shown: true, onScreen: b.top >= 0 && b.bottom <= innerHeight && all, text: m.innerText }; });
      if (!r.shown) bad.push(`${w}px: объяснения нет`); else if (!r.onScreen) bad.push(`${w}px: «${r.text}» скрыто под панелью или за экраном`);
    }
    return { ok: !bad.length, detail: bad.join("; ") || "видно" };
  });
  await test("R-20", ["Г-09", "А7-01"], "Стрелки на тарифах переводят фокус, но не сбрасывают выбор", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=3&q=2");
    await p.focus('#tariffs button[data-tariff="Plus"]'); await p.keyboard.press("ArrowRight");
    const st = await p.evaluate(() => ({ t: document.querySelector('#tariffs [aria-pressed="true"]')?.dataset.tariff, o: document.querySelector('.offer[aria-checked="true"]')?.dataset.offerId || null }));
    const foc = await activeKey(p);
    return { ok: st.t === "Plus" && st.o === "plus-own" && foc === "tariff:Pro", detail: `после стрелки: тариф ${st.t}, способ ${st.o}, фокус ${foc}` };
  });
  await test("R-21", ["Г-03"], "Счётчик корзины не мельче 13 px", "регрессия", async (p) => {
    await open(p, "&t=Plus&o=plus-own&term=1"); await p.click("#toCart");
    const fs = await p.evaluate(() => parseFloat(getComputedStyle(document.getElementById("cartN")).fontSize));
    return { ok: fs >= 13, detail: `${fs} px` };
  });
  await test("R-22", ["А11-06"], "Пояснение о смене тарифа грамматически согласовано", "регрессия", async (p) => {
    const bad = [];
    for (const q of ["&t=Plus&o=plus-own&term=1", "&t=Plus&q=1"]) {
      await open(p, q); await p.click('#tariffs button[data-tariff="Pro"]');
      const n = await noticeText(p);
      // одно сбрасываемое значение с глаголом во множественном числе — ошибка согласования
      if (/:\s*(способ доступа|срок|количество)\s+выбираются/i.test(n)) bad.push(`«${n}»`);
    }
    return { ok: !bad.length, detail: bad.join("; ") || "согласовано" };
  });
  await test("R-23", ["А3-02"], "«от» у способа — только если доступных цен несколько", "регрессия", async (p) => {
    await open(p, "&t=Plus"); // «Место в общем аккаунте»: доступен только срок 1 мес.
    const t = await txt(p, '.offer[data-offer-id="plus-shared"] .op');
    return { ok: !!t && !/^от\s/.test(t), detail: `«${t}»` };
  });

  await test("R-24", ["А7-04", "А7-02"], "Отсутствующий срок заменяется ближайшим доступным (при равенстве — более коротким) и восстанавливается при возврате", "регрессия", async (p) => {
    const bad = [];
    // данные демо: «На ваш аккаунт» 12 мес. → «Отдельный аккаунт» (1 и 3 мес.) → ожидается 3 → обратно 12
    await open(p, "&t=Plus&o=plus-own&term=12");
    await p.click('.offer[data-offer-id="plus-sep"]'); const t1 = await pressedTerm(p), n1 = await txt(p, "#notice");
    await p.click('.offer[data-offer-id="plus-own"]'); const t2 = await pressedTerm(p), n2 = await txt(p, "#notice");
    if (t1 !== 3 || !termRe(3).test(n1)) bad.push(`12 → «Отдельный аккаунт»: срок ${t1}, пояснение «${n1}»`);
    if (t2 !== 12 || !termRe(12).test(n2)) bad.push(`обратно: срок ${t2}, пояснение «${n2}»`);
    // синтетика: 2 мес. при доступных 1 и 3 — равное расстояние, выбирается 1; 12 мес. — выбирается 3
    const q = await newPage(); await withCatalog(q, FIX.nearestTerm);
    for (const [from, want] of [[2, 1], [12, 3]]) {
      await q.goto(BASE + `?demo&t=Plus&o=a&term=${from}`);
      await q.click('.offer[data-offer-id="b"]'); const t = await pressedTerm(q);
      await q.click('.offer[data-offer-id="a"]'); const back = await pressedTerm(q);
      if (t !== want) bad.push(`синтетика ${from} мес. → ${t}, ожидалось ${want}`);
      if (back !== from) bad.push(`синтетика: возврат дал ${back}, ожидалось ${from}`);
    }
    // желаемый срок помнится через несколько способов: явно 12 → Б (1, 3) → 3 → В (3, 6) → 6, а не подставленные 3 → обратно к А → 12
    await q.goto(BASE + "?demo&t=Plus&o=a&term=2"); await q.click('#terms [data-term="12"]');
    await q.click('.offer[data-offer-id="b"]'); const tb = await pressedTerm(q);
    await q.click('.offer[data-offer-id="c"]'); const tc = await pressedTerm(q);
    await q.click('.offer[data-offer-id="a"]'); const ta = await pressedTerm(q);
    if (tb !== 3 || tc !== 6 || ta !== 12) bad.push(`синтетика 12 → Б → В → А: ${tb} → ${tc} → ${ta}, ожидалось 3 → 6 → 12`);
    await q.context().close();
    return { ok: !bad.length, detail: bad.join("; ") || `12 → ${t1} → ${t2}; синтетика верна (в т. ч. 12 → 3 → 6 → 12)` };
  });

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
