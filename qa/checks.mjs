// Проверки страницы товара. Набор строится из данных каталога, а ожидаемые значения считает oracle.mjs.
import { U, go, TC, TLG, eur, norm, offersOf, termsOf, tariffTerms, info, buyable, maxEff, buyTerms, cheapestOf, tariffCheapest, offerStatus, preferTerm, stateClasses } from "./oracle.mjs";

const txt = async (page, sel) => norm(await page.locator(sel).first().innerText().catch(() => ""));
const vis = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const dis = (page, sel) => page.locator(sel).first().isDisabled().catch(() => false);

function makeRec(results, group, base) {
  return (name, ok, detail = "", ctx = {}) => {
    results.push({ group, name, ok: !!ok, detail: norm(detail).slice(0, 400), url: ctx.url != null ? U(base, ctx.url) : null, path: ctx.url ?? null, width: ctx.width || 390, sel: ctx.sel || null });
  };
}
function watchErrors(page, rec, label) {
  page.on("pageerror", (e) => rec(`Ошибка JavaScript (${label})`, false, String(e)));
}

/* ---------- 1. Логика каталога: тариф → способ → срок → количество, по всем данным ---------- */
const isOn = async (page, sel) => !(await dis(page, sel));
const qmsg = async (page) => ((await vis(page, "#qmsg")) ? await txt(page, "#qmsg") : "");

export async function logicSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Логика выбора и цены", base);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(4000); watchErrors(page, rec, "логика");
  let n = 0, first = true;
  for (const t of cat.tariffs) {
    const path = `?demo&t=${encodeURIComponent(t)}`;
    await go(page, base, path, first); first = false;
    const exp = offersOf(cat, t), single = exp.length === 1;
    const rows = await page.$$eval(".offer", (els) => els.map((e) => ({ id: e.dataset.offerId, on: e.querySelector(".on").innerText, op: e.querySelector(".op").innerText, of: e.querySelector(".of").innerText, pv: e.querySelector(".pv")?.innerText || "" })));
    rec(`${t}: показаны все способы доступа, включая недоступные`, rows.map((r) => r.id).join() === exp.map((o) => o.id).join(), `ожидалось ${exp.length}, на странице ${rows.length}`, { url: path, sel: "#offers" });
    for (const o of exp) {
      const r = rows.find((x) => x.id === o.id); if (!r) continue;
      const p = [], c = cheapestOf(o), op = norm(r.op);
      if (norm(r.on) !== norm(o.name)) p.push(`название «${r.on}»`);
      if (norm(r.of) !== norm(o.fact)) p.push("нет короткого описания");
      if (c) {
        const want = (buyTerms(o).length > 1 ? "от " : "") + norm(eur(c.price));
        if (!op.startsWith(want)) p.push(`цена «${op}» вместо «${want} …»`);
        if (!op.includes(`за ${TC(c.term)}`)) p.push(`у цены нет фактического срока «за ${TC(c.term)}»`);
      } else if (op !== offerStatus(o)) p.push(`статус «${op}» вместо «${offerStatus(o)}»`);
      if (o.privacy && !norm(r.pv).includes(norm(o.privacy))) p.push("нет предупреждения о приватности");
      if (!o.privacy && r.pv) p.push("лишнее предупреждение о приватности");
      rec(`${t} · ${o.name}: строка способа доступа`, !p.length, p.join("; ") || op, { url: path, sel: `.offer[data-offer-id="${o.id}"]` });
    }
    if (single) {
      rec(`${t}: единственный способ выбран сразу`, (await page.getAttribute(`.offer[data-offer-id="${exp[0].id}"]`, "aria-checked")) === "true" && (await vis(page, "#termSec")), "", { url: path, sel: "#offers" });
    } else {
      const hidden = !(await vis(page, "#termSec")) && !(await vis(page, "#qtySec")) && !(await vis(page, "#req")) && !(await vis(page, "#details"));
      rec(`${t}: до выбора способа нет сроков, количества, условий и требований`, hidden, "", { url: path, sel: "#termSec" });
      const tc = tariffCheapest(cat, t), sum = await txt(page, "#sum");
      const okBar = tc ? sum.includes(`от ${norm(eur(tc.price))}`) && sum.includes(`за ${TC(tc.term)}`) : sum.includes("Нет в наличии");
      rec(`${t}: итог без выбора — цена «от» с фактическим сроком`, okBar && (await dis(page, "#toCart")) && (await dis(page, "#buyNow")), `«${sum}»`, { url: path, sel: "#bar" });
    }
    for (const o of exp) {
      await go(page, base, path);
      if ((await page.getAttribute(`.offer[data-offer-id="${o.id}"]`, "aria-checked")) !== "true") await page.click(`.offer[data-offer-id="${o.id}"]`);
      const k0 = preferTerm(o, 1);
      for (const k of termsOf(o)) {
        if (k !== k0) await page.click(`#terms [data-term="${k}"]`);
        n++;
        const label = `${t} · ${o.name} · ${TC(k)}`;
        const sp = await selectedProblems(page, cat, o, k);
        rec(`${label}: выбранное состояние`, !sp.length, sp.join("; "), { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: "#purchase" });
        const i = info(o, k);
        if (buyable(i) && o.max > 1) {
          const qp = await qtyProblems(page, o, k);
          rec(`${label}: количество и итог`, !qp.length, qp.join("; "), { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: "#qtySec" });
          await go(page, base, `?demo&t=${t}&o=${o.id}&term=${k}`);
        } else rec(`${label}: количество скрыто, когда выбрать его нельзя`, !(await vis(page, "#qtySec")), "", { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: "#qtySec" });
      }
    }
  }
  await ctx.close();
  return n;
}

