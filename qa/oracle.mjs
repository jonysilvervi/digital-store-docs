// Независимый расчёт ожидаемых значений из данных каталога.
// Сознательно НЕ использует код страницы: если логика страницы ошибётся, тест это увидит.
// Демо-цены здесь — только входные данные для проверки отображения, а не проверенные коммерческие сведения.

// Склейка адреса страницы и состояния: base может уже содержать ?v=версия.
export const U = (base, p) => (!p ? base : base.includes("?") ? base + "&" + p.replace(/^\?/, "") : base + p);
// Переход к состоянию. Если страница уже открыта в тестовом режиме — мгновенный сброс через __qaSet
// (то же состояние, что и по адресу), иначе настоящая загрузка. real=true — всегда загружать заново.
export async function go(page, base, path, real = false) {
  if (!real && path && path.startsWith("?demo") && (await page.evaluate(() => typeof window.__qaSet === "function").catch(() => false))) {
    await page.evaluate((q) => window.__qaSet(q), path);
    return;
  }
  await page.goto(U(base, path));
}
export const TL = (n) => ({ 1: "1 мес", 3: "3 мес", 12: "12 мес" }[n] || `${n} мес`);
export const TLG = (n) => ({ 1: "1 месяц", 3: "3 месяца", 12: "12 месяцев" }[n] || `${n} мес.`);

// Формат суммы по спецификации: группы тысяч через неразрывный пробел, запятая, «€» через неразрывный пробел.
export function eur(n) {
  const cents = Math.round(n * 100);
  const int = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${int},${String(cents % 100).padStart(2, "0")} €`;
}
// Для сравнения текста: все виды пробелов → обычный пробел.
export const norm = (s) => String(s ?? "").replace(/[\s ]+/g, " ").trim();

export const offersOf = (cat, t) => cat.offers.filter((o) => o.t === t);
export const termsOf = (o) => Object.keys(o.terms).map(Number).sort((a, b) => a - b);
export function tariffTerms(cat, t) {
  const s = new Set();
  offersOf(cat, t).forEach((o) => termsOf(o).forEach((k) => s.add(k)));
  return [...s].sort((a, b) => a - b);
}
export const info = (o, n) => o.terms[String(n)] || null;
export const buyable = (i) => !!i && (i.st === "ok" || i.st === "low");
export const maxEff = (o, i) => (i && i.st === "low" ? Math.min(o.max, i.left) : o.max);
export const buyTerms = (o) => termsOf(o).filter((k) => buyable(info(o, k)));
// Цена «от» у способа доступа: минимум по доступным срокам; null — купить нельзя ни на один срок.
export function fromPrice(o) { const ps = buyTerms(o).map((k) => info(o, k).price); return ps.length ? Math.min(...ps) : null; }
export const offerStatus = (o) => (termsOf(o).some((k) => info(o, k).st === "soon") ? "Ожидается" : "Нет в наличии");
// Срок после выбора способа: прежний, если он у способа есть; иначе первый доступный; иначе первый.
export function preferTerm(o, prev) { if (prev != null && info(o, prev)) return prev; const b = buyTerms(o); return b.length ? b[0] : termsOf(o)[0]; }
export const autoTerm = (o) => preferTerm(o, null);
export function minFrom(cat, t) { const ps = offersOf(cat, t).map(fromPrice).filter((x) => x != null); return ps.length ? Math.min(...ps) : null; }

// Классы состояний строятся из данных: новый товар или предложение попадает в проверки сам.
export function stateClasses(cat) {
  const all = [];
  for (const o of cat.offers) for (const k of termsOf(o)) all.push({ o, k, i: info(o, k) });
  const pick = (f) => all.find(f);
  const url = (p) => "?demo" + Object.entries(p).filter(([, v]) => v != null).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");
  const sel = (x, extra = {}) => x && url({ t: x.o.t, o: x.o.id, term: x.k, ...extra });
  const classes = [];
  const add = (name, title, u) => u && classes.push({ name, title, url: u });

  add("none", "Способ доступа не выбран (вид по умолчанию)", "?demo");
  const multi = pick((x) => buyable(x.i) && x.k > 1 && maxEff(x.o, x.i) > 1);
  add("selected-qty2", "Полный выбор: срок больше месяца, 2 шт.", sel(multi, { q: 2 }));
  let big = null;
  for (const x of all) if (buyable(x.i) && (!big || x.i.price * maxEff(x.o, x.i) > big.i.price * maxEff(big.o, big.i))) big = x;
  add("max-total", "Самая большая сумма (максимум штук)", big && sel(big, { q: maxEff(big.o, big.i) }));
  add("low", "Ограниченное количество", sel(pick((x) => x.i.st === "low")));
  add("term-out", "Срок недоступен, есть другие сроки", sel(pick((x) => !buyable(x.i) && buyTerms(x.o).length > 0)));
  add("out", "Способ доступа недоступен целиком", sel(pick((x) => buyTerms(x.o).length === 0)));
  add("soon-eta", "Ожидается, прогноз известен", sel(pick((x) => x.i.st === "soon" && x.i.eta)));
  add("soon-unknown", "Ожидается, срок уточняется", sel(pick((x) => x.i.st === "soon" && !x.i.eta)));
  const partial = cat.offers.find((o) => termsOf(o).length < tariffTerms(cat, o.t).length && buyTerms(o).length);
  add("partial-terms", "У способа доступа не все сроки тарифа", partial && url({ t: partial.t, o: partial.id, term: autoTerm(partial) }));
  const single = cat.tariffs.find((t) => offersOf(cat, t).length === 1);
  if (single) { const o = offersOf(cat, single)[0]; add("single-offer", "Тариф с одним способом доступа", url({ t: single, o: o.id, term: autoTerm(o) })); }
  const longest = [...cat.offers].sort((a, b) => b.name.length - a.name.length)[0];
  add("longest-name", "Самое длинное название способа", longest && url({ t: longest.t, o: longest.id, term: autoTerm(longest) }));
  const many = [...cat.tariffs].sort((a, b) => offersOf(cat, b).length - offersOf(cat, a).length)[0];
  add("most-offers", "Тариф с наибольшим числом способов", url({ t: many }));
  add("sheet-cond", "Открыт лист «Все условия»", sel(multi || big, { sheet: "cond" }));
  const unav = pick((x) => !buyable(x.i));
  add("sheet-notify", "Открыта форма «Уведомить»", sel(unav, { sheet: "notify" }));
  add("sheet-tariffs", "Открыт лист «Сравнить тарифы»", "?demo&sheet=tariffs");
  const seen = new Set();
  return classes.filter((c) => (seen.has(c.url) ? false : seen.add(c.url)));
}
