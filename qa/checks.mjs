// Проверки страницы товара. Набор строится из данных каталога, а ожидаемые значения считает oracle.mjs.
import { U, go, TL, TLG, eur, norm, offersOf, termsOf, tariffTerms, info, buyable, maxEff, autoTerm, minPrice, stateClasses } from "./oracle.mjs";

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

/* ---------- 1. Логика каталога: каждое предложение × каждый срок тарифа ---------- */
export async function logicSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Логика выбора и цены", base);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(4000); watchErrors(page, rec, "логика");
  let n = 0;
  for (const t of cat.tariffs) {
    const terms = tariffTerms(cat, t);
    for (const term of terms) {
      const path = `?demo&t=${encodeURIComponent(t)}&term=${term}`;
      await go(page, base, path, term === terms[0]); // первый срок тарифа — настоящая загрузка, дальше — мгновенный сброс
      // строки предложений без выбора
      const rows = await page.$$eval(".offer", (els) => els.map((e) => ({ id: e.dataset.offerId, text: e.innerText, checked: e.getAttribute("aria-checked") })));
      const exp = offersOf(cat, t);
      rec(`${t} · ${TL(term)}: показаны все предложения тарифа`, rows.map((r) => r.id).join() === exp.map((o) => o.id).join(), `ожидалось ${exp.length}, на странице ${rows.length}`, { url: path, sel: "#offers" });
      for (const o of exp) {
        const r = rows.find((x) => x.id === o.id); if (!r) continue;
        const problems = rowProblems(o, term, norm(r.text), false); n++;
        rec(`${t} · ${o.name} · ${TL(term)}: строка предложения`, !problems.length, problems.join("; ") || norm(r.text), { url: path, sel: `.offer[data-offer-id="${o.id}"]` });
      }
      const mp = minPrice(cat, t, term), sum = await txt(page, "#sum");
      const okBar = mp != null ? sum.includes(`от ${norm(eur(mp))}`) && sum.includes(`за ${TL(term)}`) : sum.includes("Нет доступных");
      rec(`${t} · ${TL(term)}: панель без выбора`, okBar && (await dis(page, "#toCart")) && (await dis(page, "#buyNow")), `«${sum}», кнопки должны быть неактивны`, { url: path, sel: "#bar" });

      // выбор каждого предложения
      for (const o of exp) {
        await go(page, base, path);
        await page.click(`.offer[data-offer-id="${o.id}"]`);
        const k = info(o, term) ? term : autoTerm(o);
        const notice = (await vis(page, "#notice")) ? await txt(page, "#notice") : "";
        const label = `${t} · ${o.name} @${TL(term)}`;
        if (k !== term) rec(`${label}: срок переключён с пояснением`, notice.includes(`Срок изменён на ${TL(k)}`), `пояснение: «${notice}»`, { url: path, sel: "#notice" });
        else rec(`${label}: выбор без лишних пояснений`, !notice, notice ? `неожиданное пояснение «${notice}»` : "", { url: path, sel: "#notice" });
        const sp = await selectedProblems(page, cat, o, k);
        rec(`${label}: выбранное состояние (${TL(k)})`, !sp.length, sp.join("; "), { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: ".before" });
        const i = info(o, k);
        if (buyable(i) && maxEff(o, i) > 1) {
          const qp = await qtyProblems(page, o, k);
          rec(`${label}: количество и итог`, !qp.length, qp.join("; "), { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: "#qtyRow" });
        } else {
          rec(`${label}: количество скрыто, когда не нужно`, !(await vis(page, "#qtyRow")), "", { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: "#qtyRow" });
        }
      }
    }
  }
  await ctx.close();
  return n;
}

