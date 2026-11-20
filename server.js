const express = require('express');
const { exec } = require('child_process');
const https = require('https');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
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
   TRADUCCIÓN con https nativo de Node (sin fetch, sin timeout)
   ============================================================ */
function translateText(text) {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string') return resolve(text || '');
    const trimmed = text.trim();
    if (!trimmed) return resolve('');

    // Si solo tiene caracteres latinos básicos, no traducir
    if (/^[A-Za-z0-9\s.,;:!?()'"¡¿\-]+$/.test(trimmed) && trimmed.length < 100) {
      return resolve(trimmed);
    }

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(trimmed)}`;

    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json && Array.isArray(json[0])) {
            const translated = json[0].map(item => item[0]).join('');
            return resolve(translated || trimmed);
          }
        } catch (e) {}
        resolve(trimmed);
      });
    }).on('error', () => resolve(trimmed));
  });
}

/* ============================================================
   ENDPOINT PRINCIPAL
   ============================================================ */
app.post('/api/cart', (req, res) => {
  const rawUrl = (req.body && req.body.url || '').trim();
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Falta el enlace del carrito.' });

  // Regex corregida (sin brackets mal anidados)
  const safe = /^https?:\/\/(onelink\.shein\.com|[\w.-]*shein\.com)\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/i;
  if (!safe.test(rawUrl)) {
    return res.status(400).json({ ok: false, error: 'El enlace no parece ser válido de SHEIN.' });
  }

  const quoted = `"${rawUrl.replace(/"/g, '\\"')}"`;
  const cmd = `npx --no-install shein-cart ${quoted}`;
  const started = Date.now();

  exec(cmd, { timeout: 90000, maxBuffer: 20 * 1024 * 1024, shell: true }, async (err, stdout, stderr) => {
    if (err) {
      console.error('[Error shein-cart]:', stderr);
      return res.status(500).json({ ok: false, error: 'Error consultando carrito.', detail: stderr });
    }

    let parsed = parseSheinCartOutput(stdout);
    if (!parsed.items.length) {
      return res.status(200).json({ ok: false, error: 'El carrito está vacío o expiró.', raw: stdout.slice(0, 800) });
    }

    // Traducir en paralelo (más rápido)
    try {
      console.log(`[Traduciendo] ${parsed.items.length} productos...`);
      const traducciones = await Promise.all(
        parsed.items.map(it => Promise.all([
          translateText(it.name),
          translateText(it.variant),
          translateText(it.meta)
        ]))
      );
      traducciones.forEach(([name, variant, meta], i) => {
        parsed.items[i].name = name;
        parsed.items[i].variant = variant;
        parsed.items[i].meta = meta;
      });
      console.log('[Traducción completada]');
    } catch (e) {
      console.warn('[Error traduciendo]:', e.message);
    }

    // Filtrar agotados
    parsed.items = parsed.items.filter(it => {
      const t = (it.name + ' ' + it.meta + ' ' + (it.status || '')).toLowerCase();
      return !/agotado|sold out|no disponible/i.test(t);
    });

    // Traducir "only X left"
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
  const header = output.match(/Items shared by (.+?) · (\d+) items? · total \$([\d.,]+)/i);
  if (header) {
    result.sharedBy = header[1].trim();
    result.itemsCount = parseInt(header[2], 10);
    result.total = parseFloat(header[3].replace(',', ''));
  }
  const lines = output.split(/\r?\n/);
  const itemStart = /^\s*(\d+)\s+\$([\d.]+)(?:\s+\$([\d.]+)\s+-(\d+)%)?\s+(.+)$/;
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
        variant: '',
        meta: '',
        url: '',
        sku: '',
        img: '',
        status: ''
      };
      continue;
    }
    if (!current) continue;
    const u = line.match(urlLine);
    if (u && !current.url) {
      current.url = u[1];
      const skuMatch = current.url.match(/-p-(\d+)\.html/);
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
  console.log(`\n🛒 SHEIN Cart Viewer (con traducción)`);
  console.log(`Abre http://localhost:${PORT}\n`);
});
