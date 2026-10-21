// Проверки страницы товара. Набор строится из данных каталога, а ожидаемые значения считает oracle.mjs.
import { U, go, TL, eur, norm, offersOf, termsOf, tariffTerms, info, buyable, maxEff, buyTerms, fromPrice, offerStatus, preferTerm, minFrom, stateClasses } from "./oracle.mjs";

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

/* ---------- 1. Логика каталога: тариф → способ доступа → срок → количество, по всем данным ---------- */
const opText = (o) => { const fp = fromPrice(o); return fp == null ? offerStatus(o) : (termsOf(o).length > 1 ? "от " : "") + norm(eur(fp)); };

export async function logicSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Логика выбора и цены", base);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(4000); watchErrors(page, rec, "логика");
  let n = 0, first = true;
  for (const t of cat.tariffs) {
    const path = `?demo&t=${encodeURIComponent(t)}`;
    await go(page, base, path, first); first = false;
    const rows = await page.$$eval(".offer", (els) => els.map((e) => ({ id: e.dataset.offerId, on: e.querySelector(".on").innerText, op: e.querySelector(".op").innerText, of: e.querySelector(".of").innerText, more: !!e.querySelector(".more") })));
    const exp = offersOf(cat, t);
    rec(`${t}: показаны все способы доступа, включая недоступные`, rows.map((r) => r.id).join() === exp.map((o) => o.id).join(), `ожидалось ${exp.length}, на странице ${rows.length}`, { url: path, sel: "#offers" });
    for (const o of exp) {
      const r = rows.find((x) => x.id === o.id); if (!r) continue;
      const p = [];
      if (norm(r.on) !== norm(o.name)) p.push(`название «${r.on}»`);
      if (norm(r.of) !== norm(o.fact)) p.push("нет короткого описания");
      if (norm(r.op) !== opText(o)) p.push(`справа «${norm(r.op)}» вместо «${opText(o)}»`);
      if (r.more) p.push("подробности видны у невыбранного способа");
      rec(`${t} · ${o.name}: строка способа доступа`, !p.length, p.join("; ") || norm(r.op), { url: path, sel: `.offer[data-offer-id="${o.id}"]` });
    }
    const termHidden = !(await vis(page, "#termSec")) && !(await vis(page, "#qtySec")) && !(await vis(page, "#req"));
    rec(`${t}: до выбора способа сроков, количества и требований нет`, termHidden, "", { url: path, sel: "#termSec" });
    const mf = minFrom(cat, t), sum = await txt(page, "#sum");
    const okBar = mf != null ? sum.includes(`от ${norm(eur(mf))}`) && sum.includes("Выберите способ доступа") : sum.includes("Нет в наличии");
    rec(`${t}: панель без выбора`, okBar && (await dis(page, "#toCart")) && (await dis(page, "#buyNow")), `«${sum}», кнопки должны быть неактивны`, { url: path, sel: "#bar" });

    for (const o of exp) {
      await go(page, base, path);
      await page.click(`.offer[data-offer-id="${o.id}"]`);
      const k0 = preferTerm(o, 1); // в прототипе по умолчанию 1 мес; способ без 1 мес получает свой срок без пояснения (раньше способ не был выбран)
      for (const k of termsOf(o)) {
        if (k !== k0) await page.click(`#terms button[data-term="${k}"]`);
        n++;
        const label = `${t} · ${o.name} · ${TL(k)}`;
        const sp = await selectedProblems(page, cat, o, k);
        rec(`${label}: выбранное состояние`, !sp.length, sp.join("; "), { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: "#purchase" });
        const i = info(o, k);
        if (buyable(i) && maxEff(o, i) > 1) {
          const qp = await qtyProblems(page, o, k);
          rec(`${label}: количество и итог`, !qp.length, qp.join("; "), { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: "#qtySec" });
          await go(page, base, `?demo&t=${t}&o=${o.id}&term=${k}`);
        } else rec(`${label}: количество скрыто, когда не нужно`, !(await vis(page, "#qtySec")), "", { url: `?demo&t=${t}&o=${o.id}&term=${k}`, sel: "#qtySec" });
      }
    }
  }
  await ctx.close();
  return n;
}