function rowProblems(o, term, text, selected) {
  const p = [], i = info(o, term), has = (s) => text.includes(norm(s));
  if (!text.includes(norm(o.name))) p.push(`нет названия «${o.name}»`);
  if (!i) {
    if (!has("Не продаётся") || !has(`на ${TL(term)}`)) p.push(`нет «Не продаётся на ${TL(term)}»`);
    const list = termsOf(o).map(TL).join(", ");
    if (!has(`Есть на ${list}`)) p.push(`нет «Есть на ${list}»`);
    if (text.includes("€")) p.push("показана цена для непродаваемого срока");
  } else if (buyable(i)) {
    if (!has(eur(i.price))) p.push(`нет цены ${norm(eur(i.price))}`);
    if (!has(`за ${TL(term)}`)) p.push(`цена не подписана «за ${TL(term)}»`);
    if (i.st === "low" && !has(`Осталось ${i.left}`)) p.push(`нет «Осталось ${i.left}»`);
    if (i.st !== "low" && has("Осталось")) p.push("лишняя пометка остатка");
  } else {
    const head = i.st === "out" ? "Нет в наличии" : "Ожидается";
    if (!has(head) || !has(`на ${TL(term)}`)) p.push(`нет «${head} на ${TL(term)}»`);
    if (i.st === "soon" && !has(i.eta ? `Ожидается ${i.eta}` : "Срок поступления уточняется")) p.push("нет прогноза или «Срок поступления уточняется»");
    if (!selected && !has("Уведомить")) p.push("нет кнопки «Уведомить»");
    if (text.includes("€")) p.push("показана цена недоступного срока");
  }
  return p;
}

async function selectedProblems(page, cat, o, k) {
  const p = [], i = info(o, k);
  const checked = await page.getAttribute(`.offer[data-offer-id="${o.id}"]`, "aria-checked");
  if (checked !== "true") p.push("строка не отмечена выбранной");
  const pressed = await page.getAttribute(`#terms button[data-term="${k}"]`, "aria-pressed");
  if (pressed !== "true") p.push(`не выбран срок ${TL(k)}`);
  const title = await txt(page, "#hB");
  if (title !== norm(`${o.t} · ${o.name} · ${TL(k)}`)) p.push(`заголовок блока «${title}»`);
  const facts = await txt(page, "#facts");
  if (!facts.includes("Вы получите") || !facts.includes(`на ${TLG(k)}`)) p.push("нет «Вы получите … на срок»");
  const reqFirst = o.req.length ? o.req[0].text : "Только почта для получения заказа";
  if (!facts.includes("От вас") || !facts.toLowerCase().includes(norm(reqFirst).toLowerCase())) p.push(`нет требования «${reqFirst}»`);
  if (o.limits.length && (!facts.includes("Важно") || !facts.includes(norm(o.limits[0])))) p.push("нет главного ограничения в «Важно»");
  const sumB = await txt(page, "#sum b"), sum = await txt(page, "#sum");
  if (buyable(i)) {
    if (sumB !== norm(eur(i.price))) p.push(`итог «${sumB}» вместо ${norm(eur(i.price))}`);
    if (!sum.includes(`за ${TL(k)}`)) p.push("итог не подписан сроком");
    if (k > 1 && !sum.includes(`≈ ${norm(eur(i.price / k))}/мес`)) p.push(`нет «≈ ${norm(eur(i.price / k))}/мес»`);
    if (await dis(page, "#toCart")) p.push("«В корзину» неактивна");
    if (!(await vis(page, "#buyNow")) || (await dis(page, "#buyNow"))) p.push("«Купить сейчас» недоступна");
    if (await vis(page, "#notifyBar")) p.push("лишняя «Уведомить» в панели");
    if (facts.includes("Наличие")) p.push("лишняя строка «Наличие»");
  } else {
    const head = i.st === "out" ? "Нет в наличии" : "Ожидается";
    if (sumB !== head) p.push(`панель «${sumB}» вместо «${head}»`);
    if (await vis(page, "#buyNow")) p.push("«Купить сейчас» видна у недоступного");
    if (!(await dis(page, "#toCart"))) p.push("«В корзину» активна у недоступного");
    if (!(await vis(page, "#notifyBar"))) p.push("нет «Уведомить» в панели");
    const av = i.st === "soon" ? (i.eta ? `Ожидается ${i.eta}` : "Срок поступления уточняется") : `Нет в наличии на ${TL(k)}`;
    if (!facts.includes("Наличие") || !facts.includes(norm(av))) p.push(`нет «Наличие: ${av}»`);
  }
  for (const m of tariffTerms(cat, o.t)) {
    const b = page.locator(`#terms button[data-term="${m}"]`);
    const bt = norm(await b.innerText()), bd = await b.isDisabled(), mi = info(o, m);
    const expTxt = !mi ? "не продаётся" : mi.st === "out" ? "нет в наличии" : mi.st === "soon" ? "ожидается" : mi.st === "low" ? `осталось ${mi.left}` : "";
    if (!mi && !bd) p.push(`срок ${TL(m)} не продаётся, но активен`);
    if (mi && bd) p.push(`срок ${TL(m)} продаётся, но неактивен`);
    if (expTxt && !bt.includes(expTxt)) p.push(`у срока ${TL(m)} нет подписи «${expTxt}»`);
    if (!expTxt && bt !== TL(m)) p.push(`у срока ${TL(m)} лишняя подпись «${bt}»`);
  }
  return p;
}

