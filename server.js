const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

async function translateText(text) {
  if (!text || text.trim() === '') return text;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(item => item[0]).join('');
  } catch (e) {
    return text;
  }
}

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

    let parsed = parseSheinCartOutput(stdout);
    if (!parsed.items.length) {
      return res.status(200).json({ ok: false, error: 'El carrito está vacío o expiró.', raw: stdout.slice(0, 800) });
    }

    try {
      for (const it of parsed.items) {
        it.name = await translateText(it.name);
        it.variant = await translateText(it.variant);
        it.meta = await translateText(it.meta);
      }
    } catch (e) {
      console.warn('Error traduciendo productos:', e.message);
    }

    // Filtrar productos no disponibles / agotados
    parsed.items = parsed.items.filter(it => {
      const textoCompleto = (it.name + ' ' + it.meta + ' ' + (it.status || '')).toLowerCase();
      const esAgotado = textoCompleto.includes('agotado') || 
                        textoCompleto.includes('sold out') || 
                        textoCompleto.includes('no disponible');
      return !esAgotado;
    });

    parsed.itemsCount = parsed.items.length;
    parsed.total = parsed.items.reduce((acc, item) => acc + (item.price || 0), 0);

    res.json({ ok: true, ...parsed, ms: Date.now() - started });
  });
});

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
      current = { index: parseInt(m[1], 10), price: parseFloat(m[2]), originalPrice: m[3] ? parseFloat(m[3]) : null, discountPct: m[4] ? parseInt(m[4], 10) : null, name: m[5].trim(), variant: '', meta: '', url: '', sku: '', img: '' };
      continue;
    }
    if (!current) continue;
    const u = line.match(urlLine);
    if (u && !current.url) { 
      current.url = u[1]; 
      const skuMatch = current.url.match(/-p-(\d+)\.html/);
      if (skuMatch) {
        current.sku = skuMatch[1];
        // CDN oficial de SHEIN ltwebstatic
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
    }
  }
  flush();
  if (!result.itemsCount) result.itemsCount = result.items.length;
  return result;
}

app.listen(PORT, () => {
  console.log(`\n🛒  SHEIN Cart Viewer (Filtro e imágenes corregidos)`);
  console.log(`    Abre http://localhost:${PORT}\n`);
});