async function selectedProblems(page, cat, o, k) {
  const p = [], i = info(o, k), anyBuy = buyTerms(o).length > 0;
  if ((await page.getAttribute(`.offer[data-offer-id="${o.id}"]`, "aria-checked")) !== "true") p.push("строка не отмечена выбранной");
  if ((await page.locator('.offer[aria-checked="true"]').count()) !== 1) p.push("выбрано не одно значение");
  // условия выбранного способа — все ограничения из данных видны без листов
  const det = await txt(page, "#details");
  for (const l of o.limits) if (!det.includes(norm(l))) p.push(`ограничение «${l}» не видно`);
  if (!(await vis(page, "#openCond"))) p.push("нет ссылки «Все условия»");
  if (!anyBuy && offersOf(cat, o.t).some((x) => x.id !== o.id && cheapestOf(x)) && !/выберите в списке/i.test(det)) p.push("нет подсказки о доступных способах");
  // сроки: только сроки способа; у доступных — цена и месячный эквивалент единицы
  const terms = await page.$$eval("#terms [data-term]", (els) => els.map((e) => ({ k: +e.dataset.term, text: e.innerText, pressed: e.getAttribute("aria-pressed") })));
  if (terms.map((x) => x.k).join() !== termsOf(o).join()) p.push(`сроки ${terms.map((x) => x.k).join(",")} вместо ${termsOf(o).join(",")}`);
  for (const b of terms) {
    const bi = info(o, b.k), bt = norm(b.text);
    if (b.pressed !== String(b.k === k)) p.push(`у срока ${TC(b.k)} неверная отметка выбора`);
    if (!bt.includes(TC(b.k))) p.push(`нет подписи срока ${TC(b.k)}`);
    if (buyable(bi)) {
      if (!bt.includes(norm(eur(bi.price)))) p.push(`у срока ${TC(b.k)} нет цены ${norm(eur(bi.price))}`);
      if (b.k > 1 && !bt.includes(`≈ ${norm(eur(bi.price / b.k))} в мес. за 1 ${o.unit[4] || "шт."}`)) p.push(`у срока ${TC(b.k)} нет месячного эквивалента единицы`);
      if (b.k === 1 && bt.includes("≈")) p.push("лишний месячный эквивалент у срока 1 мес.");
      if (/наличии|Ожидается/i.test(bt)) p.push(`у доступного срока ${TC(b.k)} лишний статус`);
    } else {
      const st = bi.st === "out" ? "Нет в наличии" : "Ожидается";
      if (anyBuy && !bt.includes(st)) p.push(`у срока ${TC(b.k)} нет «${st}»`);
      if (!anyBuy && /наличии|Ожидается/.test(bt)) p.push(`у срока ${TC(b.k)} повтор статуса, хотя он уже в строке способа`);
      if (bt.includes("€")) p.push(`у недоступного срока ${TC(b.k)} показана цена`);
    }
  }
  const sumB = await txt(page, "#sum b"), sum = await txt(page, "#sum"), req = (await vis(page, "#req")) ? await txt(page, "#req") : "";
  if (buyable(i)) {
    const r0 = o.req.length ? o.req[0].text : "только почта для получения заказа";
    if (!req.startsWith("Понадобится:") || !req.toLowerCase().includes(norm(r0).toLowerCase())) p.push(`нет «Понадобится: ${r0}»`);
    if (sumB !== norm(eur(i.price))) p.push(`итог «${sumB}» вместо ${norm(eur(i.price))}`);
    if (!sum.includes(`за ${TC(k)}`)) p.push("итог не подписан сроком");
    if (k > 1 && !sum.includes(`≈ ${norm(eur(i.price / k))} в мес.`)) p.push("в итоге нет месячного эквивалента");
    if (await dis(page, "#toCart")) p.push("«В корзину» неактивна");
    if (!(await vis(page, "#buyNow")) || (await dis(page, "#buyNow"))) p.push("«Купить сейчас» недоступна");
    if (await vis(page, "#notifyBar")) p.push("лишняя «Уведомить»");
  } else {
    const head = i.st === "out" ? "Нет в наличии" : "Ожидается";
    if (sumB !== head) p.push(`итог «${sumB}» вместо «${head}»`);
    if (i.st === "soon" && !sum.includes(i.eta ? i.eta : "срок уточняется")) p.push("в итоге нет прогноза или «срок уточняется»");
    if (await vis(page, "#buyNow")) p.push("«Купить сейчас» видна у недоступного");
    if (await vis(page, "#toCart")) p.push("корзина видна рядом с «Уведомить»");
    if (!(await vis(page, "#notifyBar"))) p.push("нет «Уведомить»");
    if (req) p.push("«Понадобится» показано, хотя купить нельзя");
  }
  return p;
}

