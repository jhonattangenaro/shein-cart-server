const express = require('express');
const https = require('https');
const path = require('path');
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
   PETICIÓN HTTP (wrapper con headers de Colombia)
   ============================================================ */
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Origin': 'https://m.shein.com',
        'Referer': 'https://m.shein.com/',
        'Cookie': 'shein_country=CO; shein_language=es; currency=COP; country=CO',
        ...options.headers
      },
      timeout: 15000
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

/* ============================================================
   RESOLVER group_id desde onelink.shein.com
   ============================================================ */
async function resolverGroupId(url) {
  try {
    const res = await httpRequest(url, { method: 'GET' });
    // onelink devuelve HTML con el group_id embebido
    const html = typeof res.raw === 'string' ? res.raw : '';
    const match = html.match(/group_id[=:]\s*["']?([A-Za-z0-9_]+)/i) 
               || html.match(/group_id=([A-Za-z0-9_]+)/i);
    if (match) return match[1];
    // También puede venir en la URL de redirección
    if (res.headers && res.headers.location) {
      const m2 = res.headers.location.match(/group_id=([A-Za-z0-9_]+)/i);
      if (m2) return m2[1];
    }
  } catch (e) {
    console.log('[resolverGroupId error]', e.message);
  }
  return null;
}

/* ============================================================
   OBTENER CARRITO desde el endpoint interno de SHEIN (en español)
   ============================================================ */
async function obtenerCarrito(groupId) {
  const url = 'https://m.shein.com/bff-api/order/cart/share/landing';
  const body = { group_id: groupId };
  
  const res = await httpRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify(body)
  });

  if (res.status !== 200 || !res.data) {
    throw new Error(`SHEIN respondió ${res.status}`);
  }

  // La estructura típica: res.data.info.items
  const info = res.data.info || res.data;
  if (!info || !info.items || !Array.isArray(info.items)) {
    throw new Error('Respuesta sin items. Estructura: ' + JSON.stringify(res.data).slice(0, 200));
  }

  return {
    sharedBy: info.share_user_name || info.user_name || '',
    items: info.items
  };
}

/* ============================================================
   NORMALIZAR items a nuestro formato
   ============================================================ */
function normalizarItems(items) {
  return items.map((raw, i) => {
    // SHEIN devuelve precios en centavos a veces, o como string
    const price = parseFloat(raw.price || raw.now_price || raw.sale_price || 0);
    const originalPrice = raw.original_price ? parseFloat(raw.original_price) : null;
    const discountPct = raw.discount ? parseInt(raw.discount, 10) : null;
    
    // La URL del producto
    let url = raw.goods_url || raw.url || '';
    if (!url && raw.goods_id) {
      url = `https://www.shein.com/${raw.goods_name || 'product'}-p-${raw.goods_id}.html`;
    }
    
    // SKU
    const sku = String(raw.goods_id || raw.sku || raw.spu || '');
    
    // Imagen
    let img = raw.goods_img || raw.image || raw.main_image || '';
    if (!img && sku) {
      img = `https://img.ltwebstatic.com/images3_pi/2023/07/20/${sku}_thumbnail_400x533.webp`;
    }
    
    // Status (agotado, stock bajo, etc.)
    let status = raw.status_name || raw.status || '';
    if (raw.stock === 0 || raw.is_sold_out) status = 'Agotado';
    else if (raw.stock && raw.stock < 10) status = `Solo quedan ${raw.stock}`;

    return {
      index: i + 1,
      price: price > 100 ? price / 100 : price, // SHEIN a veces da centavos
      originalPrice: originalPrice && originalPrice > 100 ? originalPrice / 100 : originalPrice,
      discountPct,
      name: raw.goods_name || raw.name || raw.title || '',
      variant: raw.attr || raw.sku_info || raw.color_size || '',
      meta: raw.color || raw.size || '',
      url,
      sku,
      img,
      status
    };
  });
}

/* ============================================================
   ENDPOINT PRINCIPAL
   ============================================================ */
app.post('/api/cart', async (req, res) => {
  const rawUrl = (req.body && req.body.url || '').trim();
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Falta el enlace del carrito.' });

  const safe = /^https?:\/\/(onelink\.shein\.com|[\w.-]*shein\.com)\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/i;
  if (!safe.test(rawUrl)) return res.status(400).json({ ok: false, error: 'El enlace no parece ser válido de SHEIN.' });

  const started = Date.now();

  try {
    // 1. Resolver group_id
    console.log('[1/3] Resolviendo group_id...');
    const groupId = await resolverGroupId(rawUrl);
    if (!groupId) {
      return res.status(200).json({ ok: false, error: 'No se pudo resolver el group_id del enlace.' });
    }
    console.log(`[1/3] group_id: ${groupId}`);

    // 2. Obtener carrito en español
    console.log('[2/3] Obteniendo carrito desde SHEIN (Colombia/es)...');
    const carrito = await obtenerCarrito(groupId);
    console.log(`[2/3] ${carrito.items.length} items recibidos`);

    // 3. Normalizar
    const items = normalizarItems(carrito.items);

    // Marcar agotados
    for (const it of items) {
      it.outOfStock = /agotado|sold out|no disponible|unavailable/i.test(it.status);
    }

    const disponibles = items.filter(it => !it.outOfStock).length;
    console.log(`[3/3] total=${items.length} disponibles=${disponibles} agotados=${items.length - disponibles}`);

    const total = items
      .filter(it => !it.outOfStock)
      .reduce((acc, item) => acc + (item.price || 0), 0);

    res.json({
      ok: true,
      sharedBy: carrito.sharedBy,
      itemsCount: items.length,
      availableCount: disponibles,
      total,
      items,
      currency: 'COP',
      region: 'CO',
      ms: Date.now() - started
    });

  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🛒 SHEIN Cart Viewer (español nativo - Colombia)`);
  console.log(`Abre http://localhost:${PORT}\n`);
});