async function qtyProblems(page, o, k) {
  const p = [], i = info(o, k), mx = maxEff(o, i);
  if (!(await vis(page, "#qtyRow"))) return ["нет выбора количества"];
  const hint = await txt(page, "#qtyHint");
  if (!hint.includes(`максимум ${mx}`)) p.push(`подсказка «${hint}» вместо максимума ${mx}`);
  if (i.st === "low" && !hint.includes("осталось")) p.push("подсказка не объясняет остаток");
  if (mx > 1) { await page.click("#qp"); await page.evaluate((n) => { for (let c = 2; c < n; c++) document.getElementById("qp").click(); }, mx); } // первое — настоящее нажатие
  const q = Number(await txt(page, "#qv"));
  if (q !== mx) p.push(`дошли до ${q}, а не до ${mx}`);
  if (!(await dis(page, "#qp"))) p.push("«+» активна на максимуме");
  const total = i.price * mx, sumB = await txt(page, "#sum b"), sum = await txt(page, "#sum");
  if (sumB !== norm(eur(total))) p.push(`итог «${sumB}» вместо ${norm(eur(total))}`);
  if (!sum.includes(`${mx} × ${norm(eur(i.price))}`)) p.push(`нет «${mx} × ${norm(eur(i.price))}»`);
  if (k > 1 && !sum.includes(`итого ≈ ${norm(eur(total / k))}/мес`)) p.push(`нет «итого ≈ ${norm(eur(total / k))}/мес»`);
  const unitReq = o.req.find((r) => r.scope === "unit");
  if (unitReq) { const f = await txt(page, "#facts"); if (!f.includes(`из ${mx} ${o.unit[2]}`)) p.push(`требование не учитывает ${mx} шт.`); }
  await page.click("#toCart");
  const badge = await txt(page, "#cartN");
  if (badge !== String(mx)) p.push(`счётчик корзины ${badge} вместо ${mx}`);
  if (mx > 1) { await page.click("#qm"); await page.evaluate((n) => { for (let c = 2; c < n; c++) document.getElementById("qm").click(); }, mx); }
  if ((await txt(page, "#qv")) !== "1" || !(await dis(page, "#qm"))) p.push("не вернулись к 1 или «−» активна");
  if ((await txt(page, "#sum b")) !== norm(eur(i.price))) p.push("итог не пересчитан обратно");
  return p;
}