async function qtyProblems(page, o, k) {
  const p = [], i = info(o, k), mx = maxEff(o, i), stock = i.st === "low" && i.left < o.max;
  if (!(await vis(page, "#qtySec"))) return ["нет выбора количества"];
  const atMax = async () => qmsg(page);
  if (mx > 1 && (await atMax())) p.push("объяснение ограничения видно, хотя «+» доступна");
  if (mx > 1) { await page.click("#qp"); await page.evaluate((n) => { for (let c = 2; c < n; c++) document.getElementById("qp").click(); }, mx); }
  const q = Number(await txt(page, "#qv"));
  if (q !== mx) p.push(`дошли до ${q}, а не до ${mx}`);
  if (await isOn(page, "#qp")) p.push("«+» доступна на пределе");
  const m = await atMax();
  if (!m || !m.includes(String(mx))) p.push(`на пределе нет объяснения с числом ${mx}`);
  else if (stock ? !/налич/i.test(m) : !/заказ/i.test(m)) p.push(`объяснение «${m}» не про ${stock ? "наличие" : "лимит заказа"}`);
  const total = i.price * mx, sumB = await txt(page, "#sum b"), sum = await txt(page, "#sum");
  if (sumB !== norm(eur(total))) p.push(`итог «${sumB}» вместо ${norm(eur(total))}`);
  if (mx > 1 && !sum.includes(`${mx} × ${norm(eur(i.price))} · ${TC(k)}`)) p.push(`нет «${mx} × ${norm(eur(i.price))} · ${TC(k)}»`);
  if (k > 1 && mx > 1 && !sum.includes(`≈ ${norm(eur(total / k))} в мес. за весь заказ`)) p.push("нет месячного эквивалента всего заказа");
  const unitReq = o.req.find((r) => r.scope === "unit");
  if (unitReq && mx > 1 && !(await txt(page, "#req")).includes(`из ${mx} ${mx % 10 === 1 && mx % 100 !== 11 ? o.unit[1] : o.unit[2]}`)) p.push(`требование не учитывает ${mx} шт.`);
  await page.click("#toCart");
  if ((await txt(page, "#cartN")) !== String(mx)) p.push(`счётчик корзины ${await txt(page, "#cartN")} вместо ${mx}`);
  if (mx > 1) { await page.click("#qm"); await page.evaluate((n) => { for (let c = 2; c < n; c++) document.getElementById("qm").click(); }, mx); }
  if ((await txt(page, "#qv")) !== "1" || (await isOn(page, "#qm"))) p.push("не вернулись к 1 или «−» доступна на минимуме");
  if ((await txt(page, "#sum b")) !== norm(eur(i.price))) p.push("итог не пересчитан обратно");
  if (mx > 1 && (await atMax())) p.push("объяснение осталось после ухода с предела");
  return p;
}

