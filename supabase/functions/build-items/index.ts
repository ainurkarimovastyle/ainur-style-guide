// Собирает таблицу items из staging_raw:
//  - строки Google-таблицы (store = 'sheet') дают категорию, магазин, ссылку, флажки и комментарий;
//  - данные со страниц магазинов (store = название магазина) дают название, цвет, цену, состав, фото;
//  - 'img:<магазин>' переопределяет главное фото.
// Вызов: POST с заголовком x-ingest-token.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SHEETS = ["Верха", "Низы", "Верхняя одежда", "Платья", "Сумки", "Обувь", "Аксессуары", "Головные уборы"];
const STORES: Record<string, string> = {
  "zara.com": "Zara",
  "shop.mango.com": "Mango",
  "massimodutti.com": "Massimo Dutti",
  "limestore.com": "Lime",
  "12storeez.kz": "12 Storeez",
  "stradivarius.com": "Stradivarius",
  "befree.ru": "Befree",
  "loverepublic.ru": "Love Republic",
};
const EXCLUDED = new Set(["Befree", "Love Republic", "Stradivarius"]);
const BODY = ["hourglass", "pear", "apple", "rectangle", "inv_triangle"];

// Ручные позиции, добавленные напрямую (без строки в Google-таблице).
// id начинаются с 2001, чтобы не пересекаться со строками таблицы.
const MANUAL_ROWS: { id: number; category: string; store: string; url: string; comment?: string }[] = [
  { id: 2001, category: "Верха", store: "Zara", url: "https://www.zara.com/kz/ru/комбинированныи-свитер-p03920136.html?v1=608392911" },
  { id: 2002, category: "Верха", store: "Zara", url: "https://www.zara.com/kz/ru/блуза-с-принтом-и-завязкои-p02587158.html?v1=592972276" },
  { id: 2003, category: "Верха", store: "Zara", url: "https://www.zara.com/kz/ru/блуза-с-принтом-и-бантом-—-zw-collection-p01394029.html?v1=594133989" },
  { id: 2004, category: "Верха", store: "Zara", url: "https://www.zara.com/kz/ru/рубашка-в-полоску-с-поясом-кушаком-zw-collection-p04437244.html?v1=584061819" },
  { id: 2005, category: "Аксессуары", store: "Zara", url: "https://www.zara.com/kz/ru/треугольныи-шарф-из-искусственного-меха-p01023351.html?v1=612312533" },
  { id: 2006, category: "Аксессуары", store: "Zara", url: "https://www.zara.com/kz/ru/короткие-комбинированные-перчатки-из-смесовои-шерсти-p03920010.html?v1=605321049" },
  { id: 2007, category: "Низы", store: "Zara", url: "https://www.zara.com/kz/ru/брюки-со-складками-—-zw-collection-p02015312.html?v1=607314810" },
  { id: 2008, category: "Низы", store: "Zara", url: "https://www.zara.com/kz/ru/брюки-с-декоративнои-строчкои-fruit-of-the-loom--p04644211.html?v1=556967653" },
  { id: 2009, category: "Верхняя одежда", store: "Zara", url: "https://www.zara.com/kz/ru/тренч-миди-—-zw-collection-p03811251.html?v1=590622100" },
  { id: 2010, category: "Верхняя одежда", store: "Zara", url: "https://www.zara.com/kz/ru/короткии-двустороннии-тренч-—-zw-collection-p03811277.html?v1=598244834" },
  { id: 2011, category: "Верхняя одежда", store: "Zara", url: "https://www.zara.com/kz/ru/тренч-с-поясом-water-repellent-windproof-p08073243.html?v1=593936056" },
  { id: 2012, category: "Низы", store: "Zara", url: "https://www.zara.com/kz/ru/брюки-flare-с-пряжкои-p01165229.html?v1=565132991" },
  { id: 2013, category: "Верха", store: "Zara", url: "https://www.zara.com/kz/ru/кардиган-из-тонкого-трикотажа-p02756050.html?v1=551149569" },
  { id: 2014, category: "Верха", store: "Zara", url: "https://www.zara.com/kz/ru/трикотажныи-топ-с-контрастнои-отделкои-p02142275.html?v1=545494660" },
  { id: 2015, category: "Верхняя одежда", store: "Mango", url: "https://shop.mango.com/kz/ru/p/женская/куртки/меховая-куртка-с-отложным-воротником/37047781/30/00" },
  { id: 2016, category: "Верха", store: "Massimo Dutti", url: "https://www.massimodutti.com/kz/100-cotton-short-sleeve-tshirt-l06207109?pelement=61784721" },
  { id: 2017, category: "Верхняя одежда", store: "Massimo Dutti", url: "https://www.massimodutti.com/kz/100-cotton-cape-jacket-l06753773?pelement=61856130" },
  { id: 2018, category: "Верха", store: "12 Storeez", url: "https://12storeez.kz/products/silk-shirt-138278" },
  { id: 2019, category: "Обувь", store: "12 Storeez", url: "https://12storeez.kz/products/manhattan-pumps-136157" },
  { id: 2020, category: "Верхняя одежда", store: "Lime", url: "https://limestore.com/kz_ru/product/36312-8252_024_120_molocnyi" },
  { id: 2021, category: "Аксессуары", store: "Lime", url: "https://limestore.com/kz_ru/product/37072-2713_332_251_temno_bezevyi" },
  { id: 2022, category: "Верха", store: "Lime", url: "https://limestore.com/kz_ru/product/37470-2090_531_120_molocnyi" },
  { id: 2023, category: "Верхняя одежда", store: "Lime", url: "https://limestore.com/kz_ru/product/37389-7399_102_120_molocnyi" },
  { id: 2024, category: "Аксессуары", store: "Другое", url: "https://www.falke.com/bg_en/p/softmerino-women-tights/48425_3009" },
  { id: 2025, category: "Аксессуары", store: "Другое", url: "https://www.calzedonia.com/uk/product/soft_modal_and_cashmere_blend_tights-MIC048_color_4479.html" },
  { id: 2026, category: "Аксессуары", store: "Другое", url: "https://www.calzedonia.com/uk/product/soft_modal_and_cashmere_blend_tights-MIC048_color_1478.html" },
  { id: 2027, category: "Аксессуары", store: "Другое", url: "https://www.calzedonia.com/lv/product/soft_modal_and_cashmere_blend_tights-MIC048_color_2240.html" },
  { id: 2028, category: "Аксессуары", store: "Другое", url: "https://www.calzedonia.com/uk/product/ribbed_tights_with_cashmere-MODC1730.html" },
];

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const decode = (s?: string | null) =>
  (s ?? "")
    .replace(/\\u002F/gi, "/")
    .replace(/\\"/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

function sentence(s: string) {
  const letters = s.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
  if (letters && letters === letters.toUpperCase()) {
    const low = s.toLowerCase();
    return low.charAt(0).toUpperCase() + low.slice(1);
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const num = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(String(v).replace(/[^\d.]/g, "")));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const MATERIALS: [string, RegExp][] = [
  ["Кашемир", /кашемир/],
  ["Шерсть", /шерст|меринос|альпак|мохер|ангор|(^|[^а-яё])яка?([^а-яё]|$)/],
  ["Шёлк", /ш[её]лк/],
  ["Хлопок", /хлоп/],
  ["Лён", /(^|[^а-яё])л[её]н([^а-яё]|$)|льн/],
  ["Вискоза", /вискоз|модал|лиоцел|ацетат|купро/],
  ["Кожа и замша", /(кож|замш|спилок|наппа)/],
  ["Металл", /латун|стал[ьи]|цинк|желез|медь|меди|сплав|металл/],
  ["Синтетика", /полиэстер|полиамид|акрил|эластан|нейлон|полиуретан|термопласт/],
];

function mainComposition(cm: string) {
  // первая часть состава без подкладки и прочих зон
  const parts = cm.split(/;|[,.](?=\s*(основная ткань 2|подкладка|подклад|пояс|воротник|аппликация|кайма|наполнитель|стелька|подошва|отделка)(?![а-яё]))/i);
  let main = parts[0] ?? "";
  if (!cm.includes(":")) main = cm.split(/;|[,.](?=\s*(подкладка|подклад))/i).filter((p) => p && !/подклад/i.test(p)).join(", ");
  main = main.replace(/^(состав|внешняя часть|основная ткань|покрой|верх)\s*:\s*/i, "");
  return main;
}

function materials(cm: string): string[] {
  const main = mainComposition(cm).toLowerCase();
  const out = new Set<string>();
  // компоненты вида "53% шерсть" или "шерсть 53%"
  const comps = main.split(/,|\//).map((x) => x.trim()).filter(Boolean);
  for (const c of comps) {
    const pct = Number((c.match(/(\d{1,3})\s*%/) || [])[1] ?? (comps.length === 1 ? 100 : 0));
    for (const [name, re] of MATERIALS) {
      if (re.test(c) && pct >= 15 && !(name === "Кожа и замша" && /искусст/.test(c))) out.add(name);
    }
  }
  return [...out];
}

const COLORS: [string, RegExp][] = [
  ["Принт", /разноцвет|многоцвет|принт|клетк|полоск|анимал|леопард/],
  ["Металлик", /золот|серебр|металлик|бронз/],
  ["Чёрный", /ч[её]рн/],
  ["Белый и молочный", /бел|молоч|экрю|слонов|ванил|кремов|айвори/],
  ["Бежевый", /беж|песоч|кэмел|камел|карамел|нюд|телес|пудров|камень|верблюж|орех/],
  ["Коричневый", /корич|шокол|коньяч|табач|каштан|кофе|мокко|тауп|виски|норк|кож|кротов|жж[её]н/],
  ["Серый", /сер|графит|антрацит|угольн|меланж|дымчат|пепельн/],
  ["Синий и голубой", /син|голуб|деним|индиго|лазур|электрик|морск/],
  ["Красный и бордо", /красн|бордо|винн|бургунд|гранат|вишн|землянич|рубин|марсал/],
  ["Зелёный и хаки", /зел|олив|хаки|мят|изумруд|мох|бирюз|бутылоч/],
  ["Розовый", /роз|фукси|маджент|пурпурн/],
  ["Фиолетовый", /фиолет|лилов|сирен|лаванд|баклаж/],
  ["Жёлтый и оранжевый", /ж[её]лт|горчи|охр|оранж|терракот|ржав|рыж|янтар|абрикос|черепич/],
];
function colorFamily(c: string) {
  const s = c.toLowerCase();
  for (const [name, re] of COLORS) if (re.test(s)) return name;
  return null;
}

const TYPES: Record<string, [string, RegExp][]> = {
  "Верха": [
    ["Жакеты и блейзеры", /блейзер|жакет|пиджак/],
    ["Рубашки и блузки", /рубаш|блуз/],
    ["Трикотаж", /свитер|джемпер|кардиган|пуловер|водолаз|трикотаж|поло|вязан/],
    ["Футболки и топы", /футбол|топ|лонгслив|боди|майк|свитшот|t-shirt/],
  ],
  "Низы": [
    ["Джинсы", /джинс/],
    ["Юбки", /юбк/],
    ["Шорты", /шорт/],
    ["Брюки", /брюк|штан|леггин|бридж|капри/],
  ],
  "Верхняя одежда": [
    ["Шубы и дублёнки", /шуб|дубл|овчин|мехов|из меха|искусственного меха/],
    ["Пуховики и парки", /пухов|парк|стеган|утепл|анорак/],
    ["Тренчи и плащи", /тренч|плащ|макинтош/],
    ["Пальто", /пальто|кейп|накидк/],
    ["Куртки и жилеты", /куртк|бомбер|косух|жилет|жакет/],
  ],
  "Платья": [
    ["Комбинезоны", /комбинезон/],
    ["Платья", /плать|сарафан/],
  ],
  "Обувь": [
    ["Сапоги", /сапог|ботфорт|казак/],
    ["Ботинки и ботильоны", /ботин|ботильон|челси|угги/],
    ["Лоферы и мокасины", /лофер|мокасин|топсайдер|палуб/],
    ["Балетки", /балетк/],
    ["Кроссовки и кеды", /кроссов|кед|сникер/],
    ["Мюли и босоножки", /мюли|босонож|сандал|шлепан|сабо/],
    ["Туфли", /туфл|лодочк/],
  ],
  "Сумки": [["Сумки", /./]],
  "Аксессуары": [
    ["Украшения", /серьг|ожерел|кольц|колье|браслет|брош|цепоч|подвеск|чокер/],
    ["Ремни", /ремен|ремн|пояс/],
    ["Перчатки и варежки", /перчат|варежк|митенк/],
    ["Шарфы и платки", /шарф|платок|палантин|снуд/],
    ["Колготки и носки", /колгот|носк|чулк/],
  ],
  "Головные уборы": [
    ["Балаклавы и капюшоны", /балаклав|капюшон|капор/],
    ["Береты", /берет/],
    ["Кепки и бейсболки", /кепк|бейсбол|фуражк/],
    ["Шляпы и панамы", /шляп|панам|таблетк/],
    ["Шапки", /шапк|бини/],
    ["Шарфы и платки", /шарф|платок|косынк/],
    ["Перчатки", /перчат/],
  ],
};
function typeOf(category: string, name: string) {
  const s = name.toLowerCase();
  for (const [t, re] of TYPES[category] ?? []) if (re.test(s)) return t;
  return null;
}

function fromStore(store: string, d: any, imgOverride?: string) {
  let name = decode(d.n), color = decode(d.c), cm = decode(d.cm);
  let price = num(d.p), old = num(d.op);
  let img: string | null = Array.isArray(d.img) ? d.img[0] ?? null : d.img ?? null;
  let inStock: boolean | null = null;

  if (store === "Mango") {
    const def = num((String(d.pr ?? "").match(/default\\?"?:\{\\?"?price\\?"?:(\d+)/) || [])[1]);
    if (def && price && def < price) { old = price; price = def; }
    cm = cm.replace(/^"?|"$/g, "").replace(/"\s*,\s*"/g, "; ").replace(/^Состав:\s*/i, "");
  }
  if (store === "Lime" || store === "12 Storeez") {
    if (typeof d.av === "boolean") inStock = d.av;
    else if (typeof d.av === "string") inStock = !/OutOfStock/i.test(d.av);
  }
  if (/^-/.test(cm)) cm = "";
  if (imgOverride) img = imgOverride;
  if (img && img.startsWith("//")) img = "https:" + img;
  if (old && price && old <= price) old = null;

  return {
    name: name ? sentence(name) : null,
    color: color ? sentence(color.toLowerCase()) : null,
    price, old_price: old, composition: cm || null, image: img, in_stock: inStock,
  };
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const tok = req.headers.get("x-ingest-token");
  const { data: ok } = await sb.rpc("check_ingest_token", { t: tok ?? "" });
  if (!tok || ok !== true) return new Response("forbidden", { status: 403 });

  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("staging_raw").select("store,item_id,data").range(from, from + 999);
    if (error) return new Response(error.message, { status: 500 });
    all.push(...data);
    if (data.length < 1000) break;
  }
  const sheets = all.filter((r) => r.store === "sheet").sort((a, b) => a.item_id - b.item_id);
  const scraped = new Map<string, any>();
  for (const r of all) if (r.store !== "sheet" && r.store !== "manual") scraped.set(`${r.store}#${r.item_id}`, r.data);

  // строки таблицы → позиции (id = порядковый номер ссылки во всех вкладках)
  const rows: any[] = [];
  let id = 0;
  for (const title of SHEETS) {
    const sh = sheets.find((s) => s.data.title === title);
    if (!sh) return new Response("missing sheet " + title, { status: 500 });
    const grid = parseCSV(sh.data.csv);
    for (const cells of grid.slice(2)) {
      const url = (cells[0] ?? "").trim();
      if (!url.startsWith("http")) continue;
      id++;
      const host = (url.match(/^https?:\/\/(?:www\.)?([^/]+)/) || [])[1] ?? "";
      const store = STORES[host] ?? host;
      const flag = (k: number) => (cells[k] ?? "").toUpperCase() === "TRUE";
      rows.push({
        id, category: title, store, url,
        base: flag(1), trend: flag(2),
        body_types: BODY.filter((_, i) => flag(3 + i)),
        comment: (cells[8] ?? "").trim() || null,
      });
    }
  }
  // дополнительные ручные позиции хранятся в staging_raw (store = 'manual'),
  // чтобы добавлять вещи без перевыкладки функции: data = { category, store, url, comment? }
  const manual: any[] = [...MANUAL_ROWS];
  for (const r of all) if (r.store === "manual") manual.push({ id: r.item_id, ...r.data });
  manual.sort((a, b) => a.id - b.id);
  for (const m of manual) {
    rows.push({
      id: m.id, category: m.category, store: m.store, url: m.url,
      base: false, trend: false, body_types: [] as string[],
      comment: m.comment ?? null,
    });
  }

  const items: any[] = [];
  const missing: number[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (EXCLUDED.has(r.store)) continue;
    const d = scraped.get(`${r.store}#${r.id}`);
    if (!d || d.err || !d.n) { missing.push(r.id); continue; }
    const ov = scraped.get(`img:${r.store}#${r.id}`)?.img;
    const s = fromStore(r.store, d, ov);
    const key = r.url.split("?")[0] + "|" + (s.color ?? "");
    const dup = seen.has(key); seen.add(key);
    // Головные уборы объединяем с Аксессуарами; украшения выделяем в отдельную Бижутерию
    let category = r.category === "Головные уборы" ? "Аксессуары" : r.category;
    let subcategory = typeOf(r.category, s.name ?? "");
    if (subcategory === "Украшения") { category = "Бижутерия"; subcategory = null; }
    items.push({
      ...r, ...s, category,
      subcategory,
      materials: materials(s.composition ?? ""),
      color_family: s.color ? colorFamily(s.color) : null,
      promo_label: s.old_price && s.price ? `−${Math.round((1 - s.price / s.old_price) * 100)}%` : null,
      active: !dup,
      sort: r.id,
      updated_at: new Date().toISOString(),
    });
  }

  const { error: delErr } = await sb.from("items").delete().gte("id", 0);
  if (delErr) return new Response(delErr.message, { status: 500 });
  for (let i = 0; i < items.length; i += 300) {
    const { error } = await sb.from("items").insert(items.slice(i, i + 300));
    if (error) return new Response(error.message, { status: 500 });
  }
  return Response.json({
    sheet_rows: rows.length,
    items: items.length,
    active: items.filter((x) => x.active).length,
    missing,
  });
});
