// Покупательские сессии: последовательности действий с накопленным состоянием, через интерфейс обычной страницы.
// Внутри сессии страница не перезагружается и состояние не подставляется служебными функциями.
// Ожидания — из независимой модели session-model.mjs (данные каталога + правила реестра).
//
// Настройки запуска (переменные окружения):
//   BASE_URL   адрес страницы без параметров (обязательно)
//   SCEN       сценарии или группы через запятую: A,Б,В,Г,Д,Е,Ж,З,И или номера (A1,Ж2…); по умолчанию — все
//   VIEWPORTS  размеры экрана, например 320x568,390x740 (по умолчанию). Полный набор: 320x568,390x740,819x900,820x900,1280x800
//   DATA       набор данных для сценариев без собственного набора: demo (каталог страницы) | memory | limits
//   MIXED      число смешанных сессий группы З (по умолчанию 2), STEPS — шагов в каждой (по умолчанию 30)
//   SEED       начальное значение генератора для смешанных сессий (по умолчанию 1)
//   OUT_DIR    куда писать отчёт (по умолчанию qa/sessions-out), LABEL — версия для отчёта
//   SHOTS=1    сохранять снимок экрана после каждого шага (для просмотра глазами: shots/<сессия>/NN-шаг.png)
//   CHROMIUM_PATH — свой браузер для локального запуска
// Повтор одной ошибки: команда из файла failures/<id>.json (поле repro).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { offersOf, termsOf, info, buyable, buyTerms, eur, norm, tariffCheapest, cheapestOf } from "./oracle.mjs";
import { Model, unitN, unitGen, maxQty } from "./session-model.mjs";

const BASE = process.env.BASE_URL;
if (!BASE) { console.error("не задан BASE_URL"); process.exit(2); }
const OUT = process.env.OUT_DIR || "qa/sessions-out";
const LABEL = process.env.LABEL || "local";
const VPS = (process.env.VIEWPORTS || "320x568,390x740").split(",").map((s) => s.trim().split("x").map(Number));
const SEED = Number(process.env.SEED || 1), MIXED = Number(process.env.MIXED ?? 2), STEPS = Number(process.env.STEPS || 30);
const WANT = (process.env.SCEN || "").split(",").map((s) => s.trim()).filter(Boolean);
rmSync(OUT, { recursive: true, force: true }); mkdirSync(join(OUT, "failures"), { recursive: true });

/* ---------- наборы данных ---------- */
const off = (id, t, kind, name, terms, extra = {}) => ({ id, t, kind, name, fact: name + " — описание", max: 3, unit: ["место", "места", "мест", false, "место"], terms, req: [], limits: [], ...extra });
const SYNTH = {
  // память выбора и ближайший срок: 12 → Б(1,3) → 3; → В(3,6) → 6; 2 → Б(1,3) → 1 (равное расстояние — более короткий)
  memory: { product: { id: "x", name: "Тест" }, tariffs: ["Plus", "Pro"], offers: [
    off("a", "Plus", "own", "Способ А", { 2: { price: 8, st: "ok" }, 12: { price: 40, st: "ok" } }),
    off("b", "Plus", "sep", "Способ Б", { 1: { price: 5, st: "ok" }, 3: { price: 12, st: "ok" } }),
    off("c", "Plus", "shared", "Способ В", { 3: { price: 10, st: "ok" }, 6: { price: 18, st: "ok" } }, { privacy: "Чаты видят другие участники." }),
    off("p", "Pro", "own", "Способ П", { 1: { price: 30, st: "ok" } }, { max: 1 }) ] },
  // ограничения: остаток 1 при лимите 3, остаток 4 при лимите 25, способ по одной штуке, ожидается/нет
  limits: { product: { id: "x", name: "Тест" }, tariffs: ["Plus", "Team"], offers: [
    off("s1", "Plus", "sep", "Остаток один", { 1: { price: 10, st: "low", left: 1 }, 3: { price: 27, st: "ok" } }),
    off("m1", "Plus", "own", "По одной", { 1: { price: 12, st: "ok" }, 3: { price: 33, st: "soon", eta: "через неделю" } }, { max: 1, unit: ["активация", "активации", "активаций", true, "активацию"] }),
    off("no", "Plus", "shared", "Нет совсем", { 1: { price: 6, st: "out" }, 3: { price: 17, st: "soon", eta: null } }),
    off("tm", "Team", "team", "Места команды", { 1: { price: 2, st: "low", left: 4 }, 12: { price: 20, st: "ok" } }, { max: 25, req: [{ text: "почта участника", scope: "unit" }] }) ] },
};
async function loadCatalog(name) {
  if (name !== "demo") return SYNTH[name];
  const html = await (await fetch(BASE)).text();
  return JSON.parse(html.match(/<script type="application\/json" id="catalog">([\s\S]*?)<\/script>/)[1]);
}