/* ---------- 2. Переходы: однозначная модель (реестр А7) ---------- */
export async function transitionSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Автоматические изменения выбора", base);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(4000); watchErrors(page, rec, "переходы");
  const notice = async () => ((await vis(page, "#notice")) ? await txt(page, "#notice") : "");
  const pressed = () => page.evaluate(() => { const b = document.querySelector('#terms [aria-pressed="true"]'); return b ? +b.dataset.term : null; });
  const q = async () => ((await vis(page, "#qtySec")) ? Number(await txt(page, "#qv")) : null);
  // пояснение должно быть видно сразу после нажатия, без прокрутки (находка повторного аудита 21.10)
  const inView = () => page.evaluate(() => { const n = document.getElementById("notice"); if (!n || !n.offsetParent) return false; const r = n.getBoundingClientRect(); const x = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(10, r.height / 2)); return r.top >= 0 && r.bottom <= innerHeight && !!x && n.contains(x); });
  // смена тарифа — новый выбор с пояснением; возврат не восстанавливает
  for (const a of cat.tariffs) {
    let src = null;
    for (const o of offersOf(cat, a)) for (const k of termsOf(o)) if (!src && buyable(info(o, k)) && maxEff(o, info(o, k)) >= 2) src = { o, k };
    if (!src) continue;
    for (const b of cat.tariffs) {
      if (b === a) continue;
      const path = `?demo&t=${a}&o=${src.o.id}&term=${src.k}&q=2`;
      await go(page, base, path);
      await page.click(`#tariffs button[data-tariff="${b}"]`);
      const nt = await notice(), p = [];
      if (!nt) p.push("нет пояснения");
      else if (!(await inView())) p.push("пояснение за пределами экрана");
      const single = offersOf(cat, b).length === 1;
      const selN = await page.locator('.offer[aria-checked="true"]').count();
      if (!single && selN !== 0) p.push("способ остался выбранным");
      if (single && selN !== 1) p.push("единственный способ не выбран");
      if (single && (await q()) !== null && (await q()) !== 1) p.push("количество не сброшено");
      await page.click(`#tariffs button[data-tariff="${a}"]`);
      if (offersOf(cat, a).length > 1 && (await page.locator('.offer[aria-checked="true"]').count()) !== 0) p.push("возврат к тарифу восстановил прежний выбор");
      rec(`${a} (2 шт.) → ${b} → ${a}`, !p.length, p.join("; ") || nt, { url: path, sel: "#notice" });
    }
  }
  // внутри тарифа: срок, которого нет у нового способа, меняется с пояснением и восстанавливается при возврате
  for (const t of cat.tariffs) for (const a of offersOf(cat, t)) for (const ka of termsOf(a)) for (const b of offersOf(cat, t)) {
    if (a.id === b.id || info(b, ka)) continue;
    const path = `?demo&t=${t}&o=${a.id}&term=${ka}`;
    await go(page, base, path);
    await page.click(`.offer[data-offer-id="${b.id}"]`);
    const kb = preferTerm(b, ka), n1 = await notice(), t1 = await pressed(), seen = await inView();
    await page.click(`.offer[data-offer-id="${a.id}"]`);
    const n2 = await notice(), t2 = await pressed(), p = [];
    if (t1 !== kb || !n1.includes(`Срок изменён на ${TLG(kb)}`)) p.push(`к «${b.name}»: срок ${t1}, пояснение «${n1}»`);
    if (!seen) p.push("пояснение появилось за пределами экрана");
    if (t2 !== ka || !n2.includes(`Срок снова ${TLG(ka)}`)) p.push(`назад: срок ${t2}, пояснение «${n2}»`);
    rec(`${t}: ${a.name} ${TC(ka)} → ${b.name} → обратно`, !p.length, p.join("; "), { url: path, sel: "#notice" });
  }
  // количество ограничено наличием: уменьшение с пояснением, восстановление при возврате
  for (const o of cat.offers) for (const L of termsOf(o)) {
    const li = info(o, L); if (li.st !== "low" || li.left >= o.max) continue;
    const H = termsOf(o).find((h) => h !== L && buyable(info(o, h)) && maxEff(o, info(o, h)) > li.left);
    if (H == null) continue;
    const want = maxEff(o, info(o, H)), path = `?demo&t=${o.t}&o=${o.id}&term=${H}&q=${want}`;
    await go(page, base, path);
    await page.click(`#terms [data-term="${L}"]`);
    const n1 = await notice(), q1 = await q(), seenQ = await inView();
    await page.click(`#terms [data-term="${H}"]`);
    const n2 = await notice(), q2 = await q(), p = [];
    if (q1 !== li.left || !n1.includes(`уменьшено до ${li.left}`)) p.push(`на ${TC(L)}: количество ${q1}, пояснение «${n1}»`);
    if (!seenQ) p.push("пояснение за пределами экрана");
    if (q2 !== want || !n2.includes(`снова ${want}`)) p.push(`назад на ${TC(H)}: количество ${q2}, пояснение «${n2}»`);
    rec(`${o.t} · ${o.name}: ${TC(H)} → ${TC(L)} (в наличии ${li.left}) → обратно`, !p.length, p.join("; "), { url: path, sel: "#notice" });
  }
  await ctx.close();
}

