// Ожидаемая модель покупательской сессии — независимо от кода страницы.
// Источник правил: REQUIREMENTS.md — А3 (цены), А4-07 (ограничение количества), А7 (переходы, память выбора,
// А7-04 ближайший срок), Г-04 (единственный способ выбирается сам), А12-02 (добавление в корзину — имитация).
// Модель знает только данные каталога и эти правила; она не читает состояние страницы.
import { offersOf, termsOf, info, buyable, buyTerms, TLG, plural } from "./oracle.mjs";

export const unitN = (o, n) => `${n} ${plural(n, [o.unit[0], o.unit[1], o.unit[2]])}`;
export const unitGen = (o, n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? o.unit[1] : o.unit[2]}`;
export const maxQty = (o, i) => (i && i.st === "low" ? Math.min(o.max, i.left) : o.max);

// А7-04: ближайший доступный срок; при равном расстоянии — более короткий; без исходного — первый доступный
export function nearest(o, want) {
  const b = buyTerms(o);
  if (!b.length) return termsOf(o)[0];
  if (want == null) return b[0];
  return [...b].sort((x, y) => Math.abs(x - want) - Math.abs(y - want) || x - y)[0];
}

export class Model {
  constructor(cat, startTariff) {
    this.cat = cat; this.t = startTariff; this.o = null; this.autoO = false; this.term = null; this.q = 1;
    this.dTerm = null; this.dQ = 1; this.notice = []; this.adds = []; this.lastAdd = null;
    this.autoSingle();
  }
  offer() { return this.o ? this.cat.offers.find((x) => x.id === this.o) : null; }
  i() { const o = this.offer(); return o ? info(o, this.term) : null; }
  canBuy() { return !!this.offer() && buyable(this.i()); }
  qShown() { const o = this.offer(); return o && buyable(this.i()) && o.max > 1 ? this.q : null; }
  maxNow() { const o = this.offer(); return o ? maxQty(o, this.i()) : null; }
  autoSingle() { const list = offersOf(this.cat, this.t); if (list.length === 1) { this.o = list[0].id; this.autoO = true; this.settle(null, false, []); } }

  // применить желаемые срок и количество к выбранному способу; msgs — ожидаемые пояснения
  settle(prev, direct, msgs) {
    const o = this.offer(); if (!o) return;
    const want = this.dTerm != null ? this.dTerm : this.term;
    const n = want != null && info(o, want) ? want : nearest(o, want);
    if (prev && prev.o && prev.term !== n && !direct) {
      if (this.dTerm != null && n === this.dTerm) msgs.push({ kind: "termRestored", n });
      else msgs.push({ kind: "termChanged", n, missing: want != null ? want : prev.term });
    }
    this.term = n;
    const i = info(o, n);
    if (!buyable(i)) { this.q = this.dQ; return; }
    const prevQ = prev ? prev.qShown : null;
    if (o.max === 1) {
      if (this.dQ > 1 && prev && prev.o && prev.o !== o.id && prevQ !== 1) msgs.push({ kind: "qtySingle" });
      this.q = 1; return;
    }
    const mx = maxQty(o, i), q = Math.min(this.dQ, mx);
    if (q < this.dQ && prevQ !== q) msgs.push({ kind: "qtyReduced", q, stock: i.st === "low" && i.left < o.max });
    else if (q === this.dQ && prev && prev.o && q > 1 && prevQ !== q) msgs.push({ kind: "qtyRestored", q });
    this.q = q;
  }
  snap() { return { o: this.o, term: this.term, qShown: this.qShown() }; }

  // ---- действия покупателя ----
  tariff(t) {
    if (t === this.t) return;
    const items = [];
    if (this.o && !this.autoO) items.push("способ доступа");
    if (this.o && this.dTerm != null) items.push("срок");
    if (this.dQ > 1) items.push("количество");
    this.t = t; this.o = null; this.autoO = false; this.term = null; this.q = 1; this.dTerm = null; this.dQ = 1;
    const single = offersOf(this.cat, t).length === 1;
    this.notice = items.length ? [{ kind: "tariff", items, single }] : [];
    this.autoSingle();
  }
  pick(id) {
    if (this.o === id) return;
    const prev = this.snap(), msgs = [];
    this.o = id; this.autoO = false; this.settle(prev, false, msgs); this.notice = msgs;
  }
  setTerm(k) {
    if (this.term === k) { this.dTerm = k; this.notice = []; return; }
    const prev = this.snap(), msgs = [];
    this.dTerm = k; this.term = k; this.settle(prev, true, msgs); this.notice = msgs;
  }
  qty(d) { // нажатие «+» или «−»; на пределе ничего не меняется
    if (!this.canBuy()) return false;
    const q = this.q + d;
    if (q < 1 || q > this.maxNow()) return false;
    this.q = q; this.dQ = q; this.notice = []; return true;
  }
  add() { // «В корзину»: имитация — счётчик и сообщение с текущей конфигурацией (А12-02)
    if (!this.canBuy()) return false;
    const o = this.offer(), i = this.i();
    this.lastAdd = { t: this.t, o: o.id, name: o.name, term: this.term, q: this.q, unit: info(o, this.term).price, total: i.price * this.q };
    this.adds.push(this.lastAdd); this.notice = []; return true;
  }
  cartCount() { return this.adds.reduce((s, a) => s + a.q, 0); }

  // ---- ожидаемые тексты (смысл, а не дословно) ----
  expectNotice() {
    const parts = [];
    for (const m of this.notice) {
      if (m.kind === "tariff") parts.push({ re: [/Тариф изменён/, ...m.items.map((w) => new RegExp(w))].concat(m.single ? [/один способ доступа/] : []), kind: m.kind });
      if (m.kind === "termChanged") parts.push({ re: [new RegExp(`Срок изменён на ${TLG(m.n)}`), new RegExp(`нет срока ${TLG(m.missing)}`)], kind: m.kind });
      if (m.kind === "termRestored") parts.push({ re: [new RegExp(`Срок снова ${TLG(m.n)}`)], kind: m.kind });
      if (m.kind === "qtyReduced") parts.push({ re: [new RegExp(`уменьшено до ${m.q}`), m.stock ? /налич/ : /заказ/], kind: m.kind });
      if (m.kind === "qtyRestored") parts.push({ re: [new RegExp(`Количество снова ${m.q}`)], kind: m.kind });
      if (m.kind === "qtySingle") parts.push({ re: [/Количество 1/], kind: m.kind });
    }
    return parts;
  }
}
