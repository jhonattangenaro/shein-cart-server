const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS para que Apps Script pueda llamarlo
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
   TRADUCCIÓN ROBUSTA (Google Translate + MyMemory como fallback)
   ============================================================ */
async function translateText(text) {
  if (!text || typeof text !== 'string') return text || '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  // Si parece estar ya en español/inglés simple, no traducir
  if (/^[A-Za-z0-9\s.,;:!?()'"-]+$/.test(trimmed) && trimmed.length < 80) {
    return trimmed;
  }

  // 1) Intentar con Google Translate (gtx)
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data[0])) {
        const translated = data[0].map(item => item[0]).join('');
        if (translated && translated !== trimmed) return translated;
      }
    }
  } catch (e) {
    console.warn('[Google Translate falló]:', e.message);
  }

  // 2) Fallback: MyMemory (API gratuita, no requiere key)
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=auto|es`;
    const res = await fetch(url, { timeout: 5000 });
    if (res.ok) {
      const data = await res.json();
      if (data && data.responseData && data.responseData.translatedText) {
        const t = data.responseData.translatedText;
        if (t && t !== trimmed && !/MYMEMORY WARNING/i.test(t)) return t;
      }
    }
  } catch (e) {
    console.warn('[MyMemory falló]:', e.message);
  }

  return trimmed; // si todo falla, devolver original
}

/* ============================================================
   ENDPOINT PRINCIPAL
   ============================================================ */
app.post('/api/cart', (req, res) => {
  const rawUrl = (req.body && req.body.url || '').trim();
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Falta el enlace del carrito.' });

  const safe = /^https?:\/\/(onelink\.shein\.com|[\w.-]*shein\.com)/[A-Za-z0-9-._~:/?#[]@!$&'()*+,;=%]+$/i;
  if (!safe.test(rawUrl)) return res.status(400).json({ ok: false, error: 'El enlace no parece ser válido de SHEIN.' });

  const quoted = `"${rawUrl.replace(/"/g, '\\"')}"`;
  const cmd = `npx --no-install shein-cart ${quoted}`;
  const started = Date.now();

  exec(cmd, { timeout: 90000, maxBuffer: 20 * 1024 * 1024, shell: true }, async (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: 'Error consultando carrito.', detail: stderr });

    let parsed = parseSheinCartOutput(stdout);
    if (!parsed.items.length) {
      return res.status(200).json({ ok: false, error: 'El carrito está vacío o expiró.', raw: stdout.slice(0, 800) });
    }

    // ===== TRADUCIR todos los campos de texto =====
    try {
      console.log(`[Traduciendo] ${parsed.items.length} productos...`);
      for (const it of parsed.items) {
        const [name, variant, meta] = await Promise.all([
          translateText(it.name),
          translateText(it.variant),
          translateText(it.meta)
        ]);
        it.name = name;
        it.variant = variant;
        it.meta = meta;
      }
      console.log('[Traducción completada]');
    } catch (e) {
      console.warn('[Error traduciendo productos]:', e.message);
    }

    // Filtrar agotados
    parsed.items = parsed.items.filter(it => {
      const textoCompleto = (it.name + ' ' + it.meta + ' ' + (it.status || '')).toLowerCase();
      return !/agotado|sold out|no disponible|only \d+ left/i.test(textoCompleto);
    });

    // Traducir status "only X left" → "solo quedan X"
    for (const it of parsed.items) {
      if (/only\s+(\d+)\s+left/i.test(it.status || '')) {
        const n = (it.status || '').match(/only\s+(\d+)\s+left/i)[1];
        it.status = `solo quedan ${n}`;
      }
    }

    parsed.itemsCount = parsed.items.length;
    parsed.total = parsed.items.reduce((acc, item) => acc + (item.price || 0), 0);
    res.json({ ok: true, ...parsed, ms: Date.now() - started });
  });
});

/* ============================================================
   PARSER (sin cambios)
   ============================================================ */
function parseSheinCartOutput(output) {
  const result = { sharedBy: '', total: null, itemsCount: 0, items: [] };
  const header = output.match(/Items shared by (.+?) · (\d+) items? · total $([\d.,]+)/i);
  if (header) {
    result.sharedBy = header[1].trim();
    result.itemsCount = parseInt(header[2], 10);
    result.total = parseFloat(header[3].replace(',', ''));
  }
  const lines = output.split(/\r?\n/);
  const itemStart = /^\s*(\d+)\s+$([\d.]+)(?:\s+$([\d.]+)\s+-(\d+)%)?\s+(.+)$/;
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
        name: m[5].trim(), variant: '', meta: '', url: '', sku: '', img: '', status: ''
      };
      continue;
    }
    if (!current) continue;
    const u = line.match(urlLine);
    if (u && !current.url) {
      current.url = u[1];
      const skuMatch = current.url.match(/-p-(\d+).html/);
      if (skuMatch) {
        current.sku = skuMatch[1];
        current.img = `https://img.ltwebstatic.com/images3_pi/2023/07/20/${skuMatch[1]}_thumbnail_400x533.webp`;
      } else {
        current.sku = `SHEIN-${current.index}`;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed && !current.variant) {
      const parts = trimmed.split(/\s+·\s+/);
      current.variant = parts[0].trim();
      current.meta = parts.slice(1).join(' · ').trim();
    } else if (trimmed && /only \d+ left/i.test(trimmed)) {
      current.status = trimmed;
    }
  }
  flush();
  if (!result.itemsCount) result.itemsCount = result.items.length;
  return result;
}

app.listen(PORT, () => {
  console.log(`\n🛒 SHEIN Cart Viewer (con traducción robusta)`);
  console.log(`Abre http://localhost:${PORT}\n`);
});