async function selectedProblems(page, cat, o, k) {
  const p = [], i = info(o, k), anyBuy = buyTerms(o).length > 0;
  const row = `.offer[data-offer-id="${o.id}"]`;
  if ((await page.getAttribute(row, "aria-checked")) !== "true") p.push("строка не отмечена выбранной");
  if ((await page.locator('.offer[aria-checked="true"]').count()) !== 1) p.push("выбрано не одно значение");
  const more = await txt(page, `${row} .more`);
  if (o.limits.length && !more.includes(norm(o.limits[0]))) p.push("ограничение не видно в выбранной строке");
  if ((more.match(/Важно:/g) || []).length > 1) p.push("«Важно:» повторяется");
  if (!(await vis(page, "#openCond"))) p.push("нет ссылки «Все условия»");
  // сроки: только сроки этого способа, точная цена у доступных
  const terms = await page.$$eval("#terms button", (els) => els.map((e) => ({ k: +e.dataset.term, text: e.innerText, pressed: e.getAttribute("aria-pressed") })));
  if (terms.map((x) => x.k).join() !== termsOf(o).join()) p.push(`сроки ${terms.map((x) => x.k).join(",")} вместо ${termsOf(o).join(",")}`);
  for (const b of terms) {
    const bi = info(o, b.k), bt = norm(b.text);
    if (b.pressed !== String(b.k === k)) p.push(`у срока ${TL(b.k)} неверная отметка выбора`);
    if (bi && buyable(bi)) {
      if (!bt.includes(norm(eur(bi.price)))) p.push(`у срока ${TL(b.k)} нет цены ${norm(eur(bi.price))}`);
      if (b.k > 1 && !bt.includes(`≈ ${norm(eur(bi.price / b.k))}/мес`)) p.push(`у срока ${TL(b.k)} нет «≈ ${norm(eur(bi.price / b.k))}/мес»`);
      if (/наличии|Ожидается|осталось/i.test(bt)) p.push(`у доступного срока ${TL(b.k)} лишняя пометка`);
    } else if (bi) {
      const st = bi.st === "out" ? "Нет в наличии" : "Ожидается";
      if (anyBuy && !bt.includes(st)) p.push(`у срока ${TL(b.k)} нет «${st}»`);
      if (!anyBuy && bt !== TL(b.k)) p.push(`у срока ${TL(b.k)} повтор статуса, хотя он уже в строке способа`);
      if (bt.includes("€")) p.push(`у недоступного срока ${TL(b.k)} показана цена`);
    }
  }
  // требования — одной фразой
  const req = await txt(page, "#req");
  const r0 = o.req.length ? o.req[0].text : "только почта для получения заказа";
  if (!req.startsWith("Понадобится:") || !req.toLowerCase().includes(norm(r0).toLowerCase())) p.push(`нет «Понадобится: ${r0}»`);
  // панель и альтернативы
  const sumB = await txt(page, "#sum b"), sum = await txt(page, "#sum");
  const altVis = await vis(page, "#alt");
  if (buyable(i)) {
    if (sumB !== norm(eur(i.price))) p.push(`итог «${sumB}» вместо ${norm(eur(i.price))}`);
    if (!sum.includes(`за ${TL(k)}`)) p.push("итог не подписан сроком");
    if (await dis(page, "#toCart")) p.push("«В корзину» неактивна");
    if (!(await vis(page, "#buyNow")) || (await dis(page, "#buyNow"))) p.push("«Купить сейчас» недоступна");
    if (await vis(page, "#notifyBar")) p.push("лишняя «Уведомить»");
    if (altVis) p.push("альтернативы показаны у доступного варианта");
  } else {
    const head = i.st === "out" ? "Нет в наличии" : "Ожидается";
    if (sumB !== head) p.push(`панель «${sumB}» вместо «${head}»`);
    if (i.st === "soon" && !sum.includes(i.eta ? i.eta : "срок уточняется")) p.push("в панели нет прогноза или «срок уточняется»");
    if (await vis(page, "#buyNow")) p.push("«Купить сейчас» видна у недоступного");
    if (!(await dis(page, "#toCart"))) p.push("«В корзину» активна у недоступного");
    if (!(await vis(page, "#notifyBar"))) p.push("нет «Уведомить»");
    // альтернативы: другие доступные сроки этого способа, иначе доступные способы тарифа
    const bt = buyTerms(o), others = offersOf(cat, o.t).filter((x) => x.id !== o.id && fromPrice(x) != null);
    const altTxt = await txt(page, "#alt");
    if (bt.length) { for (const m of bt) if (!altTxt.includes(`${TL(m)} · ${norm(eur(info(o, m).price))}`)) p.push(`нет альтернативы «${TL(m)}»`); }
    else if (others.length) { for (const x of others) if (!altTxt.includes(norm(x.name))) p.push(`нет альтернативы «${x.name}»`); }
    else if (altVis) p.push("показаны альтернативы, которых нет");
  }
  return p;
}

