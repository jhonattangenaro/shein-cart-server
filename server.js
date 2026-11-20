const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

const CURRENCY = process.env.SHEIN_CURRENCY || 'COP';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ============================================================
   DETECCIÓN DE IDIOMA (para MyMemory que NO soporta "auto")
   ============================================================ */
function detectarIdioma(texto) {
  if (!texto) return 'en';
  // CJK (chino/japonés/coreano)
  if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(texto)) {
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(texto)) return 'ja';
    if (/[\uac00-\ud7af]/.test(texto)) return 'ko';
    return 'zh';
  }
  // Cirílico
  if (/[\u0400-\u04ff]/.test(texto)) return 'ru';
  // Árabe/hebreo
  if (/[\u0600-\u06ff\u0590-\u05ff]/.test(texto)) return 'ar';
  // Por defecto: inglés (la mayoría de productos SHEIN vienen en inglés)
  return 'en';
}

/* ============================================================
   TRADUCCIÓN: Google gtx (soporta auto) → MyMemory como fallback
   ============================================================ */
function translateText(text) {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string') return resolve(text || '');
    const t = text.trim();
    if (!t) return resolve('');
    // Si ya es texto latino simple corto, no traducir
    if (/^[A-Za-z0-9\s.,;:!?()'"¡¿\-/%&]+$/.test(t) && t.length < 150) return resolve(t);

    // 1) Google Translate gtx (soporta auto, gratis, sin key)
    const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(t)}`;
    https.get(gtxUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j && Array.isArray(j[0])) {
            const tr = j[0].map(x => x[0]).join('');
            if (tr && tr !== t && tr.length > 0) {
              console.log(`[OK-gtx] "${t.slice(0, 40)}..." → "${tr.slice(0, 40)}..."`);
              return resolve(tr);
            }
          }
        } catch (e) {}
        // 2) Fallback: MyMemory con idioma detectado (NO auto)
        const lang = detectarIdioma(t);
        const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(t)}&langpair=${lang}|es`;
        https.get(mmUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
          let data2 = '';
          res2.on('data', c => data2 += c);
          res2.on('end', () => {
            try {
              const j2 = JSON.parse(data2);
              const tr2 = j2 && j2.responseData && j2.responseData.translatedText;
              if (tr2 && tr2 !== t && !/MYMEMORY WARNING/i.test(tr2) && !/INVALID SOURCE LANGUAGE/i.test(tr2)) {
                console.log(`[OK-mm] "${t.slice(0, 40)}..." → "${tr2.slice(0, 40)}..."`);
                return resolve(tr2);
              }
            } catch (e) {}
            console.log(`[FALLÓ] "${t.slice(0, 40)}..."`);
            resolve(t);
          });
        }).on('error', () => resolve(t));
      });
    }).on('error', () => resolve(t));
  });
}

/* ============================================================
   PARSER DE TEXTO (el que SÍ funciona - fallback principal)
   ============================================================ */
function parseSheinCartOutput(output) {
  const result = { sharedBy: '', total: null, itemsCount: 0, items: [] };
  const header = output.match(/Items shared by (.+?) · (\d+) items? · total \$?([\d.,]+)/i);
  if (header) {
    result.sharedBy = header[1].trim();
    result.itemsCount = parseInt(header[2], 10);
    result.total = parseFloat(header[3].replace(',', ''));
  }
  const lines = output.split(/\r?\n/);
  // Regex flexible para capturar items con o sin precio original/descuento
  const itemStart = /^\s*(\d+)\s+\$?([\d.]+)(?:\s+\$?([\d.]+)\s+-(\d+)%)?\s+(.+)$/;
  const urlLine = /^\s*(https?:\/\/\S+)\s*$/;
  let current = null;
  const flush = () => { if (current) { result.items.push(current); current = null; } };

  for (const line of lines) {
    const m = line.match(itemStart);
    if (m) {
      flush();
      current = {
        index: parseInt(m[1], 10),
        price: parseFloat(m[2]),
        originalPrice: m[3] ? parseFloat(m[3]) : null,
        discountPct: m[4] ? parseInt(m[4], 10) : null,
        name: m[5].trim(),
        variant: '', meta: '', url: '', sku: '', img: '', status: ''
      };
      continue;
    }
    if (!current) continue;

    const u = line.match(urlLine);
    if (u && !current.url) {
      current.url = u[1];
      const s = current.url.match(/-p-(\d+)\.html/);
      if (s) {
        current.sku = s[1];
        current.img = `https://img.ltwebstatic.com/images3_pi/2023/07/20/${s[1]}_thumbnail_400x533.webp`;
      } else {
        current.sku = `SHEIN-${current.index}`;
      }
      continue;
    }

    const trimmed = line.trim();
    if (trimmed && /only \d+ left/i.test(trimmed)) {
      current.status = trimmed;
    } else if (trimmed && !current.variant && trimmed.length > 2) {
      const parts = trimmed.split(/\s+·\s+/);
      current.variant = parts[0].trim();
      current.meta = parts.slice(1).join(' · ').trim();
    } else if (trimmed && /unavailable|sold out|agotado/i.test(trimmed)) {
      current.status = trimmed;
    }
  }
  flush();
  if (!result.itemsCount) result.itemsCount = result.items.length;
  return result;
}

/* ============================================================
   PARSER JSON (defensivo - busca precios en cualquier campo)
   ============================================================ */