/* ---------- 3. Листы, FAQ, служебный режим ---------- */
export async function uiSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Листы, вопросы и служебный режим", base);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(4000); watchErrors(page, rec, "листы");
  const cls = stateClasses(cat);

  await page.goto(U(base, ""));
  rec("Обычный адрес: тестовое меню скрыто", !(await vis(page, "#openDemo")), "", { url: "" });
  rec("Обычный адрес: пометка демо видна", (await txt(page, ".demo")).includes("Демо"), "", { url: "", sel: ".demo" });
  await page.goto(U(base, "?demo"));
  rec("Тестовый адрес ?demo: тестовое меню доступно", await vis(page, "#openDemo"), "", { url: "?demo", sel: "#openDemo" });

  const condCls = cls.find((c) => c.name === "sheet-cond");
  if (condCls) {
    const path = condCls.url.replace("&sheet=cond", "");
    await page.goto(U(base, path));
    const before = await txt(page, "#sum");
    await page.click("#openCond");
    const st = await page.evaluate(() => {
      const bar = document.getElementById("bar").getBoundingClientRect();
      const pg = document.getElementById("page"), wasInert = pg.hasAttribute("inert"); pg.removeAttribute("inert"); // inert скрывает элементы от поиска по точке
      const el = document.elementFromPoint(bar.left + bar.width / 2, Math.min(innerHeight - 2, bar.top + bar.height / 2));
      if (wasInert) pg.setAttribute("inert", "");
      const b = document.getElementById("shB");
      const can = b.scrollHeight > b.clientHeight; const prev = b.scrollTop; b.scrollTop = 99999; const moved = b.scrollTop > prev; b.scrollTop = 0;
      return { inert: wasInert, barCovered: !!el && !!el.closest("#scrim"), focus: document.activeElement && document.activeElement.id, can, moved, locked: document.body.classList.contains("locked") };
    });
    rec("Условия: лист открыт поверх, страница недоступна", st.inert && st.locked, JSON.stringify(st), { url: path, sel: ".sheet" });
    rec("Условия: панель покупки полностью закрыта листом", st.barCovered, "", { url: path, sel: "#bar" });
    rec("Условия: фокус на кнопке закрытия", st.focus === "shX", `фокус: ${st.focus}`, { url: path });
    rec("Условия: своя прокрутка содержимого", !st.can || st.moved, st.can ? "содержимое длиннее листа" : "содержимое помещается без прокрутки", { url: path, sel: "#shB" });
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => !!document.activeElement.closest("#scrim"));
    rec("Условия: Tab не выходит за пределы листа", inside, "", { url: path });
    await page.keyboard.press("Escape");
    const focus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    rec("Условия: Escape закрывает, фокус возвращается, выбор сохранён",
      !(await vis(page, "#scrim")) && focus === "openCond" && (await txt(page, "#sum")) === before, `фокус: ${focus}`, { url: path });
  }
  await page.goto(U(base, "?demo"));
  await page.click("#openTar");
  rec("Сравнить тарифы: лист открывается", await vis(page, "#scrim"), await txt(page, "#shT"), { url: "?demo", sel: ".sheet" });
  const cards = await page.locator("#shB .card").count();
  rec("Сравнить тарифы: карточка на каждый тариф из данных", cards === cat.tariffs.length, `${cards} из ${cat.tariffs.length}`, { url: "?demo", sel: "#shB" });
  await page.click("#shX");
  rec("Сравнить тарифы: ✕ закрывает, фокус возвращается", !(await vis(page, "#scrim")) && (await page.evaluate(() => document.activeElement.id)) === "openTar", "", { url: "?demo" });

  const nCls = cls.find((c) => c.name === "sheet-notify");
  if (nCls) {
    const path = nCls.url.replace("&sheet=notify", "");
    await page.goto(U(base, path));
    await page.click("#notifyBar");
    rec("Уведомить: форма открывается", await vis(page, "#nf"), "", { url: path, sel: ".sheet" });
    await page.click('#nf button[type="submit"]');
    rec("Уведомить: пустая почта не принимается", await vis(page, "#nfErr"), "", { url: path, sel: "#nf" });
    await page.fill("#nfEmail", "test@example.com"); await page.click('#nf button[type="submit"]');
    const t = await txt(page, "#shB");
    rec("Уведомить: честный демо-результат без обещаний", t.includes("Демо") && t.includes("не создана"), t, { url: path, sel: "#shB" });
    await page.mouse.click(5, 5);
    rec("Уведомить: закрывается нажатием на затемнение", !(await vis(page, "#scrim")), "", { url: path });
  }
  await page.goto(U(base, "?demo"));
  const nd = await page.locator("details").count(); let bad = 0;
  for (let i = 0; i < nd; i++) {
    const d = page.locator("details").nth(i);
    await d.locator("summary").click(); const o1 = await d.evaluate((e) => e.open);
    await d.locator("summary").click(); const o2 = await d.evaluate((e) => e.open);
    if (!o1 || o2) bad++;
  }
  rec(`Вопросы: ${nd} пунктов раскрываются и закрываются`, nd > 0 && bad === 0, bad ? `${bad} не работают` : "", { url: "?demo", sel: "details" });
  await ctx.close();
}