async function qtyProblems(page, o, k) {
  const p = [], i = info(o, k), mx = maxEff(o, i);
  if (!(await vis(page, "#qtySec"))) return ["нет выбора количества"];
  const hint = await txt(page, "#qtyHint");
  const expHint = i.st === "low" && i.left <= o.max ? `сейчас доступно ${mx}` : `не больше ${mx} в заказе`;
  if (hint !== expHint) p.push(`подсказка «${hint}» вместо «${expHint}»`);
  if (mx > 1) { await page.click("#qp"); await page.evaluate((n) => { for (let c = 2; c < n; c++) document.getElementById("qp").click(); }, mx); }
  const q = Number(await txt(page, "#qv"));
  if (q !== mx) p.push(`дошли до ${q}, а не до ${mx}`);
  if (!(await dis(page, "#qp"))) p.push("«+» активна на максимуме");
  const total = i.price * mx, sumB = await txt(page, "#sum b"), sum = await txt(page, "#sum");
  if (sumB !== norm(eur(total))) p.push(`итог «${sumB}» вместо ${norm(eur(total))}`);
  if (!sum.includes(`${mx} × ${norm(eur(i.price))} · ${TL(k)}`)) p.push(`нет «${mx} × ${norm(eur(i.price))} · ${TL(k)}»`);
  const unitReq = o.req.find((r) => r.scope === "unit");
  if (unitReq && !(await txt(page, "#req")).includes(`из ${mx} ${o.unit[2]}`)) p.push(`требование не учитывает ${mx} шт.`);
  await page.click("#toCart");
  if ((await txt(page, "#cartN")) !== String(mx)) p.push(`счётчик корзины ${await txt(page, "#cartN")} вместо ${mx}`);
  if (mx > 1) { await page.click("#qm"); await page.evaluate((n) => { for (let c = 2; c < n; c++) document.getElementById("qm").click(); }, mx); }
  if ((await txt(page, "#qv")) !== "1" || !(await dis(page, "#qm"))) p.push("не вернулись к 1 или «−» активна");
  if ((await txt(page, "#sum b")) !== norm(eur(i.price))) p.push("итог не пересчитан обратно");
  return p;
}

/* ---------- 2. Переходы: выбор не меняется незаметно ---------- */
export async function transitionSuite(browser, cat, base, results) {
  const rec = makeRec(results, "Автоматические изменения выбора", base);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(4000); watchErrors(page, rec, "переходы");
  const notice = async () => ((await vis(page, "#notice")) ? await txt(page, "#notice") : "");
  // смена тарифа при выбранном способе и 2 шт.
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
      if (!nt.includes("Способ доступа сброшен")) p.push("нет пояснения о сбросе способа доступа");
      if (!nt.includes("Количество сброшено до 1")) p.push("нет пояснения о сбросе количества");
      if ((await page.locator('.offer[aria-checked="true"]').count()) !== 0) p.push("способ остался выбранным");
      if (await vis(page, "#termSec")) p.push("сроки видны без выбранного способа");
      rec(`${a} (2 шт.) → ${b}`, !p.length, p.join("; ") || nt, { url: path, sel: "#notice" });
    }
  }
  // смена способа: срок, которого у нового способа нет, меняется с пояснением
  for (const t of cat.tariffs) for (const a of offersOf(cat, t)) for (const ka of termsOf(a)) for (const b of offersOf(cat, t)) {
    if (a.id === b.id || info(b, ka)) continue;
    const path = `?demo&t=${t}&o=${a.id}&term=${ka}`;
    await go(page, base, path);
    await page.click(`.offer[data-offer-id="${b.id}"]`);
    const kb = preferTerm(b, ka), nt = await notice();
    const pressed = await page.getAttribute(`#terms button[data-term="${kb}"]`, "aria-pressed").catch(() => null);
    rec(`${t}: ${a.name} ${TL(ka)} → ${b.name}`, pressed === "true" && nt.includes(`Срок изменён на ${TL(kb)}`), `срок ${kb}: ${pressed}; пояснение «${nt}»`, { url: path, sel: "#notice" });
  }
  // смена срока с ограниченным количеством
  for (const o of cat.offers) for (const L of termsOf(o)) {
    const li = info(o, L); if (li.st !== "low") continue;
    const H = termsOf(o).find((h) => h !== L && buyable(info(o, h)) && maxEff(o, info(o, h)) > li.left);
    if (H == null) continue;
    const path = `?demo&t=${o.t}&o=${o.id}&term=${H}&q=${maxEff(o, info(o, H))}`;
    await go(page, base, path);
    await page.click(`#terms button[data-term="${L}"]`);
    const nt = await notice(), q = await txt(page, "#qv");
    rec(`${o.t} · ${o.name}: ${TL(H)} → ${TL(L)}, доступно ${li.left}`, q === String(li.left) && nt.includes(`уменьшено до ${li.left}`), `количество ${q}, пояснение «${nt}»`, { url: path, sel: "#notice" });
  }
  // альтернатива возвращает к покупке
  for (const o of cat.offers) for (const k of termsOf(o)) {
    const i = info(o, k); if (buyable(i)) continue;
    const bt = buyTerms(o); if (!bt.length) continue;
    const path = `?demo&t=${o.t}&o=${o.id}&term=${k}`;
    await go(page, base, path);
    await page.click(`#alt [data-alt-term="${bt[0]}"]`);
    const ok = (await page.getAttribute(`#terms button[data-term="${bt[0]}"]`, "aria-pressed")) === "true" && (await vis(page, "#buyNow"));
    rec(`${o.t} · ${o.name} · ${TL(k)}: альтернатива «${TL(bt[0])}» открывает покупку`, ok, "", { url: path, sel: "#alt" });
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
  document.querySelectorAll(".seg button, .term, .alt-l button").forEach((b) => { if (shown(b) && b.scrollWidth > b.clientWidth + 1) out.push({ type: "обрезанная подпись сегмента", sel: path(b), detail: b.innerText.replace(/\s+/g, " ") }); });
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
    const doc = document.documentElement, desk = vw >= 960, bar = document.getElementById("bar");
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
