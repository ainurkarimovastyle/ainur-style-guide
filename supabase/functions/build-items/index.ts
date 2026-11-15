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
const EXCLUDED = new Set(["Befree", "Love Republic"]);
const BODY = ["hourglass", "pear", "apple", "rectangle", "inv_triangle"];

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
  ["Кожа и замша", /(?<!искусственн\S* )(кож|замш|спилок|наппа)/],
  ["Металл", /латун|стал[ьи]|цинк|желез|медь|меди|сплав|металл/],
  ["Синтетика", /полиэстер|полиамид|акрил|эластан|нейлон|полиуретан|термопласт/],
];

function mainComposition(cm: string) {
  // первая часть состава без подкладки и прочих зон
  const parts = cm.split(/;|,(?=\s*(подкладка|подклад|пояс|воротник|аппликация|кайма|наполнитель|стелька|подошва|отделка)\b)/i);
  let main = parts[0] ?? "";
  if (!cm.includes(":")) main = cm.split(/;|,(?=\s*(подкладка|подклад)\b)/i).filter((p) => !/подклад/i.test(p)).join(", ");
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
      if (re.test(c) && (pct >= 15 || name === "Кожа и замша")) out.add(name);
    }
  }
  if (/искусственн/.test(main)) out.delete("Кожа и замша");
  return [...out];
}

const COLORS: [string, RegExp][] = [
  ["Принт", /разноцвет|многоцвет|принт|клетк|полоск|анимал|леопард/],
  ["Металлик", /золот|серебр|металлик|бронз/],
  ["Чёрный", /ч[её]рн|черный деним/],
  ["Белый и молочный", /бел|молоч|экрю|слонов|ванил|кремов|айвори/],
  ["Бежевый", /беж|песоч|кэмел|камел|карамел|нюд|телес|пудров|камень|верблюж|орех/],
  ["Коричневый", /корич|шокол|коньяч|табач|каштан|кофе|мокко|тауп|виски|норк|кож|кротов|жж[её]н/],
  ["Серый", /сер|графит|антрацит|угольн|меланж|дымчат|пепельн/],
  ["Синий и голубой", /син|голуб|деним|индиго|лазур|электрик|морск/],
  ["Красный и бордо", /красн|бордо|винн|бургунд|гранат|вишн|землянич|рубин/],
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
    ["Сапоги", /сапог|ботфорт/],
    ["Ботинки и ботильоны", /ботин|ботильон|челси|угги/],
    ["Лоферы и мокасины", /лофер|мокасин|топсайдер|палуб/],
    ["Балетки", /балетк/],
    ["Кроссовки и кеды", /кроссов|кед|сникер/],
    ["Мюли и босоножки", /мюли|босонож|сандал|шлепан/],
    ["Туфли", /туфл|лодочк/],
  ],
  "Сумки": [["Сумки", /./]],
  "Аксессуары": [
    ["Украшения", /серьг|ожерел|кольц|колье|браслет|брош|цепоч|подвеск/],
    ["Ремни", /ремен|ремн|пояс/],
    ["Перчатки и варежки", /перчат|варежк|митенк/],
    ["Шарфы и платки", /шарф|платок|палантин|снуд/],
  ],
  "Головные уборы": [
    ["Балаклавы и капюшоны", /балаклав|капюшон/],
    ["Береты", /берет/],
    ["Кепки и бейсболки", /кепк|бейсбол|фуражк/],
    ["Шляпы и панамы", /шляп|панам|таблетк/],
    ["Шапки", /шапк|бини/],
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
  for (const r of all) if (r.store !== "sheet") scraped.set(`${r.store}#${r.item_id}`, r.data);

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
    items.push({
      ...r, ...s,
      subcategory: typeOf(r.category, s.name ?? ""),
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