/* ---------- 4. Отображение: правила на всех ширинах WIDTHS ---------- */
export const WIDTHS = [320, 390, 480, 600, 768, 900, 1280, 1440];
export async function layoutSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Отображение", base);
  const cls = stateClasses(cat);
  let checked = 0;
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 820 ? 740 : 900 }, reducedMotion: "reduce" });
    const page = await ctx.newPage(); page.setDefaultTimeout(4000); watchErrors(page, rec, `${w}px`);
    for (const c of cls) {
      await go(page, base, c.url);
      const issues = await page.evaluate(layoutIssues);
      checked++;
      if (!issues.length) rec(`${w}px · ${c.title}`, true, "", { url: c.url, width: w });
      else for (const it of issues.slice(0, 6)) rec(`${w}px · ${c.title}: ${it.type}`, false, it.detail, { url: c.url, width: w, sel: it.sel });
    }
    await ctx.close();
  }
  return checked;
}

// Выполняется внутри страницы. Возвращает найденные нарушения с селектором элемента.
function layoutIssues() {
  const out = [], vw = document.documentElement.clientWidth, vh = innerHeight;
  const path = (el) => { if (el.id) return "#" + el.id; const p = []; while (el && el.nodeType === 1 && el !== document.body) { let s = el.tagName.toLowerCase(); if (el.id) { p.unshift("#" + el.id); break; } const sib = [...el.parentNode.children].filter((x) => x.tagName === el.tagName); if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(el) + 1})`; p.unshift(s); el = el.parentNode; } return p.join(" > "); };
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden"; };
  const sheetOpen = !document.getElementById("scrim").hidden;
  if (document.documentElement.scrollWidth > vw) out.push({ type: "горизонтальная прокрутка", sel: "html", detail: `ширина содержимого ${document.documentElement.scrollWidth} при экране ${vw}` });
  const scope = sheetOpen ? document.querySelectorAll(".sheet *") : document.querySelectorAll(".page *");
  for (const el of scope) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 0.5 || r.left < -0.5) { out.push({ type: "элемент выходит за край экрана", sel: path(el), detail: `${Math.round(r.left)}…${Math.round(r.right)} при ширине ${vw}` }); continue; }
    const cs = getComputedStyle(el);
    const clips = cs.overflowX !== "visible" || cs.textOverflow === "ellipsis";
    if (clips && el.scrollWidth > el.clientWidth + 1 && !["sheet-b"].includes(el.className) && el.tagName !== "INPUT")
      out.push({ type: "обрезанное содержимое", sel: path(el), detail: `«${el.innerText.slice(0, 60)}» не помещается` });
  }
  const inter = (a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return x.left < y.right - 0.5 && y.left < x.right - 0.5 && x.top < y.bottom - 0.5 && y.top < x.bottom - 0.5; };
  const pair = (a, b, what) => { if (a && b && shown(a) && shown(b) && inter(a, b)) out.push({ type: "перекрытие", sel: path(a), detail: what }); };
  document.querySelectorAll(".offer").forEach((o) => pair(o.querySelector(".on"), o.querySelector(".op"), `название и цена в «${o.querySelector(".on").innerText}»`));
  pair(document.querySelector(".sum"), document.querySelector(".acts"), "итог и кнопки в панели");
  pair(document.querySelector(".logo"), document.querySelector(".hdr .ib"), "логотип и значки шапки");
  // читаемость (Г-03): видимый текст не меньше 13 px, контраст не ниже 4,5:1
  const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; const a = c.match(/[\d.]+/g); if (a && (a.length < 4 || +a[3] > 0.9)) return c; } return "rgb(255,255,255)"; };
  const tw = document.createTreeWalker(document.querySelector(sheetOpen ? ".sheet" : ".page"), NodeFilter.SHOW_TEXT);
  const seenEl = new Set();
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const el = n.parentElement; if (!n.textContent.trim() || seenEl.has(el) || !shown(el)) continue; seenEl.add(el);
    if (el.closest("#openDemo, .demo")) continue; // служебная строка демо
    const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize);
    if (fs < 13) out.push({ type: "текст мельче 13 px", sel: path(el), detail: `${fs}px: «${n.textContent.trim().slice(0, 40)}»` });
    if (el.closest(":disabled, [aria-disabled=true]")) continue; // неактивные элементы — исключение WCAG
    const L1 = lum(cs.color), L2 = lum(bgOf(el)); const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (cr < 4.5) out.push({ type: "низкий контраст текста", sel: path(el), detail: `${cr.toFixed(2)}:1 «${n.textContent.trim().slice(0, 40)}»` });
  }
  // сенсорные цели (Г-11): кнопки, строки выбора, раскрывашки — не меньше 44 × 44 (текстовые ссылки внутри предложения — исключение)
  for (const el of (sheetOpen ? document.querySelectorAll(".sheet button, .sheet input") : document.querySelectorAll(".page button, .page [role=radio], .page summary"))) {
    if (!shown(el) || el.closest(".help, .demo")) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5) out.push({ type: "сенсорная цель меньше 44 px", sel: path(el), detail: `${Math.round(r.width)}×${Math.round(r.height)} «${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30)}»` });
  }
  document.querySelectorAll(".seg button, .term").forEach((b) => { if (shown(b) && b.scrollWidth > b.clientWidth + 1) out.push({ type: "обрезанная подпись сегмента", sel: path(b), detail: b.innerText.replace(/\s+/g, " ") }); });
  if (sheetOpen) {
    const s = document.querySelector(".sheet").getBoundingClientRect();
    if (s.top < 0 || s.bottom > vh + 1) out.push({ type: "лист не помещается в экран", sel: ".sheet", detail: `${Math.round(s.top)}…${Math.round(s.bottom)} при высоте ${vh}` });
    const x = document.getElementById("shX").getBoundingClientRect();
    if (x.top < 0 || x.right > vw) out.push({ type: "кнопка закрытия листа не видна", sel: "#shX", detail: "" });
    const bar = document.getElementById("bar").getBoundingClientRect();
    const pg = document.getElementById("page"), wasInert = pg.hasAttribute("inert"); pg.removeAttribute("inert");
    const el = document.elementFromPoint(bar.left + bar.width / 2, Math.min(vh - 2, Math.max(1, bar.top + bar.height / 2)));
    if (wasInert) pg.setAttribute("inert", "");
    if (el && !el.closest("#scrim")) out.push({ type: "панель покупки видна поверх листа", sel: "#bar", detail: "" });
  } else {
    const doc = document.documentElement, desk = vw >= 820, bar = document.getElementById("bar");
    const before = desk ? [...document.querySelectorAll("#purchase > *")].filter((e) => e !== bar && shown(e)).pop() : document.querySelector(".about");
    // закрепление: прокручиваем так, чтобы конец содержимого перед панелью был ниже экрана
    window.scrollTo(0, 0);
    const endY = before.getBoundingClientRect().bottom + scrollY;
    const startY = (desk ? document.getElementById("purchase") : document.querySelector(".pdp")).getBoundingClientRect().top + scrollY;
    if (endY - startY > vh) {
      window.scrollTo(0, Math.max(0, Math.min(endY - vh - 80, startY + 40)));
      const b = bar.getBoundingClientRect();
      if (Math.abs(b.bottom - vh) > 1.5) out.push({ type: "панель покупки не закреплена при прокрутке", sel: "#bar", detail: `низ панели ${Math.round(b.bottom)} при высоте ${vh}` });
    }
    window.scrollTo(0, doc.scrollHeight);
    const b = bar.getBoundingClientRect(), m = before.getBoundingClientRect();
    if (b.top < m.bottom - 0.5) out.push({ type: "панель перекрывает конец содержимого", sel: "#bar", detail: `верх панели ${Math.round(b.top)}, конец содержимого ${Math.round(m.bottom)}` });
    if (b.top - m.bottom > 60) out.push({ type: "большой разрыв перед панелью", sel: "#bar", detail: `${Math.round(b.top - m.bottom)} px` });
    window.scrollTo(0, 0);
  }
  return out;
}