/* ---------- 2. Переходы: смена тарифа и остатка не меняет выбор незаметно ---------- */
export async function transitionSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Автоматические изменения выбора", base);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(4000); watchErrors(page, rec, "переходы");
  for (const a of cat.tariffs) {
    let src = null;
    for (const o of offersOf(cat, a)) for (const k of termsOf(o)) if (!src && buyable(info(o, k)) && maxEff(o, info(o, k)) >= 2) src = { o, k };
    if (!src) continue;
    for (const b of cat.tariffs) {
      if (b === a) continue;
      const path = `?demo&t=${a}&o=${src.o.id}&term=${src.k}&q=2`;
      await go(page, base, path);
      await page.click(`#tariffs button[data-tariff="${b}"]`);
      const notice = (await vis(page, "#notice")) ? await txt(page, "#notice") : "";
      const p = [];
      if (!notice.includes("Предложение сброшено")) p.push("нет пояснения о сбросе предложения");
      const bt = tariffTerms(cat, b);
      if (!bt.includes(src.k) && !notice.includes(`Срок изменён на ${TL(bt[0])}`)) p.push("нет пояснения о смене срока");
      if (!notice.includes("Количество сброшено до 1")) p.push("нет пояснения о сбросе количества");
      if ((await page.locator('.offer[aria-checked="true"]').count()) !== 0) p.push("предложение осталось выбранным");
      rec(`${a} (2 шт., ${TL(src.k)}) → ${b}`, !p.length, p.join("; ") || notice, { url: path, sel: "#notice" });
    }
  }
  for (const o of cat.offers) for (const L of termsOf(o)) {
    const li = info(o, L); if (li.st !== "low") continue;
    const H = termsOf(o).find((h) => h !== L && buyable(info(o, h)) && maxEff(o, info(o, h)) > li.left);
    if (H == null) continue;
    const path = `?demo&t=${o.t}&o=${o.id}&term=${H}&q=${maxEff(o, info(o, H))}`;
    await go(page, base, path);
    await page.click(`#terms button[data-term="${L}"]`);
    const notice = (await vis(page, "#notice")) ? await txt(page, "#notice") : "";
    const q = await txt(page, "#qv");
    rec(`${o.t} · ${o.name}: ${TL(H)} → ${TL(L)} с остатком ${li.left}`, q === String(li.left) && notice.includes(`уменьшено до ${li.left}`), `количество ${q}, пояснение «${notice}»`, { url: path, sel: "#notice" });
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
  rec("Обычный адрес: пометка демо видна", (await txt(page, ".demo")).includes("Демо-прототип"), "", { url: "", sel: ".demo" });
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

/* ---------- 4. Отображение: правила на 320, 390 и 1280 px ---------- */
export const WIDTHS = [320, 390, 1280];
export async function layoutSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Отображение", base);
  const cls = stateClasses(cat);
  let checked = 0;
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 1000 ? 740 : 900 }, reducedMotion: "reduce" });
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
  document.querySelectorAll(".seg button").forEach((b) => { if (shown(b) && b.scrollWidth > b.clientWidth + 1) out.push({ type: "обрезанная подпись сегмента", sel: path(b), detail: b.innerText.replace(/\s+/g, " ") }); });
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
    const doc = document.documentElement;
    if (doc.scrollHeight > vh + 50) { // длинная страница: панель прилипает к низу экрана
      window.scrollTo(0, Math.round((doc.scrollHeight - vh) / 2));
      const b = document.getElementById("bar").getBoundingClientRect();
      if (Math.abs(b.bottom - vh) > 1.5) out.push({ type: "панель покупки не закреплена при прокрутке", sel: "#bar", detail: `низ панели ${Math.round(b.bottom)} при высоте ${vh}` });
    }
    window.scrollTo(0, doc.scrollHeight);
    const b = document.getElementById("bar").getBoundingClientRect(), m = document.querySelector("main").getBoundingClientRect();
    if (b.top < m.bottom - 0.5) out.push({ type: "панель перекрывает конец страницы", sel: "#bar", detail: `верх панели ${Math.round(b.top)}, конец содержимого ${Math.round(m.bottom)}` });
    if (b.top - m.bottom > 60) out.push({ type: "большой разрыв перед панелью", sel: "#bar", detail: `${Math.round(b.top - m.bottom)} px` });
    window.scrollTo(0, 0);
  }
  return out;
}
