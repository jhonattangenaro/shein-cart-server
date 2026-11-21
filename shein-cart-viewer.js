#!/usr/bin/env node
/**
 * shein-cart-viewer.js — Resuelve el group_id real siguiendo redirecciones.
 * Uso: node shein-cart-viewer.js "<onelink>" [--json] [--inspect]
 */

const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

if (typeof fetch !== 'function') {
  console.error('Necesitas Node.js 18 o superior.');
  process.exit(1);
}

function armorUuid() {
  return `${Date.now()}${crypto.randomBytes(25).toString('hex')}`;
}

/** Decodifica recursivamente URLs anidadas en parámetros como `deeplink`. */
function decodeDeepLink(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Sigue la redirección de onelink y extrae el group_id real.
 * Busca en la URL final, en el HTML de la página intermedia y en el parámetro `deeplink`.
 */
async function resolveGroupId(link) {
  let finalUrl = link;
  let html = '';

  try {
    const res = await fetch(link, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    });
    finalUrl = res.url;
    html = await res.text();
  } catch (e) {
    console.warn('[warn] No se pudo seguir la redirección:', e.message);
  }

  // 1. Buscar en la URL final (query params)
  try {
    const u = new URL(finalUrl);
    for (const k of ['group_id', 'groupId', 'cart_id', 'share_code']) {
      if (u.searchParams.has(k)) return u.searchParams.get(k);
    }

    // 2. Si hay un parámetro `deeplink`, decodificarlo y buscar dentro
    const deeplink = u.searchParams.get('deeplink');
    if (deeplink) {
      let decoded = deeplink;
      // Decodificar varias veces por si viene doblemente escapado
      for (let i = 0; i < 3; i++) decoded = decodeDeepLink(decoded);

      const m = decoded.match(/group_id[=:"]+([A-Za-z0-9_-]+)/i);
      if (m) return m[1];
    }
  } catch {}

  // 3. Buscar en el HTML de la página intermedia (transit, sharejump, etc.)
  const patterns = [
    /group_id=([A-Za-z0-9_-]+)/i,
    /"group_id"\s*:\s*"([^"]+)"/i,
    /"groupId"\s*:\s*"([^"]+)"/i,
    /shareInfo[\s\S]{0,300}?"id"\s*:\s*"([^"]+)"/i,
    /cart\/share\/([A-Za-z0-9_-]{6,})/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }

  // 4. Fallback: si el HTML contiene `deeplink=` codificado, intentar extraerlo
  const deeplinkMatch = html.match(/deeplink=([^&"'\s]+)/i);
  if (deeplinkMatch) {
    let decoded = deeplinkMatch[1];
    for (let i = 0; i < 3; i++) decoded = decodeDeepLink(decoded);
    const m = decoded.match(/group_id[=:"]+([A-Za-z0-9_-]+)/i);
    if (m) return m[1];
  }

  // Último recurso: el segmento de la URL original (probablemente incorrecto)
  console.warn('[warn] No se encontró un group_id en la redirección. Usando el segmento de la URL como fallback.');
  return link.split('?')[0].split('/').filter(Boolean).pop();
}

/**
 * Consulta el endpoint en un host concreto.
 */
async function fetchCartFromHost(host, groupId) {
  const endpoint = `https://${host}/bff-api/order/cart/share/landing`;
  const cookie = `armorUuid=${armorUuid()}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': `https://${host}`,
        'Referer': `https://${host}/cart/share/${groupId}`,
        'User-Agent': UA,
        'Cookie': cookie,
      },
      body: JSON.stringify({ group_id: groupId }),
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return { ok: false, error: `No-JSON (HTTP ${res.status})`, host }; }

    const hasData = json.info && Object.keys(json.info).length > 0;
    return { ok: hasData, json, host, cookie };
  } catch (e) {
    return { ok: false, error: e.message, host };
  }
}

/**
 * Prueba hosts secuencialmente.
 */
async function fetchCartMultiHost(groupId) {
  const hosts = ['m.shein.com', 'br.shein.com', 'ar.shein.com', 'us.shein.com', 'au.shein.com', 'mx.shein.com', 'www.shein.com'];
  for (const host of hosts) {
    console.log(`  Probando ${host}...`);
    const result = await fetchCartFromHost(host, groupId);
    if (result.ok) {
      console.log(`  ✅ Datos encontrados en ${host}`);
      return result;
    }
  }
  return { ok: false };
}

function findItems(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && node[0] !== null) {
      const keys = Object.keys(node[0]).map(k => k.toLowerCase());
      if (keys.some(k => /name|title|goods_?name/.test(k))) return node;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const common of ['items', 'products', 'goods_list', 'list', 'cart_items']) {
      if (Array.isArray(node[common]) && node[common].length) return node[common];
    }
    for (const v of Object.values(node)) {
      const r = findItems(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function normalize(p) {
  const g = p.goods || p.product || p.item || p;
  const pick = (...ks) => { for (const k of ks) if (g[k] != null && g[k] !== '') return g[k]; return ''; };
  const price = g.salePrice || g.price || {};
  return {
    name: pick('goods_name', 'title', 'name'),
    color: p.color || g.color || '',
    size: p.size || g.size || '',
    price: typeof price === 'object' ? (price.amount ?? '') : price,
    currency: (price && price.currency) || 'USD',
    img: pick('goods_img', 'image', 'img'),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  const wantJson = args.includes('--json');
  const inspect = args.includes('--inspect');

  if (!url) {
    console.error('Uso: node shein-cart-viewer.js "<onelink>" [--json] [--inspect]');
    process.exit(1);
  }

  console.log('🔍 Resolviendo group_id real (siguiendo redirecciones)...');
  const groupId = await resolveGroupId(url);
  console.log(`   group_id resuelto: ${groupId}\n`);

  if (groupId === url.split('?')[0].split('/').filter(Boolean).pop()) {
    console.warn('⚠️ El ID resuelto es igual al segmento de la URL original. Es probable que la redirección no se haya seguido correctamente.\n');
  }

  console.log('🌎 Probando hosts...');
  const result = await fetchCartMultiHost(groupId);

  if (!result.ok) {
    console.error('\n❌ No se pudo obtener el carrito. El group_id resuelto no es visible desde ningún host probado.');
    console.log('   Ejecuta con --inspect para ver la URL final y el HTML recibido.');
    if (inspect) {
      const debug = await resolveGroupId(url); // Solo para mostrar
      console.log('   (Revisa manualmente la redirección de tu enlace con `curl -I` o el navegador).');
    }
    process.exit(1);
  }

  if (inspect || wantJson) {
    console.log(JSON.stringify(result.json, null, 2));
    return;
  }

  const items = findItems(result.json.info) || [];
  if (!items.length) {
    console.log('⚠️ El host respondió con datos, pero no se encontró el array de productos. Prueba --inspect.');
    return;
  }

  console.log(`\n🛒 ${items.length} artículo(s) (vía ${result.host}):\n`);
  items.forEach((p, i) => {
    const it = normalize(p);
    console.log(`#${i + 1} ${it.name}`);
    if (it.color) console.log('   color  :', it.color);
    if (it.size)  console.log('   talla  :', it.size);
    if (it.price !== '') console.log('   precio :', it.price, it.currency);
    console.log();
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });