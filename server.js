const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const https = require('https');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

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
   OBTENER TÍTULO REAL con Puppeteer + @sparticuz/chromium
   ============================================================ */
async function obtenerTituloReal(url) {
  if (!url || !url.includes('shein.com')) return null;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForSelector('h1, .product-title, [data-spm="product_title"]', { timeout: 5000 }).catch(() => {});

    const titulo = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle && ogTitle.content) return ogTitle.content;

      if (document.title && !document.title.includes('Error')) {
        return document.title.replace(/\s*-\s*SHEIN.*$/i, '').trim();
      }

      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent.trim()) return h1.textContent.trim();

      const productTitle = document.querySelector('.product-title, [data-spm="product_title"]');
      if (productTitle && productTitle.textContent.trim()) return productTitle.textContent.trim();

      return null;
    });

    if (titulo && titulo.length > 10) {
      console.log(`[Título real] ${titulo.slice(0, 60)}...`);
      return titulo;
    }
    return null;
  } catch (e) {
    console.log(`[ERROR Puppeteer] ${e.message}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/* ============================================================
   TRADUCCIÓN con Google Translate gtx
   ============================================================ */
function translateText(text) {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string') return resolve(text || '');
    const t = text.trim();
    if (!t) return resolve('');
    if (/^[A-Za-z0-9\s.,;:!?()'"¡¿\-/%&]+$/.test(t) && t.length < 150) return resolve(t);

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(t)}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j && Array.isArray(j[0])) {
            const tr = j[0].map(x => x[0]).join('');
            if (tr && tr !== t && tr.length > 0) {
              console.log(`[OK] "${t.slice(0, 40)}..." → "${tr.slice(0, 40)}..."`);
              return resolve(tr);
            }
          }
        } catch (e) {}
        resolve(t);
      });
    }).on('error', () => resolve(t));
  });
}

/* ============================================================
   PARSER DE TEXTO
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
        current.img = '';
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
   ENDPOINT PRINCIPAL
   ============================================================ */
app.post('/api/cart', (req, res) => {
  const rawUrl = (req.body && req.body.url || '').trim();
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Falta el enlace del carrito.' });

  const safe = /^https?:\/\/(onelink\.shein\.com|[\w.-]*shein\.com)\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/i;
  if (!safe.test(rawUrl)) return res.status(400).json({ ok: false, error: 'El enlace no parece ser válido de SHEIN.' });

  const quoted = `"${rawUrl.replace(/"/g, '\\"')}"`;
  const cmd = `npx --no-install shein-cart ${quoted}`;
  const started = Date.now();

  exec(cmd, { timeout: 90000, maxBuffer: 20 * 1024 * 1024, shell: true }, async (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: 'Error consultando carrito.', detail: stderr });

    const parsed = parseSheinCartOutput(stdout);
    console.log(`[Parse] ${parsed.items.length} items (header: ${parsed.itemsCount})`);

    if (!parsed.items.length) {
      return res.status(200).json({ ok: false, error: 'El carrito está vacío o expiró.', raw: stdout.slice(0, 800) });
    }

    // OBTENER TÍTULOS REALES con Puppeteer (en lotes de 3)
    console.log(`[Obteniendo títulos reales] ${parsed.items.length} productos...`);
    const batchSize = 3;
    for (let i = 0; i < parsed.items.length; i += batchSize) {
      const batch = parsed.items.slice(i, i + batchSize);
      const titulos = await Promise.all(batch.map(it => obtenerTituloReal(it.url)));
      titulos.forEach((titulo, j) => {
        const idx = i + j;
        if (titulo) {
          parsed.items[idx].nombreReal = titulo;
          parsed.items[idx].name = titulo;
          console.log(`[OK] Producto #${idx+1}: ${titulo.slice(0, 50)}...`);
        } else {
          console.log(`[FALLÓ] Producto #${idx+1}: usando nombre original`);
        }
      });
    }

    // Traducir SOLO variant y meta (el nombre ya tiene el título real)
    try {
      const t = await Promise.all(parsed.items.map(it =>
        Promise.all([
          Promise.resolve(it.name),
          translateText(it.variant),
          translateText(it.meta)
        ])
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

    res.json({ ok: true, ...parsed, ms: Date.now() - started });
  });
});

app.listen(PORT, () => {
  console.log(`\n🛒 SHEIN Cart Viewer (@sparticuz/chromium + títulos reales)`);
  console.log(`Abre http://localhost:${PORT}\n`);
});