function parseSheinCartJson(stdout) {
  const j = JSON.parse(stdout);
  const arr = findItemsArray(j) || [];
  if (!arr.length) throw new Error('No se encontraron items en el JSON');

  const items = arr.map((raw, i) => {
    // Buscar precio en múltiples campos posibles
    const price = findPrice(raw);
    return {
      index: raw.index || raw.no || i + 1,
      price: price.current,
      originalPrice: price.original,
      discountPct: raw.discount ? parseInt(raw.discount, 10) : (price.discount || null),
      name: raw.goods_name || raw.name || raw.title || raw.goods_title || '',
      variant: raw.attr || raw.variant || raw.sku_info || raw.attr_value || '',
      meta: raw.color || raw.size || raw.meta || raw.color_size || '',
      url: raw.goods_url || raw.url || raw.link || '',
      sku: String(raw.goods_id || raw.sku || raw.spu || raw.cat_id || ''),
      img: raw.goods_img || raw.image || raw.img || raw.main_image || '',
      status: raw.status_name || raw.status || raw.stock_status || ''
    };
  });

  return {
    sharedBy: j.sharedBy || j.share_user_name || j.shared_by || j.user_name || '',
    headerCount: j.itemsCount || j.total_items || j.count || items.length,
    itemsCount: items.length,
    total: j.total || null,
    items
  };
}

function findPrice(raw) {
  // Intenta múltiples campos de precio
  const candidates = [
    raw.price, raw.now_price, raw.amount, raw.salePrice,
    raw.sale_price, retailPrice, raw.retail_price, raw.final_price
  ];
  const origCandidates = [
    raw.original_price, raw.list_price, raw.retailPrice,
    raw.origin_price, raw.marketPrice
  ];
  let current = 0, original = null, discount = null;

  for (const c of candidates) {
    const n = toNum(c);
    if (n > 0) { current = n; break; }
  }
  for (const c of origCandidates) {
    const n = toNum(c);
    if (n > 0 && n !== current) { original = n; break; }
  }
  if (original && current && original > current) {
    discount = Math.round((1 - current / original) * 100);
  }
  return { current, original, discount };
}

function findItemsArray(obj) {
  if (Array.isArray(obj)) {
    if (obj.length && typeof obj[0] === 'object') return obj;
  }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const found = findItemsArray(obj[k]);
      if (found) return found;
    }
  }
  return null;
}

function toNum(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}

/* ============================================================
   ENDPOINT PRINCIPAL
   ============================================================ */
app.post('/api/cart', (req, res) => {
  const rawUrl = (req.body && req.body.url || '').trim();
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Falta el enlace del carrito.' });

  const safe = /^https?:\/\/(onelink\.shein\.com|[\w.-]*shein\.com)\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/i;
  if (!safe.test(rawUrl)) return res.status(400).json({ ok: false, error: 'El enlace no parece ser válido de SHEIN.' });

  const quoted = `"${rawUrl.replace(/"/g, '\\"')}"`;
  // --json para salida estructurada, -c COP para moneda colombiana
  const cmd = `npx --no-install shein-cart --json -c ${CURRENCY} ${quoted}`;
  const started = Date.now();

  exec(cmd, { timeout: 90000, maxBuffer: 20 * 1024 * 1024, shell: true }, async (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: 'Error consultando carrito.', detail: stderr });

    let parsed;
    let usadoJson = false;
    try {
      parsed = parseSheinCartJson(stdout);
      // Si el JSON no trajo precios válidos, usar parser de texto
      const tienePrecios = parsed.items.some(it => it.price > 0);
      if (!tienePrecios) {
        console.log('[JSON sin precios] Usando parser de texto como fallback');
        throw new Error('JSON sin precios válidos');
      }
      usadoJson = true;
      console.log(`[Parse] JSON OK -> ${parsed.items.length} items (header: ${parsed.headerCount})`);
    } catch (e) {
      console.warn('[Parse] Fallback a texto:', e.message);
      parsed = parseSheinCartOutput(stdout);
      console.log(`[Parse] Texto OK -> ${parsed.items.length} items (header: ${parsed.itemsCount})`);
    }

    if (!parsed.items.length) {
      return res.status(200).json({ ok: false, error: 'El carrito está vacío o expiró.', raw: stdout.slice(0, 800) });
    }

    // Traducir en paralelo
    try {
      const t = await Promise.all(parsed.items.map(it =>
        Promise.all([translateText(it.name), translateText(it.variant), translateText(it.meta)])
      ));
      t.forEach(([name, variant, meta], i) => {
        parsed.items[i].name = name;
        parsed.items[i].variant = variant;
        parsed.items[i].meta = meta;
      });
    } catch (e) { console.warn('[Error traduciendo]:', e.message); }

    // Marcar agotados (NO filtrar)
    for (const it of parsed.items) {
      const s = String(it.status || '').toLowerCase();
      it.outOfStock = /sold out|out of stock|agotado|indisponible|no disponible|unavailable/.test(s);
      if (it.outOfStock) console.log(`[AGOTADO] #${it.index} SKU=${it.sku} status="${it.status}"`);
      const m = (it.status || '').match(/only\s+(\d+)\s+left/i);
      if (m) it.status = `solo quedan ${m[1]}`;
    }

    const disponibles = parsed.items.filter(it => !it.outOfStock).length;
    console.log(`[Conteo] total=${parsed.items.length} disponibles=${disponibles} agotados=${parsed.items.length - disponibles}`);

    parsed.itemsCount = parsed.items.length;
    parsed.availableCount = disponibles;
    parsed.total = parsed.items
      .filter(it => !it.outOfStock)
      .reduce((acc, item) => acc + (item.price || 0), 0);

    res.json({ ok: true, ...parsed, currency: CURRENCY, usadoJson, ms: Date.now() - started });
  });
});

app.listen(PORT, () => {
  console.log(`\n🛒 SHEIN Cart Viewer (JSON+texto fallback, traducción gtx, moneda ${CURRENCY})`);
  console.log(`Abre http://localhost:${PORT}\n`);
});