/* ---------- генератор для смешанных сессий ---------- */
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* ---------- чтение страницы ---------- */
function readPage() {
  const q = (s) => document.querySelector(s), shown = (e) => !!e && !e.closest("[hidden]") && e.getClientRects().length > 0;
  const txt = (s) => { const e = q(s); return shown(e) ? e.innerText.replace(/\s+/g, " ").trim() : null; };
  const bar = q("#bar").getBoundingClientRect(), vh = innerHeight;
  const main = ["#buyNow", "#notifyBar", "#nextStep"].map((s) => q(s)).find(shown);
  let mainHit = null;
  if (main) { // inert снимается на время проверки: окно должно закрывать кнопку и визуально, а не только блокировать её
    const pg = q("#page"), inert = pg.hasAttribute("inert"); pg.removeAttribute("inert");
    const r = main.getBoundingClientRect(), el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (inert) pg.setAttribute("inert", "");
    mainHit = { id: main.id, inView: r.top >= 0 && r.bottom <= vh + 1, clickable: !!el && main.contains(el) }; }
  const firstTerm = q("#terms [data-term]"), nt = q("#notice");
  const rect = (e) => { if (!shown(e)) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
  const a = document.activeElement;
  return {
    tariff: q('#tariffs [aria-pressed="true"]')?.dataset.tariff || null,
    offer: q('.offer[aria-checked="true"]')?.dataset.offerId || null,
    terms: [...document.querySelectorAll("#terms [data-term]")].map((b) => ({ k: +b.dataset.term, pressed: b.getAttribute("aria-pressed") === "true", text: b.innerText.replace(/\s+/g, " ") })),
    qty: shown(q("#qtySec")) ? { v: +q("#qv").innerText, minusOff: q("#qm").getAttribute("aria-disabled") === "true", plusOff: q("#qp").getAttribute("aria-disabled") === "true" } : null,
    qmsg: txt("#qmsg"), notice: txt("#notice"), ctx: txt("#ctx"), total: txt("#sum b"), det: txt("#sum span"),
    btn: { buy: shown(q("#buyNow")) && !q("#buyNow").disabled, cart: shown(q("#toCart")) && !q("#toCart").disabled, notify: shown(q("#notifyBar")), next: shown(q("#nextStep")) },
    cartN: shown(q("#cartN")) ? q("#cartN").innerText : "0", toast: txt("#toast"), sheet: !q("#scrim").hidden,
    barTop: bar.top, vh, main: mainHit, firstTerm: rect(firstTerm), noticeRect: rect(nt),
    active: a && a !== document.body ? (a.dataset.tariff ? "tariff:" + a.dataset.tariff : a.dataset.offerId ? "offer:" + a.dataset.offerId : a.dataset.term ? "term:" + a.dataset.term : a.id ? "#" + a.id : a.tagName) : "BODY",
  };
}

/* ---------- сессия ---------- */
class Fail extends Error {}
class Session {
  constructor(id, title, page, cat, vp, dataName, seed) { Object.assign(this, { id, title, page, cat, vp, dataName, seed }); this.steps = []; this.errors = []; this.checks = 0; }
  async start() {
    await this.page.goto(BASE); await this.page.waitForSelector("#tariffs [aria-pressed='true']");
    const t = await this.page.getAttribute("#tariffs [aria-pressed='true']", "data-tariff");
    this.m = new Model(this.cat, t); await this.verify("старт: обычная страница");
  }
  log(s) { this.steps.push(s); }
  // нажатие через интерфейс; when=null — ожидаемо не меняет модель
  async click(sel, label, apply, opts = {}) {
    const p = this.page, el = p.locator(sel).first();
    await el.scrollIntoViewIfNeeded();
    const before = await el.evaluate((e) => e.getBoundingClientRect().top).catch(() => null);
    const off = await el.getAttribute("aria-disabled") === "true";   // неактивную «+» покупатель тоже может нажать
    if (opts.dbl) await el.dblclick({ force: off }); else await el.click({ force: off });
    this.log(label); if (apply) apply();
    await p.waitForTimeout(opts.fast ? 0 : 60);
    if (!opts.noFinger && before != null) {
      const after = await p.locator(sel).first().evaluate((e) => e.getBoundingClientRect().top).catch(() => null);
      const barTop = await p.evaluate(() => document.getElementById("bar").getBoundingClientRect().top);
      if (opts.reveal) { if (after == null || after < -2 || after > barTop - 20) this.err(`«${label}»: после выбора строка способа ушла с экрана (${Math.round(after)})`); }
      else if (after != null && Math.abs(after - before) > 30) this.err(`«${label}»: нажатый элемент сместился на ${Math.round(after - before)} px (Г-07)`);
    }
    await this.verify(label, opts);
  }
  err(msg) { this.errors.push(msg); }
  async verify(label, opts = {}) {
    const d = await this.page.evaluate(readPage), m = this.m, o = m.offer(), i = m.i(), e = [];
    this.checks++;
    if (d.tariff !== m.t) e.push(`тариф ${d.tariff}, ожидался ${m.t}`);
    if (d.offer !== m.o) e.push(`способ ${d.offer}, ожидался ${m.o}`);
    if (o) {
      const ks = termsOf(o);
      if (d.terms.map((x) => x.k).join() !== ks.join()) e.push(`сроки ${d.terms.map((x) => x.k)} вместо ${ks}`);
      const pr = d.terms.find((x) => x.pressed); if (!pr || pr.k !== m.term) e.push(`выбран срок ${pr && pr.k}, ожидался ${m.term}`);
      for (const tr of d.terms) { const ti = info(o, tr.k);
        if (buyable(ti) && !norm(tr.text).includes(norm(eur(ti.price)))) e.push(`у срока ${tr.k} мес. нет цены`);
        if (!buyable(ti) && !/Нет в наличии|Ожидается/.test(tr.text)) e.push(`у недоступного срока ${tr.k} мес. нет статуса`); }
      const qs = m.qShown();
      if ((qs == null) !== (d.qty == null)) e.push(`счётчик ${d.qty ? "виден" : "скрыт"}, ожидалось ${qs == null ? "скрыт" : "виден"}`);
      if (qs != null && d.qty) {
        const mx = m.maxNow();
        if (d.qty.v !== m.q) e.push(`количество ${d.qty.v}, ожидалось ${m.q}`);
        if (d.qty.plusOff !== (m.q >= mx)) e.push(`«+» ${d.qty.plusOff ? "недоступна" : "доступна"} при ${m.q} из ${mx}`);
        if (d.qty.minusOff !== (m.q <= 1)) e.push(`«−» ${d.qty.minusOff ? "недоступна" : "доступна"} при ${m.q}`);
        const stock = i.st === "low" && i.left < o.max;
        if (m.q >= mx) { if (!d.qmsg) e.push("на пределе нет объяснения"); else if (!d.qmsg.includes(stock ? unitN(o, mx) : unitGen(o, mx)) || !(stock ? /налич/ : /заказ/).test(d.qmsg)) e.push(`объяснение предела «${d.qmsg}» (ожидалось про ${stock ? "наличие" : "лимит заказа"}, ${mx})`); }
        else if (d.qmsg) e.push(`лишнее объяснение предела «${d.qmsg}»`);
      }
    }
    // итог: один шаблон
    const ctx = o ? `${m.t} · ${o.name} · ${m.term} мес.` : `${m.t} · способ доступа не выбран`;
    if (norm(d.ctx) !== ctx) e.push(`строка выбора «${d.ctx}», ожидалась «${ctx}»`);
    if (m.canBuy()) {
      const total = i.price * m.q;
      if (norm(d.total) !== norm(eur(total))) e.push(`сумма ${d.total}, ожидалась ${eur(total)}`);
      const comp = `${unitN(o, m.q)} × ${norm(eur(i.price))}`;
      if (!norm(d.det).includes(comp)) e.push(`состав «${d.det}», ожидался «${comp}»`);
      if (m.term > 1 && !norm(d.det).includes(`≈ ${norm(eur(total / m.term))} в мес. за заказ`)) e.push(`нет месячного эквивалента ${eur(total / m.term)}`);
      if (m.term === 1 && /≈/.test(d.det || "")) e.push("лишний месячный эквивалент у срока 1 мес.");
      if (!d.btn.buy || !d.btn.cart || d.btn.notify) e.push(`кнопки: купить ${d.btn.buy}, корзина ${d.btn.cart}, уведомить ${d.btn.notify}`);
    } else if (o) {
      if (!/Нет в наличии|Ожидается/.test(d.total || "")) e.push(`итог «${d.total}» без статуса`);
      if (!d.btn.notify || d.btn.buy || d.btn.cart) e.push("при недоступном варианте ожидалась только «Уведомить»");
    } else {
      const c = tariffCheapest(this.cat, m.t);
      if (c && norm(d.total) !== `от ${norm(eur(c.price))}`) e.push(`до выбора способа «${d.total}», ожидалось «от ${eur(c.price)}»`);
      if (c && !d.btn.next) e.push("до выбора способа нет действия для следующего шага");
      if (d.btn.buy || d.btn.cart) e.push("до выбора способа доступна покупка");
    }
    // пояснения: ровно то, что изменилось не по прямому действию
    const exp = m.expectNotice();
    if (!exp.length && d.notice) e.push(`лишнее пояснение «${d.notice}»`);
    if (exp.length && !d.notice) e.push(`нет пояснения (${exp.map((x) => x.kind).join(", ")})`);
    if (exp.length && d.notice) {
      for (const x of exp) for (const re of x.re) if (!re.test(d.notice)) e.push(`пояснение «${d.notice}» не содержит ${re}`);
      const kinds = new Set(exp.map((x) => x.kind));
      if (!kinds.has("termChanged") && !kinds.has("termRestored") && /Срок (изменён|снова)/.test(d.notice)) e.push(`пояснение о сроке без изменения срока: «${d.notice}»`);
      if (!kinds.has("qtyReduced") && !kinds.has("qtyRestored") && !kinds.has("qtySingle") && /Количество (уменьшено|снова|1)/.test(d.notice)) e.push(`пояснение о количестве без изменения: «${d.notice}»`);
      if (d.noticeRect && opts.actionNotice && !opts.fast && (d.noticeRect.bottom > d.barTop + 1 || d.noticeRect.top < 0)) e.push("пояснение не видно: под панелью или за экраном");
    }
    // корзина (имитация): счётчик = сумма добавленных количеств
    if (String(m.cartCount()) !== d.cartN) e.push(`счётчик корзины ${d.cartN}, ожидалось ${m.cartCount()}`);
    // главное действие видно и нажимается; поверх окна — нет
    if (!d.sheet) { if (!d.main) e.push("нет главного действия"); else if (!d.main.inView || !d.main.clickable) e.push(`главное действие ${d.main.id}: видно ${d.main.inView}, нажимается ${d.main.clickable}`); }
    else if (d.main && d.main.clickable) e.push("главное действие нажимается поверх открытого окна");
    // следующий шаг после выбора способа — на экране, без поисковой прокрутки
    if (opts.expectTerms && o && (!d.firstTerm || d.firstTerm.top > d.barTop - 24 || d.firstTerm.top < 0)) e.push(`после выбора способа сроки не на экране (верх ${d.firstTerm && Math.round(d.firstTerm.top)}, панель ${Math.round(d.barTop)})`);
    if (opts.focus && d.active !== opts.focus) e.push(`фокус ${d.active}, ожидался ${opts.focus}`);
    if (opts.toast && m.lastAdd) { const a = m.lastAdd, want = [`${a.t} · ${a.name} · ${a.term} мес.`, norm(eur(a.total))].concat(a.q > 1 ? [`× ${a.q}`] : []);
      for (const w of want) if (!norm(d.toast).includes(w)) e.push(`сообщение о добавлении «${d.toast}» не содержит «${w}»`); }
    if (process.env.SHOTS) { const dir = join(OUT, "shots", `${this.id.replace("#", "-")}--${this.vp.join("x")}`); mkdirSync(dir, { recursive: true });
      await this.page.screenshot({ path: join(dir, `${String(this.checks).padStart(2, "0")}-${label.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40)}.png`) }); }
    e.push(...this.errors.splice(0));
    if (this.page.__errors.length) e.push("ошибка JS: " + this.page.__errors.splice(0).join("; "));
    if (e.length) {
      const file = `${this.id}--${this.vp.join("x")}${this.seed != null ? "--seed" + this.seed : ""}`;
      await this.page.screenshot({ path: join(OUT, "failures", file + ".png") }).catch(() => {});
      const repro = `SCEN=${this.id.split("#")[0]} VIEWPORTS=${this.vp.join("x")}${this.seed != null ? ` SEED=${this.seed} MIXED=1 STEPS=${STEPS}` : ""} DATA=${this.dataName} BASE_URL=${BASE} node qa/sessions.mjs`;
      writeFileSync(join(OUT, "failures", file + ".json"), JSON.stringify({ session: this.id, title: this.title, version: LABEL, viewport: this.vp, data: this.dataName, seed: this.seed, step: label, actions: this.steps, expected: { tariff: m.t, offer: m.o, term: m.term, q: m.q, notice: exp.map((x) => x.kind), cart: m.cartCount(), ctx }, actual: d, problems: e, screenshot: file + ".png", repro }, null, 1));
      throw new Fail(`шаг «${label}»: ${e.join("; ")}`);
    }
  }
  // ---- действия ----
  tariff(t, o = {}) { return this.click(`#tariffs [data-tariff="${t}"]`, `тариф ${t}`, () => this.m.tariff(t), { focus: "tariff:" + t, actionNotice: true, expectTerms: offersOf(this.cat, t).length === 1 && !o.fast, reveal: offersOf(this.cat, t).length === 1, ...o }); }
  pick(id, o = {}) { return this.click(`.offer[data-offer-id="${id}"]`, `способ ${id}`, () => this.m.pick(id), { expectTerms: !o.fast, reveal: true, actionNotice: true, focus: "offer:" + id, ...o }); }
  term(k, o = {}) { return this.click(`#terms [data-term="${k}"]`, `срок ${k} мес.`, () => this.m.setTerm(k), { focus: "term:" + k, actionNotice: true, ...o }); }
  plus(o = {}) { return this.click("#qp", "«+»", () => this.m.qty(+1), { focus: "#qp", ...o }); }
  minus(o = {}) { return this.click("#qm", "«−»", () => this.m.qty(-1), { focus: "#qm", ...o }); }
  add(o = {}) { return this.click("#toCart", "в корзину", () => this.m.add(), { toast: true, noFinger: true, ...o }); }
  async sheet(open, closeHow, label) { // справка: открыть и закрыть, выбор должен сохраниться
    await this.click(open, `открыть ${label}`, null, { noFinger: true });
    if (closeHow === "esc") await this.page.keyboard.press("Escape");
    else if (closeHow === "scrim") await this.page.mouse.click(5, 5);
    else await this.page.click("#shX");
    this.log(`закрыть ${label} (${closeHow})`); await this.page.waitForTimeout(60);
    await this.verify(`после закрытия: ${label}`, { focus: open.startsWith("#") ? open : undefined });
  }
  async notify() { // уведомление: не покупка, корзина не меняется
    await this.click("#notifyBar", "уведомить", null, { noFinger: true });
    await this.page.fill("#nfEmail", "test@example.com"); await this.page.click('#nf button[type="submit"]'); this.log("отправить демо-форму");
    const t = norm(await this.page.locator("#shB").innerText()); if (!/не создана/.test(t)) this.err(`форма уведомления: «${t}»`);
    await this.page.click("#shX"); this.log("закрыть форму"); await this.page.waitForTimeout(60);
    await this.verify("после уведомления");
  }
}

/* ---------- выбор вариантов по данным ---------- */
const by = (cat) => ({
  multi: () => cat.offers.find((o) => o.max >= 3 && termsOf(o).some((k) => k > 1 && info(o, k).st === "ok")),
  stock: () => cat.offers.find((o) => termsOf(o).some((k) => info(o, k).st === "low" && info(o, k).left < o.max)),
  partly: () => cat.offers.find((o) => buyTerms(o).length && termsOf(o).some((k) => !buyable(info(o, k))) && o.max > 1),
  none: () => cat.offers.find((o) => !buyTerms(o).length),
  buyTariffs: () => cat.tariffs.filter((t) => offersOf(cat, t).some((o) => buyTerms(o).length)),
});
async function goTo(s, o) { if (s.m.t !== o.t) await s.tariff(o.t); if (s.m.o !== o.id) await s.pick(o.id); }
async function plusTo(s, q) { while (s.m.q < q && s.m.q < s.m.maxNow()) await s.plus(); }

/* ---------- сценарии ---------- */
const SC = [
  { id: "A1", g: "A", data: "demo", title: "Несколько единиц до лимита заказа и обратно, добавление", run: async (s) => {
    const o = by(s.cat).multi(), k = termsOf(o).find((k) => k > 1 && info(o, k).st === "ok");
    await goTo(s, o); await s.term(k);
    while (s.m.q < s.m.maxNow()) await s.plus();
    await s.plus(); // попытка превысить предел — ничего не меняется
    await s.minus(); await s.minus(); await s.plus(); await s.add(); } },
  { id: "A2", g: "A", data: "demo", title: "Предел по наличию", run: async (s) => {
    const o = by(s.cat).stock(), k = termsOf(o).find((k) => info(o, k).st === "low");
    await goTo(s, o); await s.term(k); while (s.m.q < s.m.maxNow()) await s.plus(); await s.plus(); await s.add(); } },
  { id: "A3", g: "A", data: "limits", title: "Остаток 1 при лимите 3; много мест при лимите 25", run: async (s) => {
    await s.pick("s1"); await s.term(1); await s.plus(); await s.term(3); await s.plus(); await s.plus(); await s.term(1); await s.add();
    await s.tariff("Team"); await s.term(12); for (let n = 0; n < 21; n++) await s.plus(); await s.add(); await s.term(1); await s.add(); } },
  { id: "Б1", g: "Б", data: "demo", title: "Один тариф: разные способы и сроки, несколько разных позиций", run: async (s) => {
    const t = by(s.cat).buyTariffs().find((t) => offersOf(s.cat, t).filter((o) => buyTerms(o).length).length >= 2), list = offersOf(s.cat, t).filter((o) => buyTerms(o).length);
    if (s.m.t !== t) await s.tariff(t);
    await s.pick(list[0].id); await s.term(buyTerms(list[0]).slice(-1)[0]); await plusTo(s, 2); await s.add();
    await s.pick(list[1].id); await s.term(buyTerms(list[1])[0]); await s.add();
    await s.pick(list[0].id); await s.add(); } },
  { id: "В1", g: "В", data: "demo", title: "Повторное добавление одного варианта с разным количеством", run: async (s) => {
    const o = by(s.cat).multi(); await goTo(s, o); await s.term(buyTerms(o)[0]);
    await s.add(); await s.plus(); await s.add(); await s.minus(); await s.add(); } },
  { id: "Г1", g: "Г", data: "demo", title: "Несколько тарифов за сессию и возврат к первому", run: async (s) => {
    const ts = by(s.cat).buyTariffs(), first = s.m.t;
    for (const t of [first, ...ts.filter((x) => x !== first)]) {
      if (s.m.t !== t) await s.tariff(t);
      const o = offersOf(s.cat, t).find((o) => buyTerms(o).length); if (s.m.o !== o.id) await s.pick(o.id);
      await plusTo(s, 2); await s.add(); }
    await s.tariff(first); } },
  { id: "Д1", g: "Д", data: "demo", title: "Передумавший покупатель: меняет всё, смотрит справку, добавляет текущую конфигурацию", run: async (s) => {
    const o = by(s.cat).multi(); await goTo(s, o); await s.term(termsOf(o).slice(-1)[0]); await plusTo(s, 2);
    const t2 = by(s.cat).buyTariffs().find((t) => t !== o.t); await s.tariff(t2);
    const o2 = offersOf(s.cat, t2).find((x) => buyTerms(x).length); if (s.m.o !== o2.id) await s.pick(o2.id);
    await s.tariff(o.t); await s.pick(o.id); await s.term(buyTerms(o)[0]); await plusTo(s, 3); await s.minus();
    await s.sheet("#openCond", "esc", "«Все условия»"); await s.sheet("#openFaq", "x", "вопросы"); await s.sheet("#openTar", "scrim", "сравнение тарифов");
    await s.add(); } },
  { id: "Е1", g: "Е", data: "demo", title: "Доступный → недоступный срок → уведомление → обратно", run: async (s) => {
    const o = by(s.cat).partly(), ok = buyTerms(o)[0], bad = termsOf(o).find((k) => !buyable(info(o, k)));
    await goTo(s, o); await s.term(ok); await plusTo(s, 2); await s.term(bad); await s.notify(); await s.term(ok); await s.add(); } },
  { id: "Е2", g: "Е", data: "demo", title: "Способ недоступен целиком; переход к доступному", run: async (s) => {
    const o = by(s.cat).none(); await goTo(s, o); await s.notify();
    const alt = offersOf(s.cat, o.t).find((x) => buyTerms(x).length); await s.pick(alt.id); await s.add(); } },
  { id: "Е3", g: "Е", data: "limits", title: "По одной штуке, ожидаемый срок, нет в наличии", run: async (s) => {
    await s.pick("s1"); await s.term(3); await plusTo(s, 3); await s.pick("m1"); await s.term(3); await s.notify(); await s.pick("no"); await s.pick("s1"); await s.add(); } },
  { id: "Ж1", g: "Ж", data: "memory", title: "А → Б → В → А, ближайший срок и равное расстояние", run: async (s) => {
    await s.pick("a"); await s.term(12); await s.pick("b"); await s.pick("c"); await s.pick("a");
    await s.term(2); await s.pick("b"); await s.pick("a"); await s.pick("c"); await s.term(6); await s.pick("b"); await s.pick("c"); } },
  { id: "Ж2", g: "Ж", data: "demo", title: "Память количества через недоступный срок и через способ по одной штуке", run: async (s) => {
    const o = by(s.cat).multi(); await goTo(s, o); await s.term(buyTerms(o)[1] ?? buyTerms(o)[0]); await plusTo(s, 2);
    for (const x of offersOf(s.cat, o.t).filter((x) => x.id !== o.id)) { await s.pick(x.id); await s.pick(o.id); } } },
  { id: "Ж3", g: "Ж", data: "memory", title: "Количество через способ по одной штуке и смену тарифа", run: async (s) => {
    await s.pick("b"); await plusTo(s, 3); await s.pick("c"); await s.pick("a"); await s.tariff("Pro"); await s.tariff("Plus"); await s.pick("b"); } },
  { id: "И1", g: "И", data: "demo", title: "Двойные и быстрые нажатия", run: async (s) => {
    const o = by(s.cat).multi(); await goTo(s, o);
    await s.click("#qp", "двойное «+»", () => { s.m.qty(1); s.m.qty(1); }, { dbl: true, noFinger: true });
    await s.click("#qm", "двойное «−»", () => { s.m.qty(-1); s.m.qty(-1); }, { dbl: true, noFinger: true });
    for (let n = 0; n < 4; n++) { await s.page.click("#qp", { delay: 0, force: true }); s.m.qty(1); s.log("быстрое «+»"); } await s.verify("после быстрых «+»");
    // правило прототипа: каждое нажатие «В корзину» добавляет текущее количество один раз (защиты от двойного нажатия нет — вопрос владельцу)
    await s.click("#toCart", "двойное «В корзину»", () => { s.m.add(); s.m.add(); }, { dbl: true, noFinger: true, toast: true });
    const ts = by(s.cat).buyTariffs(); for (const t of [ts[1], ts[0], ts[1]]) { await s.page.click(`#tariffs [data-tariff="${t}"]`); s.m.tariff(t); s.log("быстро: тариф " + t); }
    await s.verify("после быстрой смены тарифов", { fast: true }); } },
  { id: "И2", g: "И", data: "demo", title: "Только клавиатура: тариф, способ, срок, количество, справка, добавление", run: async (s) => {
    const p = s.page, key = async (k, label, apply, opts = {}) => { await p.keyboard.press(k); s.log(label); if (apply) apply(); await p.waitForTimeout(60); await s.verify(label, opts); };
    const active = () => p.evaluate(() => { const a = document.activeElement; return a.dataset.tariff ? "tariff:" + a.dataset.tariff : a.dataset.offerId ? "offer:" + a.dataset.offerId : a.dataset.term ? "term:" + a.dataset.term : a.id ? "#" + a.id : a.tagName; });
    const tabTo = async (pred, max = 40) => { for (let n = 0; n < max; n++) { await p.keyboard.press("Tab"); const a = await active(); if (pred(a)) return a; } throw new Error("клавишей Tab не дойти до нужного элемента"); };
    const vis = async () => { const r = await p.evaluate(() => { const a = document.activeElement, b = document.getElementById("bar"); if (b.contains(a)) return true; const x = a.getBoundingClientRect(); return x.top >= 0 && x.bottom <= b.getBoundingClientRect().top + 1; }); if (!r) s.err("фокус под панелью или за экраном"); };
    const t0 = await tabTo((a) => a.startsWith("tariff:")); await vis();
    const good = (o) => o.max > 1 && buyTerms(o).length > 1;
    const list = by(s.cat).buyTariffs(), other = list.find((t) => "tariff:" + t !== t0 && offersOf(s.cat, t).length > 1 && offersOf(s.cat, t).some(good)) || list[0];
    for (let n = 0; n < 6 && (await active()) !== "tariff:" + other; n++) { await p.keyboard.press("ArrowRight"); s.log("стрелка вправо по тарифам"); }
    await key("Enter", `Enter: тариф ${other}`, () => s.m.tariff(other), { focus: "tariff:" + other, actionNotice: true });
    const o1 = await tabTo((a) => a.startsWith("offer:")); await vis();
    await key("Space", "Space: способ " + o1, () => s.m.pick(o1.slice(6)), { focus: o1, expectTerms: true, actionNotice: true });
    const offs = offersOf(s.cat, s.m.t);
    for (let j = offs.findIndex((x) => x.id === s.m.o); !good(offs[j]); ) { j = (j + 1) % offs.length; const id = offs[j].id;
      await key("ArrowDown", "стрелка вниз: способ " + id, () => s.m.pick(id), { focus: "offer:" + id, expectTerms: true, actionNotice: true }); await vis(); }
    const t1 = await tabTo((a) => a.startsWith("term:")); await vis();
    const o = s.m.offer(), ks = termsOf(o), nextK = ks[(ks.indexOf(+t1.slice(5)) + 1) % ks.length];
    await key("ArrowDown", "стрелка вниз по срокам", () => s.m.setTerm(nextK), { focus: "term:" + nextK, actionNotice: true }); await vis();
    if (s.m.qShown() != null) { await tabTo((a) => a === "#qp"); await vis(); await key("Enter", "Enter: «+»", () => s.m.qty(1), { focus: "#qp" }); await vis(); }
    await tabTo((a) => a === "#openCond"); await vis(); await key("Enter", "Enter: «Все условия»", null, {}); await key("Escape", "Escape: закрыть", null, { focus: "#openCond" });
    if (s.m.canBuy()) { await tabTo((a) => a === "#toCart"); await key("Enter", "Enter: в корзину", () => s.m.add(), { toast: true }); } } },
];

// З: длинные смешанные сессии; обязательная детерминированная + воспроизводимые случайные
async function mixed(s, rand, steps) {
  const pickOf = (a) => a[Math.floor(rand() * a.length)];
  for (let n = 0; n < steps; n++) {
    const m = s.m, o = m.offer(), r = rand();
    if (r < 0.12) await s.tariff(pickOf(s.cat.tariffs.filter((t) => t !== m.t)) || m.t);
    else if (r < 0.32) { const l = offersOf(s.cat, m.t).filter((x) => x.id !== m.o); if (l.length) await s.pick(pickOf(l).id); }
    else if (r < 0.5 && o) { const l = termsOf(o).filter((k) => k !== m.term); if (l.length) await s.term(pickOf(l)); }
    else if (r < 0.66 && m.qShown() != null) await s.plus();
    else if (r < 0.76 && m.qShown() != null) await s.minus();
    else if (r < 0.88 && m.canBuy()) await s.add();
    else if (r < 0.94) await s.sheet(pickOf(["#openFaq", "#openTar"]), pickOf(["esc", "x", "scrim"]), "справка");
    else { await s.page.mouse.wheel(0, Math.round((rand() - 0.5) * 600)); s.log("прокрутка"); await s.page.waitForTimeout(80); await s.verify("после прокрутки"); }
  }
}
SC.push({ id: "З1", g: "З", data: "demo", title: "Длинная смешанная сессия (фиксированная последовательность)", run: async (s) => {
  const c = by(s.cat), o = c.multi(); await goTo(s, o); await s.term(termsOf(o).slice(-1)[0]); await plusTo(s, 2); await s.add();
  const p = c.partly(); await goTo(s, p); await s.add().catch((e) => { throw e; });
  for (const t of c.buyTariffs()) { if (s.m.t !== t) await s.tariff(t); const x = offersOf(s.cat, t).find((x) => buyTerms(x).length); if (s.m.o !== x.id) await s.pick(x.id); await s.term(buyTerms(x).slice(-1)[0]); await s.add(); }
  await s.sheet("#openTar", "x", "сравнение"); await goTo(s, o); await s.add(); await s.add(); } });
for (let n = 0; n < MIXED; n++) SC.push({ id: `З#${SEED + n}`, g: "З", data: process.env.DATA || "demo", seed: SEED + n, title: `Смешанная сессия, seed ${SEED + n}, ${STEPS} шагов`, run: async (s) => mixed(s, rng(SEED + n), STEPS) });

/* ---------- запуск ---------- */
const chosen = SC.filter((x) => !WANT.length || WANT.includes(x.id) || WANT.includes(x.g) || WANT.includes(x.id.split("#")[0]));
const results = [];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const cats = {};
for (const sc of chosen) for (const vp of VPS) {
  const dataName = sc.data === "demo" && process.env.DATA && !sc.seed ? sc.data : sc.data;
  cats[dataName] ||= await loadCatalog(dataName);
  const ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, reducedMotion: "reduce", hasTouch: false });
  const page = await ctx.newPage(); page.setDefaultTimeout(5000); page.__errors = []; page.on("pageerror", (e) => page.__errors.push(String(e)));
  if (dataName !== "demo") await page.route((u) => u.href.split("?")[0] === BASE, async (route) => { const r = await route.fetch(); const body = (await r.text()).replace(/(<script type="application\/json" id="catalog">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(cats[dataName])}$2`); await route.fulfill({ response: r, body, headers: { ...r.headers(), "content-type": "text/html; charset=utf-8" } }); });
  const s = new Session(sc.id, sc.title, page, cats[dataName], vp, dataName, sc.seed ?? null);
  let ok = true, detail = "";
  try { await s.start(); await sc.run(s); }
  catch (e) { ok = false; detail = e instanceof Fail ? e.message : "сбой: " + String(e.message || e).split("\n").filter((l) => /intercept|Timeout|waiting for/.test(l)).slice(0, 3).join(" / "); if (!(e instanceof Fail)) await page.screenshot({ path: join(OUT, "failures", `${sc.id}--${vp.join("x")}.png`) }).catch(() => {}); }
  results.push({ id: sc.id, group: sc.g, title: sc.title, viewport: vp.join("x"), data: dataName, seed: sc.seed ?? null, ok, steps: s.steps.length, checks: s.checks, adds: s.m ? s.m.adds.length : 0, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${sc.id} ${vp.join("x")} (${s.steps.length} шагов, ${s.checks} проверок)${detail ? " :: " + detail.slice(0, 300) : ""}`);
  await ctx.close();
}
await browser.close();
const bad = results.filter((r) => !r.ok);
const L = [`# Покупательские сессии — ${LABEL}`, "", `Время (UTC): ${new Date().toISOString().replace("T", " ").slice(0, 19)}`, `Страница: ${BASE}`, `Размеры: ${VPS.map((v) => v.join("×")).join(", ")} · SEED ${SEED} · смешанных ${MIXED} по ${STEPS} шагов`, "",
  `- Сессий: ${results.length}, прошло ${results.length - bad.length}, упало ${bad.length}`, `- Шагов: ${results.reduce((a, r) => a + r.steps, 0)}, проверок состояния: ${results.reduce((a, r) => a + r.checks, 0)}`, "",
  "Корзина и оформление в прототипе — имитация: проверяются выбор, сообщение о добавлении и счётчик, но не состав корзины (его нет).", ""];
for (const r of results) L.push(`- **${r.ok ? "ПРОШЛА" : "УПАЛА"}** \`${r.id}\` ${r.viewport} · ${r.data} — ${r.title} (${r.steps} шагов, ${r.checks} проверок, добавлений ${r.adds})${r.detail ? `\n  - ${r.detail}` : ""}`);
writeFileSync(join(OUT, "report.md"), L.join("\n") + "\n");
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ label: LABEL, base: BASE, seed: SEED, viewports: VPS, results }, null, 1));
process.exitCode = bad.length ? 1 : 0;
