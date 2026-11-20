const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const https = require('https');
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
   DETECCIÓN DE IDIOMA
   ============================================================ */
function detectarIdioma(texto) {
  if (!texto) return 'en';
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(texto)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(texto)) return 'zh';
  if (/[\uac00-\ud7af]/.test(texto)) return 'ko';
  if (/[\u0400-\u04ff]/.test(texto)) return 'ru';
  if (/[\u0600-\u06ff]/.test(texto)) return 'ar';
  return 'en';
}

/* ============================================================
   TRADUCCIÓN: Google gtx → MyMemory fallback
   ============================================================ */
function translateText(text) {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string') return resolve(text || '');
    const t = text.trim();
    if (!t) return resolve('');
    
    // Si es texto latino simple, no traducir
    if (/^[A-Za-z0-9\s.,;:!?()'"¡¿\-/%&]+$/.test(t) && t.length < 150) {
      return resolve(t);
    }

    // 1) Intentar Google Translate gtx
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
              console.log(`[OK-gtx] "${t.slice(0, 30)}..." → "${tr.slice(0, 30)}..."`);
              return resolve(tr);
            }
          }
        } catch (e) {}
        
        // 2) Fallback: MyMemory con idioma detectado
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
                console.log(`[OK-mm] "${t.slice(0, 30)}..." → "${tr2.slice(0, 30)}..."`);
                return resolve(tr2);
              }
            } catch (e) {}
            console.log(`[FALLÓ] "${t.slice(0, 30)}..."`);
            resolve(t);
          });
        }).on('error', () => resolve(t));
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
        // NO generar URL de imagen (las URLs hardcoded no funcionan)
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

  console.log(`[CMD] ${cmd}`);

  exec(cmd, { timeout: 90000, maxBuffer: 20 * 1024 * 1024, shell: true }, async (err, stdout, stderr) => {
    if (err) {
      console.error('[ERROR]', err.message);
      console.error('[STDERR]', stderr);
      return res.status(500).json({ ok: false, error: 'Error consultando carrito.', detail: stderr });
    }

    console.log(`[STDOUT length] ${stdout.length} chars`);

    const parsed = parseSheinCartOutput(stdout);
    console.log(`[Parse] ${parsed.items.length} items (header: ${parsed.itemsCount})`);

    if (!parsed.items.length) {
      return res.status(200).json({ ok: false, error: 'El carrito está vacío o expiró.', raw: stdout.slice(0, 800) });
    }

    // Traducir en paralelo con logs
    console.log(`[Traduciendo] ${parsed.items.length} productos...`);
    try {
      const t = await Promise.all(parsed.items.map(it =>
        Promise.all([translateText(it.name), translateText(it.variant), translateText(it.meta)])
      ));
      t.forEach(([name, variant, meta], i) => {
        parsed.items[i].name = name;
        parsed.items[i].variant = variant;
        parsed.items[i].meta = meta;
      });
      console.log('[Traducción completada]');
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
  console.log(`\n🛒 SHEIN Cart Viewer (texto + traducción gtx+mm)`);
  console.log(`Abre http://localhost:${PORT}\n`);
});
