// Conversor de imagens: três modos (converter, kit responsivo, favicon), tudo no navegador.
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtBytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0).replace('.', ',') + ' KB' : (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const today = () => new Date().toISOString().slice(0, 10);
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); }
async function copyText(txt){
  try{ await navigator.clipboard.writeText(txt); return true; }
  catch{
    const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    let ok = false; try{ ok = document.execCommand('copy'); }catch{}
    ta.remove(); return ok;
  }
}

/* ---------- bibliotecas sob demanda ---------- */
const LIB = {
  avif: 'https://cdn.jsdelivr.net/npm/@jsquash/avif@2.1.1/encode.js/+esm',
  oxipng: 'https://cdn.jsdelivr.net/npm/@jsquash/oxipng@2.3.0/optimise.js/+esm',
  zip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  heic: 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
};
const mods = {};
const loadMod = k => mods[k] ||= import(LIB[k]).catch(() => { delete mods[k]; throw new Error('não consegui carregar o codificador (sem internet?)'); });
const loadScript = (k, globalName, msg) => mods[k] ||= new Promise((res, rej) => {
  const s = document.createElement('script'); s.src = LIB[k];
  s.onload = () => res(window[globalName]);
  s.onerror = () => { delete mods[k]; rej(new Error(msg)); };
  document.head.appendChild(s);
});
const loadZip = () => loadScript('zip', 'JSZip', 'não consegui carregar o gerador de .zip');
const loadHeic = () => loadScript('heic', 'heic2any', 'não consegui carregar o leitor de HEIC');

/* ---------- processamento pesado em segundo plano (AVIF e PNG otimizado) ---------- */
// Até 2 workers. Se o navegador não permitir (ex.: página aberta como arquivo local), roda na própria página.
const Pool = {
  workers: [], queue: [], seq: 0, ok: null, ready: null,
  init(){
    this.ready = (async () => {
      try{
        const n = clamp((navigator.hardwareConcurrency || 2) - 1, 1, 2);
        for(let i = 0; i < n; i++){
          const w = new Worker('assets/encoder-worker.js', {type: 'module'});
          w.onmessage = e => this.done(w, e.data);
          w.onerror = () => { this.ok = false; if(w.job){ w.job.rej(new Error('falha no processamento em segundo plano')); w.job = null; } };
          this.workers.push(w);
        }
        await Promise.race([this.run('ping', {}, {}), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
        this.ok = true;
      } catch { this.ok = false; this.workers.forEach(w => w.terminate()); this.workers = []; }
    })();
    return this.ready;
  },
  run(kind, data, opts){
    return new Promise((res, rej) => {
      const transfer = data.buf ? [data.buf] : [];
      this.queue.push({id: ++this.seq, kind, data, opts, transfer, res, rej});
      this.pump();
    });
  },
  pump(){
    for(const w of this.workers){
      if(w.job || !this.queue.length) continue;
      const job = w.job = this.queue.shift();
      w.postMessage({id: job.id, kind: job.kind, data: job.data, opts: job.opts}, job.transfer);
    }
  },
  done(w, msg){
    const job = w.job; w.job = null;
    if(job) msg.error ? job.rej(new Error(msg.error.includes('import') || msg.error.includes('fetch') ? 'não consegui carregar o codificador (sem internet?)' : msg.error)) : job.res(msg.buf);
    this.pump();
  },
};
async function heavy(kind, data, opts){
  await (Pool.ready || Pool.init());
  if(Pool.ok) return Pool.run(kind, data, opts);
  if(kind === 'avif'){ const m = await loadMod('avif'); return m.default(new ImageData(new Uint8ClampedArray(data.buf), data.w, data.h), opts); }
  const m = await loadMod('oxipng'); return m.default(data.buf, opts);
}

/* ---------- formatos e configurações ---------- */
const FORMATS = {
  webp: {label:'WebP', mime:'image/webp', ext:'webp', alpha:true,  hint:'Melhor escolha para sites: leve, com transparência e aceito por todos os navegadores atuais.'},
  avif: {label:'AVIF', mime:'image/avif', ext:'avif', alpha:true,  hint:'O mais leve de todos, com transparência. Leva alguns segundos por imagem e programas antigos não abrem.'},
  jpeg: {label:'JPG',  mime:'image/jpeg', ext:'jpg',  alpha:false, hint:'Abre em qualquer lugar. Não tem transparência: áreas transparentes recebem a cor de fundo.'},
  png:  {label:'PNG',  mime:'image/png',  ext:'png',  alpha:true,  hint:'Sem perda de qualidade e com transparência. Bom para logos e prints; para fotos fica pesado.'},
};
const SIZES = [
  {id:'original', label:'Manter o tamanho original'},
  {id:'w1920', label:'Largura máx. 1920 px (tela cheia)', maxW:1920},
  {id:'w1200', label:'Largura máx. 1200 px (conteúdo de site)', maxW:1200},
  {id:'w800',  label:'Largura máx. 800 px', maxW:800},
  {id:'sq',    label:'1080 × 1080 (Instagram quadrado)', w:1080, h:1080},
  {id:'ig',    label:'1080 × 1350 (Instagram retrato)', w:1080, h:1350},
  {id:'story', label:'1080 × 1920 (Stories e Reels)', w:1080, h:1920},
  {id:'og',    label:'1200 × 630 (link compartilhado)', w:1200, h:630},
  {id:'1000x700', label:'1000 × 700', w:1000, h:700},
  {id:'800x1000', label:'800 × 1000', w:800, h:1000},
  {id:'custom', label:'Personalizado…'},
];
const KIT_WIDTHS = [360, 480, 640, 800, 1024, 1200, 1600, 1920, 2560];
const MODE_DESC = {
  convert: 'Converta, reduza o peso e padronize tamanhos e nomes. As imagens não saem do seu computador.',
  kit: 'Gera cada imagem em várias larguras e formatos, com o código <picture> pronto para colar no site. O navegador de cada visitante baixa só o arquivo do tamanho certo.',
  favicon: 'Transforma um logo em todos os ícones que um site precisa (aba do navegador, iPhone, Android) com o código para o <head>.',
};
const DEFAULTS = {
  mode:'convert', fmt:'webp', q:82, maxKB:'', optPng:true, size:'original', cw:'', ch:'', fit:'cover', bg:'#ffffff',
  names:'original', prefix:'imagem-', start:1, clean:true,
  kitFmts:['avif','webp','jpeg'], kitWidths:[480, 800, 1200, 1920], kitPath:'img/', kitSizes:'100vw',
  favBg:'transparent', favColor:'#ffffff', favPad:8, favName:'', favTheme:'#ffffff',
  wmOn:false, wmType:'text', wmText:'', wmLogo:'', wmLogoName:'', wmPos:'br', wmSize:20, wmOp:70, wmColor:'light',
};
let S = {...DEFAULTS};
try{ Object.assign(S, JSON.parse(localStorage.getItem('cv-settings') || '{}')); }catch{}
const saveS = () => { try{ localStorage.setItem('cv-settings', JSON.stringify(S)); }catch{ /* logo grande demais para guardar: segue sem salvar */ } };

let items = [], queue = [], seq = 0, busy = false, manualOrder = false, FAV = null, wmImg = null, currentProfile = '';

/* ---------- entrada de arquivos ---------- */
const isHeic = f => /\.(heic|heif)$/i.test(f.name || '') || /heic|heif/i.test(f.type || '');
const isImage = f => (f.type || '').startsWith('image/') || isHeic(f) || /\.(jpe?g|png|webp|avif|gif|bmp|svg)$/i.test(f.name || '');
function loadImg(url){ return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('formato não suportado pelo navegador')); i.src = url; }); }

// Detecta se uma foto JPG tem localização GPS nos metadados (EXIF), para avisar que ela foi removida
async function hasGPS(file){
  if(!/jpe?g$/i.test(file.name || '') && file.type !== 'image/jpeg') return false;
  try{
    const b = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    if(b[0] !== 0xFF || b[1] !== 0xD8) return false;
    let o = 2;
    while(o + 10 < b.length){
      if(b[o] !== 0xFF) return false;
      const mk = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
      if(mk === 0xE1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66){
        const t = o + 10, le = b[t] === 0x49, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const ifd = t + dv.getUint32(t + 4, le), n = dv.getUint16(ifd, le);
        for(let i = 0; i < n; i++) if(dv.getUint16(ifd + 2 + i * 12, le) === 0x8825) return true;
        return false;
      }
      if(mk === 0xDA) return false;
      o += 2 + len;
    }
  }catch{}
  return false;
}

async function addFiles(list){
  const files = [...list];
  const imgs = files.filter(isImage);
  const skipped = files.length - imgs.length;
  if(skipped) toast(skipped === 1 ? '1 arquivo ignorado: não é imagem' : `${skipped} arquivos ignorados: não são imagens`);
  if(!imgs.length) return;
  const added = imgs.map(f => {
    const name = f.name || `colada-${seq + 1}.png`;
    return {id: ++seq, file: f, name, base: name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f), size: f.size,
      focus: {x:.5, y:.5}, rot: 0, flip: false, heic: isHeic(f), status: 'loading'};
  });
  items.push(...added);
  if(!manualOrder) sortByName(false);
  invalidate(); render();
  const decode = async it => {
    try{
      if(it.heic){
        // HEIC (iPhone) não abre direto no Chrome/Edge: decodifica com biblioteca e segue como PNG
        const lib = await loadHeic();
        const out = await lib({blob: it.file, toType: 'image/png'});
        URL.revokeObjectURL(it.url);
        it.url = URL.createObjectURL(Array.isArray(out) ? out[0] : out);
      }
      it.img = await loadImg(it.url);
      it.w = it.img.naturalWidth || 1000; it.h = it.img.naturalHeight || 1000;
      it.gps = await hasGPS(it.file);
      it.status = 'ready';
    }catch(e){
      it.status = 'error';
      it.err = it.heic ? 'não consegui ler este HEIC. No iPhone, dá para exportar como JPG' : e.message;
    }
    renderItemById(it.id);
  };
  // imagens comuns em paralelo; HEIC uma por vez (é pesado)
  await Promise.all(added.filter(i => !i.heic).map(decode));
  for(const it of added.filter(i => i.heic)) await decode(it);
  render();
}
function sortByName(doRender = true){
  items.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', {numeric: true, sensitivity: 'base'}));
  manualOrder = false;
  if(doRender){ invalidate(); render(); }
}

/* ---------- orientação e geometria ---------- */
const dims = it => it.rot % 180 ? {w: it.h, h: it.w} : {w: it.w, h: it.h};
function getSrc(it){
  if(!it.rot && !it.flip) return it.img;
  const key = it.rot + '|' + it.flip;
  if(it.srcC && it.srcKey === key) return it.srcC;
  const {w, h} = dims(it), c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.translate(w / 2, h / 2); x.rotate(it.rot * Math.PI / 180); x.scale(it.flip ? -1 : 1, 1);
  x.drawImage(it.img, -it.w / 2, -it.h / 2);
  it.srcC = c; it.srcKey = key;
  return c;
}
const sizeOf = () => SIZES.find(s => s.id === S.size) || SIZES[0];
function plan(it){
  const s = sizeOf(), {w, h} = dims(it);
  if(s.maxW) return w <= s.maxW ? {W:w, H:h, mode:'plain'} : {W:s.maxW, H:Math.round(h * s.maxW / w), mode:'plain'};
  let TW = s.w, TH = s.h;
  if(s.id === 'custom'){
    TW = parseInt(S.cw) || 0; TH = parseInt(S.ch) || 0;
    if(!TW && !TH) return {W:w, H:h, mode:'plain'};
    if(!TH) return {W:TW, H:Math.max(1, Math.round(h * TW / w)), mode:'plain'};
    if(!TW) return {W:Math.max(1, Math.round(w * TH / h)), H:TH, mode:'plain'};
  }
  if(!TW) return {W:w, H:h, mode:'plain'};
  return {W:TW, H:TH, mode:S.fit};
}
const isFixed = () => { const s = sizeOf(); return !!(s.w || (s.id === 'custom' && parseInt(S.cw) && parseInt(S.ch))); };
function coverRect(it, p){
  const {w, h} = dims(it), scale = Math.max(p.W / w, p.H / h), sw = p.W / scale, sh = p.H / scale;
  return {sx: clamp(it.focus.x * w - sw / 2, 0, w - sw), sy: clamp(it.focus.y * h - sh / 2, 0, h - sh), sw, sh};
}
// redução em etapas (metade por vez) para não serrilhar ao diminuir muito
function drawHQ(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh){
  let s = src, x = sx, y = sy, w = sw, h = sh;
  while(w / dw > 2 && h / dh > 2){
    const nw = Math.round(w / 2), nh = Math.round(h / 2), t = document.createElement('canvas');
    t.width = nw; t.height = nh;
    const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(s, x, y, w, h, 0, 0, nw, nh);
    s = t; x = 0; y = 0; w = nw; h = nh;
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s, x, y, w, h, dx, dy, dw, dh);
}
function renderCanvas(it, p, bg, watermark = true){
  const src = getSrc(it), {w, h} = dims(it);
  const c = document.createElement('canvas'); c.width = p.W; c.height = p.H;
  const ctx = c.getContext('2d');
  if(bg){ ctx.fillStyle = bg; ctx.fillRect(0, 0, p.W, p.H); }
  if(p.mode === 'cover'){ const r = coverRect(it, p); drawHQ(ctx, src, r.sx, r.sy, r.sw, r.sh, 0, 0, p.W, p.H); }
  else if(p.mode === 'contain'){
    const k = Math.min(p.W / w, p.H / h), dw = w * k, dh = h * k;
    drawHQ(ctx, src, 0, 0, w, h, (p.W - dw) / 2, (p.H - dh) / 2, dw, dh);
  } else drawHQ(ctx, src, 0, 0, w, h, 0, 0, p.W, p.H);
  if(watermark) drawWatermark(ctx, p.W, p.H);
  return c;
}
function flatten(c, bg){
  const f = document.createElement('canvas'); f.width = c.width; f.height = c.height;
  const x = f.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, f.width, f.height); x.drawImage(c, 0, 0);
  return f;
}

/* ---------- marca d'água ---------- */
function drawWatermark(ctx, W, H){
  if(!S.wmOn) return;
  const m = Math.round(Math.min(W, H) * 0.03);
  let w, h, draw;
  ctx.save();
  ctx.globalAlpha = S.wmOp / 100;
  if(S.wmType === 'logo'){
    if(!wmImg){ ctx.restore(); return; }
    const ar = (wmImg.naturalHeight || 1) / (wmImg.naturalWidth || 1);
    w = W * S.wmSize / 100; h = w * ar;
    if(h > H * .8){ h = H * .8; w = h / ar; }
    draw = (x, y) => ctx.drawImage(wmImg, x, y, w, h);
  } else {
    const txt = (S.wmText || '').trim();
    if(!txt){ ctx.restore(); return; }
    ctx.font = '500 100px Inter, system-ui, sans-serif';
    const base = ctx.measureText(txt).width || 1;
    const fs = Math.min(100 * (W * S.wmSize / 100) / base, H * .3);
    ctx.font = `500 ${fs}px Inter, system-ui, sans-serif`;
    w = ctx.measureText(txt).width; h = fs;
    const light = S.wmColor === 'light';
    ctx.textBaseline = 'top';
    ctx.fillStyle = light ? '#ffffff' : '#141210';
    ctx.shadowColor = light ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.45)';
    ctx.shadowBlur = fs * .15;
    draw = (x, y) => ctx.fillText(txt, x, y);
  }
  const v = S.wmPos[0], hz = S.wmPos[1];
  const x = hz === 'l' ? m : hz === 'c' ? (W - w) / 2 : W - w - m;
  const y = v === 't' ? m : v === 'm' ? (H - h) / 2 : H - h - m;
  draw(x, y);
  ctx.restore();
}
async function loadWmLogo(){ wmImg = null; if(S.wmLogo){ try{ wmImg = await loadImg(S.wmLogo); }catch{ wmImg = null; } } }

/* ---------- codificação ---------- */
const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('falha ao gerar a imagem')), type, q));
async function encodePng(c, optimize){
  const b = await toBlob(c, 'image/png');
  if(!optimize) return b;
  return new Blob([await heavy('oxipng', {buf: await b.arrayBuffer()}, {level: 2})], {type: 'image/png'});
}
async function encodeCanvas(c, fmt, q){
  if(fmt === 'webp' || fmt === 'jpeg') return toBlob(c, FORMATS[fmt].mime, q);
  if(fmt === 'png') return encodePng(c, S.optPng);
  // AVIF: o canvas do Chrome não gera (devolve PNG), então usamos um codificador de verdade
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const buf = await heavy('avif', {buf: d.data.buffer, w: c.width, h: c.height}, {quality: Math.round(q * 100), speed: 7});
  return new Blob([buf], {type: 'image/avif'});
}

/* ---------- modo converter ---------- */
// cada imagem pode ter o seu formato; sem escolha própria, vale o formato geral
const fmtOf = it => FORMATS[it.fmt] ? it.fmt : S.fmt;
async function processConvert(it, base){
  const p = plan(it), fmt = fmtOf(it);
  const bg = (!FORMATS[fmt].alpha || p.mode === 'contain') ? S.bg : null;
  const c = renderCanvas(it, p, bg);
  let q = S.q / 100, blob = await encodeCanvas(c, fmt, q), fits = true;
  const max = (parseInt(S.maxKB) || 0) * 1024;
  if(max && fmt !== 'png' && blob.size > max){
    // busca binária da maior qualidade que cabe no peso máximo
    let lo = .1, hi = q, best = null;
    for(let i = 0; i < 6; i++){
      const mid = (lo + hi) / 2, b = await encodeCanvas(c, fmt, mid);
      if(b.size <= max){ best = {b, q: mid}; lo = mid; } else hi = mid;
    }
    if(best){ blob = best.b; q = best.q; } else { blob = await encodeCanvas(c, fmt, .1); q = .1; fits = false; }
  }
  it.out = {blob, fmt, name: `${base}.${FORMATS[fmt].ext}`, w: p.W, h: p.H, q, fits, url: URL.createObjectURL(blob)};
}

/* ---------- modo kit responsivo ---------- */
const kitFmts = () => ['avif', 'webp', 'jpeg'].filter(f => S.kitFmts.includes(f));
function widthsFor(it){
  const {w} = dims(it);
  const ws = [...new Set(S.kitWidths)].filter(x => x <= w).sort((a, b) => a - b);
  return ws.length ? ws : [w];
}
async function processKit(it, base){
  const {w, h} = dims(it), q = S.q / 100, outs = [];
  for(const W of widthsFor(it)){
    const H = Math.round(h * W / w), c = renderCanvas(it, {W, H, mode:'plain'}, null);
    for(const fmt of kitFmts()){
      const blob = await encodeCanvas(fmt === 'jpeg' ? flatten(c, S.bg) : c, fmt, q);
      outs.push({fmt, w: W, h: H, blob, name: `${base}-${W}.${FORMATS[fmt].ext}`});
    }
  }
  it.outs = outs;
  it.snippet = pictureSnippet(outs);
}
function kitPath(){
  const p = (S.kitPath || '').trim();
  return !p ? '' : p.endsWith('/') ? p : p + '/';
}
function pictureSnippet(outs){
  const path = kitPath(), sizes = (S.kitSizes || '100vw').trim(), fmts = kitFmts();
  const fb = fmts.includes('jpeg') ? 'jpeg' : fmts[fmts.length - 1];
  const of = f => outs.filter(o => o.fmt === f);
  const srcset = (list, pad) => list.map(o => `${path}${o.name} ${o.w}w`).join(',\n' + ' '.repeat(pad));
  const lines = ['<picture>'];
  for(const f of fmts.filter(f => f !== fb)){
    lines.push(`  <source type="${FORMATS[f].mime}"`, `          srcset="${srcset(of(f), 18)}"`, `          sizes="${sizes}">`);
  }
  const fl = of(fb), big = fl[fl.length - 1];
  lines.push(`  <img src="${path}${big.name}"`, `       srcset="${srcset(fl, 15)}"`, `       sizes="${sizes}"`,
    `       width="${big.w}" height="${big.h}" alt="" loading="lazy" decoding="async">`, '</picture>');
  return lines.join('\n');
}

/* ---------- modo favicon ---------- */
const FAV_PNGS = [
  {name:'favicon-16x16.png', s:16}, {name:'favicon-32x32.png', s:32},
  {name:'apple-touch-icon.png', s:180, solid:true},
  {name:'android-chrome-192x192.png', s:192}, {name:'android-chrome-512x512.png', s:512},
];
function favCanvas(it, s, solid){
  const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  if(solid || S.favBg === 'color'){ x.fillStyle = S.favColor; x.fillRect(0, 0, s, s); }
  const pad = Math.round(s * S.favPad / 100), box = s - pad * 2, {w, h} = dims(it), k = Math.min(box / w, box / h);
  drawHQ(x, getSrc(it), 0, 0, w, h, (s - w * k) / 2, (s - h * k) / 2, w * k, h * k);
  return c;
}
async function makeIco(entries){
  const head = 6 + 16 * entries.length;
  const total = head + entries.reduce((a, e) => a + e.buf.byteLength, 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint16(2, 1, true); dv.setUint16(4, entries.length, true);
  let off = head;
  entries.forEach((e, i) => {
    const p = 6 + 16 * i;
    out[p] = e.s >= 256 ? 0 : e.s; out[p + 1] = e.s >= 256 ? 0 : e.s;
    dv.setUint16(p + 4, 1, true); dv.setUint16(p + 6, 32, true);
    dv.setUint32(p + 8, e.buf.byteLength, true); dv.setUint32(p + 12, off, true);
    out.set(new Uint8Array(e.buf), off); off += e.buf.byteLength;
  });
  return new Blob([out], {type: 'image/x-icon'});
}
async function processFavicon(it){
  const files = [];
  for(const f of FAV_PNGS) files.push({name: f.name, s: f.s, blob: await encodePng(favCanvas(it, f.s, f.solid), true)});
  const ico = [];
  for(const s of [16, 32, 48]) ico.push({s, buf: await (await encodePng(favCanvas(it, s, false), true)).arrayBuffer()});
  files.unshift({name: 'favicon.ico', s: 48, blob: await makeIco(ico)});
  const svg = it.file.type === 'image/svg+xml' && !it.rot && !it.flip;
  if(svg) files.push({name: 'favicon.svg', blob: it.file});
  const name = (S.favName || '').trim() || 'Meu site';
  const manifest = JSON.stringify({
    name, short_name: name.slice(0, 12),
    icons: [{src:'/android-chrome-192x192.png', sizes:'192x192', type:'image/png'}, {src:'/android-chrome-512x512.png', sizes:'512x512', type:'image/png'}],
    theme_color: S.favTheme, background_color: S.favBg === 'color' ? S.favColor : '#ffffff', display: 'standalone',
  }, null, 2);
  files.push({name: 'site.webmanifest', blob: new Blob([manifest], {type: 'application/manifest+json'})});
  const head = [
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    svg ? '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' : null,
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    `<meta name="theme-color" content="${S.favTheme}">`,
  ].filter(Boolean).join('\n');
  files.forEach(f => { f.url = URL.createObjectURL(f.blob); });
  FAV = {files, head, from: it.name};
}

/* ---------- execução ---------- */
function invalidate(){
  for(const it of items) clearOut(it);
  if(FAV){ FAV.files.forEach(f => URL.revokeObjectURL(f.url)); FAV = null; }
}
function clearOut(it){
  if(it.out?.url) URL.revokeObjectURL(it.out.url);
  it.gen = (it.gen || 0) + 1; // resultado que ainda estiver sendo gerado com o ajuste antigo é descartado
  it.out = null; it.outs = null; it.snippet = null; it.saved = false;
  if(it.status === 'done' || it.status === 'working' || it.status === 'queued') it.status = 'ready';
  const qi = queue.indexOf(it); if(qi >= 0) queue.splice(qi, 1);
}
const usable = () => items.filter(i => i.status !== 'error' && i.status !== 'loading');
// o que ainda falta converter (no favicon só conta a primeira imagem)
const pending = () => (S.mode === 'favicon' ? usable().slice(0, 1) : usable()).filter(it => it.status === 'ready');
// Converte quando a pessoa clica (numa linha ou em "Converter tudo"). Enquanto roda, dá para pôr mais na fila.
let progress = {done: 0, total: 0};
function enqueue(list){
  if(S.mode === 'kit' && !kitFmts().length){ toast('Escolha pelo menos um formato no modo avançado'); return; }
  const add = list.filter(it => it.status === 'ready' && !queue.includes(it));
  if(!add.length) return;
  add.forEach(it => { it.status = 'queued'; queue.push(it); renderItemById(it.id); });
  if(busy){ progress.total += add.length; renderTotals(); }
  else runQueue();
}
async function runQueue(){
  busy = true;
  progress = {done: 0, total: queue.length};
  setBusy(true);
  if(S.wmOn && S.wmType === 'text') await document.fonts.load('500 40px Inter').catch(() => {});
  const work = async it => {
    if(!items.includes(it) || it.status !== 'queued') return;
    const gen = it.gen;
    it.status = 'working'; renderItemById(it.id);
    try{
      const base = outBases()[items.indexOf(it)];
      if(S.mode === 'kit') await processKit(it, base);
      else if(S.mode === 'favicon') await processFavicon(it);
      else await processConvert(it, base);
      it.status = 'done';
    }catch(e){ it.status = 'error'; it.err = e.message; }
    // mexeram na imagem ou nos ajustes enquanto convertia: joga fora o resultado
    if(it.gen !== gen){ if(it.out?.url) URL.revokeObjectURL(it.out.url); it.out = null; it.outs = null; it.snippet = null; if(it.status !== 'error') it.status = 'ready'; }
    progress.done++;
    if(items.includes(it)) renderItemById(it.id);
    if(S.mode !== 'convert') renderExtra();
    renderTotals();
    await new Promise(r => setTimeout(r));
  };
  // duas imagens por vez quando há processamento em segundo plano
  await (Pool.ready || Pool.init());
  const conc = Pool.ok && S.mode !== 'favicon' ? 2 : 1;
  await Promise.all(Array.from({length: conc}, async () => { while(queue.length) await work(queue.shift()); }));
  busy = false; setBusy(false);
  render();
}
function setBusy(on){
  $('#progress').hidden = !on;
  ['#clear', '#sort'].forEach(s => { $(s).disabled = on; });
  document.querySelector('.cv').toggleAttribute('aria-busy', on);
  renderTotals();
}

/* ---------- nomes ---------- */
const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function outBases(list = items){
  const used = new Set(), start = parseInt(S.start), st = isNaN(start) ? 1 : start;
  const pad = String(st + list.length - 1).length;
  let pre = S.prefix || '';
  pre = slug(pre) + (pre && /[-_ ]$/.test(pre) ? '-' : '');
  return list.map((it, i) => {
    let b = S.names === 'prefix' ? pre + String(st + i).padStart(pad, '0') : (S.clean ? slug(it.base) : it.base.trim());
    if(!b) b = 'imagem';
    let name = b, k = 2;
    while(used.has(name.toLowerCase())) name = `${b}-${k++}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/* ---------- download ---------- */
function save(blob, filename){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
async function zipAndSave(entries, filename){
  const btn = $('#download'); btn.disabled = true; btn.textContent = 'Montando o .zip…';
  try{
    const JSZip = await loadZip(), zip = new JSZip();
    for(const e of entries) zip.file(e.name, e.blob);
    // imagens já são comprimidas: guardar sem recomprimir deixa o zip instantâneo
    save(await zip.generateAsync({type: 'blob', compression: 'STORE'}), filename);
  }catch(e){ toast(e.message); }
  btn.disabled = false; renderTotals();
}
async function downloadAll(){
  if(S.mode === 'favicon'){
    if(!FAV) return;
    FAV.saved = true;
    return zipAndSave([...FAV.files, {name: 'codigo-head.html', blob: new Blob([FAV.head + '\n'], {type: 'text/html'})}], `favicon-${today()}.zip`);
  }
  const done = items.filter(i => i.status === 'done');
  if(!done.length) return;
  done.forEach(i => { i.saved = true; });
  if(S.mode === 'kit'){
    const files = done.flatMap(i => i.outs);
    const code = done.map(i => `<!-- ${i.name} -->\n${i.snippet}`).join('\n\n');
    return zipAndSave([...files, {name: 'codigo-picture.html', blob: new Blob([code + '\n'], {type: 'text/html'})}], `kit-responsivo-${today()}.zip`);
  }
  if(done.length === 1) return save(done[0].out.blob, done[0].out.name);
  const exts = [...new Set(done.map(i => FORMATS[i.out.fmt].ext))];
  return zipAndSave(done.map(i => ({name: i.out.name, blob: i.out.blob})), `imagens-${exts.length === 1 ? exts[0] + '-' : ''}${today()}.zip`);
}

/* ---------- tela ---------- */
const svgI = p => `<svg viewBox="0 0 16 16" aria-hidden="true">${p}</svg>`;
const I = {
  grip: '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="13" r="1.3"/><circle cx="7" cy="13" r="1.3"/></svg>',
  crop: svgI('<path d="M4 1v11h11M1 4h11v11"/>'),
  down: svgI('<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11"/>'),
  x: svgI('<path d="M4 4l8 8M12 4l-8 8"/>'),
  rot: svgI('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2v3h-3"/>'),
  flip: svgI('<path d="M8 1.5v13"/><path d="M6 4 2 12h4zM10 4l4 8h-4z"/>'),
  cmp: svgI('<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M8 1.5v13"/>'),
  code: svgI('<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>'),
  data: svgI('<rect x="4.5" y="4.5" width="9" height="9" rx="1.5"/><path d="M11.5 4.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v7A1.5 1.5 0 0 0 3 11.5h1.5"/>'),
};
const btn = (act, icon, title, extra = '') => `<button class="icon-btn${extra}" type="button" data-act="${act}" title="${esc(title)}" aria-label="${esc(title)}">${icon}</button>`;

const chev = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
const advOn = () => document.querySelector('.cv').classList.contains('is-adv');

function itemHTML(it, idx, base){
  const {w, h} = it.w ? dims(it) : {w: 0, h: 0};
  const unused = S.mode === 'favicon' && idx > 0;
  const fmt = fmtOf(it);
  let meta = `<span>${fmtBytes(it.size)}${w ? ` · ${w} × ${h}` : ''}</span>`;
  if(it.status === 'loading') meta = `<span class="loading">${it.heic ? 'abrindo foto do iPhone…' : 'lendo…'}</span>`;
  else if(it.status === 'error') meta = `<span class="err">Não deu: ${esc(it.err)}</span>`;
  else if(S.mode === 'favicon'){
    meta += unused ? ' <span>· não usada: o favicon usa a primeira da lista</span>'
      : it.status === 'done' && FAV ? ` <span class="arrow">→</span> <span class="res">${plural(FAV.files.length, 'arquivo', 'arquivos')}</span>` : ' <span class="arrow">→</span> <span>ícones de 16 a 512 px</span>';
  } else if(S.mode === 'kit'){
    if(it.status === 'done'){
      const sum = it.outs.reduce((a, o) => a + o.blob.size, 0);
      meta += ` <span class="arrow">→</span> <span class="res">${plural(it.outs.length, 'arquivo', 'arquivos')} · ${fmtBytes(sum)}</span>`;
    } else meta += ` <span class="arrow">→</span> <span>${widthsFor(it).join(', ')} px · ${kitFmts().map(f => FORMATS[f].label).join(' + ') || 'escolha um formato'}</span>`;
  } else if(it.status === 'done'){
    const o = it.out, diff = Math.round((1 - o.blob.size / it.size) * 100);
    meta = `<span>${fmtBytes(it.size)}</span> <span class="arrow">→</span> <span class="res">${fmtBytes(o.blob.size)}</span>
      <span class="pill ${diff > 0 ? 'ok' : 'warn'}">${diff > 0 ? diff + '% mais leve' : Math.abs(diff) + '% mais pesada'}</span>
      ${o.w !== w || o.h !== h ? `<span>${o.w} × ${o.h}</span>` : ''}
      ${!o.fits ? '<span class="pill warn">não coube no peso máximo</span>' : ''}`;
  }
  if(it.gps && it.status !== 'error' && it.status !== 'loading') meta += it.status === 'done' ? ' <span class="pill ok">GPS removido</span>' : '';

  const okStatus = it.status !== 'error' && it.status !== 'loading';
  const acts = [];
  // formato e botão principal da linha (só no modo converter)
  if(S.mode === 'convert' && it.status !== 'error'){
    acts.push(`<div class="fmtwrap"><button class="fmt-btn" type="button" data-act="fmt" aria-haspopup="dialog" aria-expanded="false" aria-label="Formato: ${FORMATS[fmt].label}. Trocar"${busy && it.status === 'working' ? ' disabled' : ''}><span><span class="to-lbl">para </span>${FORMATS[fmt].label.toUpperCase()}</span>${chev}</button></div>`);
    if(it.status === 'done') acts.push(`<button class="it-go dl" type="button" data-act="dl" aria-label="Baixar ${esc(it.out.name)}">${I.down}Baixar</button>`);
    else if(it.status === 'working') acts.push('<span class="it-go wait" role="status"><span class="spin"></span>Convertendo</span>');
    else if(it.status === 'queued') acts.push('<span class="it-go wait" role="status">Na fila</span>');
    else if(it.status === 'loading') acts.push('<span class="it-go wait">Aguarde</span>');
    else acts.push('<button class="it-go" type="button" data-act="go">Converter</button>');
  } else if(okStatus && it.status === 'working') acts.push('<span class="it-go wait" role="status"><span class="spin"></span>Gerando</span>');

  // ações extras (girar, comparar, recortar…) ficam no menu ⋯, só no modo avançado
  const menu = [];
  const mi = (act, icon, label) => `<button type="button" role="menuitem" data-act="${act}">${icon}${esc(label)}</button>`;
  if(okStatus && advOn()){
    if(it.status === 'done' && S.mode !== 'favicon') menu.push(mi('cmp', I.cmp, 'Comparar antes e depois'));
    if(S.mode === 'convert' && isFixed() && S.fit === 'cover') menu.push(mi('focus', I.crop, 'Escolher o que aparece no recorte'));
    menu.push(mi('rot', I.rot, it.rot ? `Girar 90° (girada ${it.rot}°)` : 'Girar 90°'), mi('flip', I.flip, it.flip ? 'Desfazer espelhamento' : 'Espelhar'));
    if(it.status === 'done' && S.mode === 'kit') menu.push('<hr>', mi('code', I.code, 'Copiar código <picture>'));
    if(it.status === 'done' && S.mode === 'convert') menu.push('<hr>', mi('data', I.data, 'Copiar como código (data URI)'));
  }
  if(menu.length) acts.push(`<div class="more"><button class="icon-btn" type="button" data-act="more" aria-haspopup="menu" aria-expanded="false" title="Mais opções" aria-label="Mais opções para ${esc(it.name)}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg></button><div class="menu" role="menu" hidden>${menu.join('')}</div></div>`);
  acts.push(`<button class="rm-x" type="button" data-act="rm" title="Remover" aria-label="Remover ${esc(it.name)}">${I.x}</button>`);

  const shownName = it.status === 'done' && it.out ? it.out.name : it.name;
  const thumb = it.status === 'done' && it.out ? it.out.url : it.url;
  const tf = it.status === 'done' && it.out ? '' : `transform:rotate(${it.rot}deg) scaleX(${it.flip ? -1 : 1})`;
  return `<li class="it${it.status === 'error' ? ' error' : ''}${unused ? ' unused' : ''}" draggable="${advOn()}" data-id="${it.id}">
    <span class="grip" title="Arraste para mudar a ordem">${I.grip}</span>
    <span class="thumbbox"><img class="thumb" src="${thumb}" alt="" decoding="async" style="${tf}"></span>
    <div class="it-main">
      <div class="it-name"><span class="from" title="${esc(it.name)}">${esc(shownName)}</span></div>
      <div class="it-meta">${meta}</div>
    </div>
    <div class="it-act">${acts.join('')}</div>
  </li>`;
}
function render(){
  const bases = outBases();
  $('#list').innerHTML = items.map((it, i) => itemHTML(it, i, bases[i])).join('');
  const n = items.length;
  $('#start').hidden = !!n;
  $('#box').hidden = !n;
  $('#count').textContent = plural(n, 'imagem', 'imagens');
  renderNamesPreview(bases);
  renderExtra();
  renderTotals();
}
function renderItemById(id){
  const li = document.querySelector(`.it[data-id="${id}"]`), idx = items.findIndex(i => i.id === id);
  if(li && idx >= 0) li.outerHTML = itemHTML(items[idx], idx, outBases()[idx]);
}
// rodapé: um botão só, que primeiro converte e depois baixa
function renderTotals(){
  const ready = usable(), done = items.filter(i => i.status === 'done'), todo = pending();
  const db = $('#download'), info = $('#dock-info');
  $('#progress span').style.width = progress.total ? (progress.done / progress.total * 100) + '%' : '0';
  db.dataset.act = '';
  if(busy){
    const verb = S.mode === 'kit' ? 'Gerando' : S.mode === 'favicon' ? 'Gerando' : 'Convertendo';
    info.innerHTML = `<b>${verb} ${Math.min(progress.done + 1, progress.total)} de ${progress.total}…</b>`;
    db.disabled = true; db.textContent = 'Aguarde…';
    return;
  }
  const loading = items.some(i => i.status === 'loading');
  let text = '', label = '', act = '';
  if(!ready.length){ text = loading ? 'Abrindo as imagens…' : ''; label = 'Converter'; }
  else if(todo.length){
    act = 'go';
    label = S.mode === 'kit' ? 'Gerar kit' : S.mode === 'favicon' ? 'Gerar favicon' : todo.length > 1 ? 'Converter tudo' : 'Converter';
    text = S.mode === 'convert' ? `${plural(todo.length, 'imagem', 'imagens')} · ${fmtBytes(todo.reduce((s, i) => s + i.size, 0))}` : '';
  } else if(S.mode === 'favicon'){
    act = FAV ? 'dl' : ''; label = 'Baixar favicon (.zip)';
    text = FAV ? `<b>${plural(FAV.files.length, 'arquivo', 'arquivos')}</b> + código do &lt;head&gt;` : '';
  } else if(S.mode === 'kit'){
    const outs = done.flatMap(i => i.outs || []);
    act = outs.length ? 'dl' : ''; label = 'Baixar kit (.zip)';
    text = outs.length ? `<b>${plural(outs.length, 'arquivo', 'arquivos')}</b> · ${fmtBytes(outs.reduce((s, o) => s + o.blob.size, 0))}` : '';
  } else if(done.length){
    act = 'dl'; label = done.length > 1 ? 'Baixar tudo (.zip)' : 'Baixar imagem';
    const before = done.reduce((s, i) => s + i.size, 0), after = done.reduce((s, i) => s + i.out.blob.size, 0), pct = Math.round((1 - after / before) * 100);
    text = `${fmtBytes(before)} → <b>${fmtBytes(after)}</b>${pct > 0 ? ` · ${pct}% mais leve` : ''}`;
  }
  info.innerHTML = text;
  db.dataset.act = act;
  db.disabled = !act;
  db.innerHTML = (act === 'dl' ? I.down.replace('<svg', '<svg class="gi"') : '') + esc(label);
}
function renderNamesPreview(bases){
  let ex = bases;
  if(!items.length){ const keep = items; items = [{base:'Foto Fachada 01'}, {base:'Foto Fachada 02'}]; ex = outBases(); items = keep; }
  const ext = S.mode === 'kit' ? `-${S.kitWidths[0] || 800}.${FORMATS[kitFmts()[0] || 'webp'].ext}` : `.${FORMATS[S.fmt].ext}`;
  $('#names-preview').textContent = ex.slice(0, 3).map(b => b + ext).join(', ') + (bases.length > 3 ? `, … (${bases.length})` : '');
}
function renderExtra(){
  const el = $('#extra');
  if(S.mode === 'kit'){
    const done = items.filter(i => i.status === 'done' && i.snippet);
    if(!done.length){ el.innerHTML = ''; return; }
    const code = done.map(i => `<!-- ${i.name} -->\n${i.snippet}`).join('\n\n');
    el.innerHTML = `<div class="extra-h"><h2>Código &lt;picture&gt; para o site</h2><button class="ghost" type="button" data-copy="kit">Copiar tudo</button></div>
      <div class="hint">Suba os arquivos para a pasta <span class="mono">${esc(kitPath() || '(raiz)')}</span> e cole o código no HTML. Preencha o <span class="mono">alt</span> de cada imagem com uma descrição curta: ajuda no Google e na acessibilidade.</div>
      <pre class="code">${esc(code)}</pre>`;
  } else if(S.mode === 'favicon' && FAV){
    const png = n => FAV.files.find(f => f.name === n);
    const cell = (label, f, px) => `<div class="fav-cell"><div class="sw l"><img src="${f.url}" width="${px}" height="${px}" alt=""></div><div class="sw d"><img src="${f.url}" width="${px}" height="${px}" alt=""></div>${label}</div>`;
    el.innerHTML = `<div class="extra-h"><h2>Favicon pronto</h2><button class="ghost" type="button" data-copy="fav">Copiar código do &lt;head&gt;</button></div>
      <div class="fav-grid">
        ${cell('16 px', png('favicon-16x16.png'), 16)}${cell('32 px', png('favicon-32x32.png'), 32)}
        ${cell('iPhone 180', png('apple-touch-icon.png'), 60)}${cell('Android 512', png('android-chrome-512x512.png'), 64)}
      </div>
      <div class="hint">Arquivos: ${FAV.files.map(f => `<span class="mono">${esc(f.name)}</span>`).join(', ')}. Envie para a raiz do site e cole no &lt;head&gt;:</div>
      <pre class="code">${esc(FAV.head)}</pre>`;
  } else el.innerHTML = '';
}
function renderSettings(){
  for(const el of $$('.m-convert, .m-kit, .m-favicon')) el.hidden = !el.classList.contains('m-' + S.mode);
  const pressed = (sel, v) => $$(sel + ' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v));
  pressed('#mode', S.mode); pressed('#fmt', S.fmt); pressed('#fit', S.fit); pressed('#names', S.names);
  pressed('#fav-bg', S.favBg); pressed('#wm-type', S.wmType); pressed('#wm-pos', S.wmPos); pressed('#wm-color', S.wmColor);
  renderPresets(); renderRecap();
  $('#fmt-hint').textContent = FORMATS[S.fmt].hint;
  $('#q').value = S.q; $('#q-out').textContent = S.q + '%';
  $('#maxkb').value = S.maxKB;
  if(S.mode === 'convert'){
    $('#f-quality').hidden = S.fmt === 'png';
    $('#f-png').hidden = S.fmt !== 'png';
  }
  $('#optpng').checked = S.optPng;
  $('#size').value = S.size;
  $('#custom').hidden = S.size !== 'custom'; $('#cw').value = S.cw; $('#ch').value = S.ch;
  const fixed = isFixed(), s = sizeOf();
  $('#fitbox').hidden = !fixed;
  $('#size-hint').textContent = s.maxW ? 'Imagens menores que isso ficam como estão (não aumenta).'
    : fixed ? (S.fit === 'cover' ? 'Corta as sobras para preencher a medida. Use o botão de enquadrar em cada foto para escolher o que aparece.' : 'A imagem inteira cabe na medida; as sobras recebem a cor de fundo.')
    : s.id === 'custom' ? 'Preencha só a largura (ou só a altura) para manter a proporção.' : '';
  const needBg = S.mode === 'convert' && (!FORMATS[S.fmt].alpha || (fixed && S.fit === 'contain'));
  $('#f-bg').hidden = !needBg; $('#bg').value = S.bg;
  $('#bg-hint').textContent = !FORMATS[S.fmt].alpha ? 'Cor de fundo (JPG não tem transparência)' : 'Cor de fundo das sobras';
  // kit
  $$('#kit-fmts input').forEach(i => { i.checked = S.kitFmts.includes(i.value); });
  $('#kit-widths').innerHTML = KIT_WIDTHS.map(w => `<label><input type="checkbox" value="${w}"${S.kitWidths.includes(w) ? ' checked' : ''}><span>${w}</span></label>`).join('');
  $('#kit-path').value = S.kitPath; $('#kit-sizes').value = S.kitSizes;
  // favicon
  $('#fav-color').value = S.favColor; $('#fav-pad').value = S.favPad; $('#fav-pad-out').textContent = S.favPad + '%';
  $('#fav-name').value = S.favName; $('#fav-theme').value = S.favTheme; $('#fav-theme-out').textContent = S.favTheme;
  // marca d'água
  $('#wm-on').checked = S.wmOn; $('#wm-text').value = S.wmText;
  $('#wm-text').hidden = S.wmType !== 'text'; $('#wm-color').hidden = S.wmType !== 'text';
  $('#wm-logo-box').hidden = S.wmType !== 'logo';
  $('#wm-logo-name').textContent = S.wmLogoName || 'nenhum logo escolhido';
  $('#wm-size').value = S.wmSize; $('#wm-size-out').textContent = S.wmSize + '% da largura';
  $('#wm-op').value = S.wmOp; $('#wm-op-out').textContent = S.wmOp + '%';
  if(S.wmOn) $('#wm-box').open = true;
  // nomes
  $('#prefixbox').hidden = S.names !== 'prefix'; $('#prefix').value = S.prefix; $('#start').value = S.start;
  $('#cleanbox').hidden = S.names !== 'original'; $('#clean').checked = S.clean;
  renderProfiles();
}
/* ---------- atalhos prontos e resumo em frase ---------- */
// cada atalho é só um conjunto de ajustes; o ativo é o que bate com os ajustes atuais
const PRESETS = [
  {id:'site',  label:'Para site', rec:true, desc:'WebP · até 1920 px de largura', set:{fmt:'webp', q:82, size:'w1920', maxKB:''}},
  {id:'leve',  label:'O mais leve', desc:'AVIF · até 1920 px (leva uns segundos)', set:{fmt:'avif', q:62, size:'w1920', maxKB:''}},
  {id:'fmt',   label:'Só trocar o formato', desc:'WebP · mesmo tamanho, quase sem perda', set:{fmt:'webp', q:92, size:'original', maxKB:''}},
  {id:'insta', label:'Instagram', desc:'JPG · 1080 × 1350, recortado', set:{fmt:'jpeg', q:88, size:'ig', fit:'cover', maxKB:''}},
  {id:'zap',   label:'WhatsApp e e-mail', desc:'JPG · até 1200 px, até 300 KB', set:{fmt:'jpeg', q:82, size:'w1200', maxKB:'300'}},
];
const presetMatches = p => Object.entries(p.set).every(([k, v]) => String(S[k] ?? '') === String(v));
function renderPresets(){
  const box = $('#presets');
  const active = PRESETS.find(presetMatches);
  box.innerHTML = PRESETS.map(p => `<button type="button" class="preset" data-p="${p.id}" aria-pressed="${active === p}"><b>${esc(p.label)}${p.rec ? '<span class="rec">recomendado</span>' : ''}</b><span>${esc(p.desc)}</span></button>`).join('')
    + `<button type="button" class="preset" data-p="custom" aria-pressed="${!active}"><b>Personalizado</b><span>${active ? 'escolher cada detalhe' : 'seus ajustes abaixo'}</span></button>`;
}
function sizeText(){
  const s = sizeOf();
  if(s.maxW) return `até ${s.maxW} px de largura`;
  if(s.id === 'original') return 'tamanho original';
  if(s.id === 'custom'){ const w = parseInt(S.cw), h = parseInt(S.ch); return w && h ? `${w} × ${h}` : w ? `${w} px de largura` : h ? `${h} px de altura` : 'tamanho original'; }
  return `${s.w} × ${s.h}${S.fit === 'cover' ? ', recortado' : ', inteiro'}`;
}
function recapShort(){
  if(S.mode === 'favicon') return 'favicon';
  if(S.mode === 'kit') return kitFmts().map(f => FORMATS[f].label).join(' + ');
  return `${FORMATS[S.fmt].label} · ${sizeText()}`;
}
function renderRecap(){
  let parts;
  if(S.mode === 'favicon') parts = ['Ícones de <b>16 a 512 px</b>', `fundo <b>${S.favBg === 'transparent' ? 'transparente' : 'colorido'}</b>`, 'a partir da <b>primeira imagem</b>'];
  else if(S.mode === 'kit') parts = [`<b>${esc(kitFmts().map(f => FORMATS[f].label).join(' + ') || 'nenhum formato')}</b>`, `larguras <b>${[...S.kitWidths].sort((a, b) => a - b).join(', ')} px</b>`, `qualidade <b>${S.q}%</b>`];
  else parts = [`<b>${FORMATS[S.fmt].label}</b>`, S.fmt === 'png' ? '<b>sem perda</b>' : `qualidade <b>${S.q}%</b>`, `<b>${esc(sizeText())}</b>`, S.maxKB ? `no máximo <b>${esc(S.maxKB)} KB</b>` : null];
  if(S.mode !== 'favicon'){
    parts.push(S.names === 'prefix' ? `nomes <b>${esc(outBases([{base:''}, {base:''}])[0])}, ${esc(outBases([{base:''}, {base:''}])[1])}…</b>` : '<b>nomes originais</b>');
    if(S.wmOn) parts.push('<b>com marca d’água</b>');
  }
  $('#recap').innerHTML = `<span class="lbl">Vai sair assim:</span> ${parts.filter(Boolean).join(' · ')}`;
}

function setS(patch){
  Object.assign(S, patch); saveS();
  invalidate(); renderSettings(); render();
  // já vai baixando o que vai precisar
  if((S.mode === 'convert' && S.fmt === 'avif') || (S.mode === 'kit' && S.kitFmts.includes('avif')) || S.mode === 'favicon' || (S.fmt === 'png' && S.optPng)) (Pool.ready || Pool.init());
}

/* ---------- perfis ---------- */
const loadProfiles = () => { try{ return JSON.parse(localStorage.getItem('cv-profiles') || '{}'); }catch{ return {}; } };
const saveProfiles = p => { try{ localStorage.setItem('cv-profiles', JSON.stringify(p)); return true; }catch{ return false; } };
function renderProfiles(){
  const p = loadProfiles(), names = Object.keys(p).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  $('#profile').innerHTML = `<option value="">${names.length ? 'Perfis salvos…' : 'Nenhum perfil salvo'}</option>` + names.map(n => `<option value="${esc(n)}"${n === currentProfile ? ' selected' : ''}>${esc(n)}</option>`).join('');
  $('#prof-del').disabled = !currentProfile;
}
$('#profile').addEventListener('change', async e => {
  const name = e.target.value; if(!name) return;
  const p = loadProfiles()[name]; if(!p) return;
  currentProfile = name;
  S = {...DEFAULTS, ...p}; saveS();
  await loadWmLogo(); invalidate(); renderSettings(); render();
  toast(`Perfil "${name}" aplicado`);
});
$('#prof-save').addEventListener('click', () => { $('#saveprof').hidden = false; $('#prof-name').value = currentProfile; $('#prof-name').focus(); });
const doSaveProfile = () => {
  const name = $('#prof-name').value.trim(); if(!name){ toast('Dê um nome ao perfil'); return; }
  const p = loadProfiles(); p[name] = {...S};
  if(!saveProfiles(p)){ toast('Não consegui salvar: o logo da marca d\'água é grande demais'); return; }
  currentProfile = name; $('#saveprof').hidden = true; renderProfiles(); toast(`Perfil "${name}" salvo`);
};
$('#prof-ok').addEventListener('click', doSaveProfile);
$('#prof-name').addEventListener('keydown', e => { if(e.key === 'Enter') doSaveProfile(); if(e.key === 'Escape') $('#saveprof').hidden = true; });
$('#prof-del').addEventListener('click', e => {
  if(!currentProfile) return;
  const b = e.currentTarget;
  if(!b.dataset.armed){ b.dataset.armed = '1'; toast(`Clique de novo para excluir "${currentProfile}"`); setTimeout(() => delete b.dataset.armed, 3000); return; }
  delete b.dataset.armed;
  const p = loadProfiles(); delete p[currentProfile]; saveProfiles(p);
  toast(`Perfil "${currentProfile}" excluído`); currentProfile = ''; renderProfiles();
});

/* ---------- enquadramento ---------- */
let focusIt = null;
function openFocus(it){
  focusIt = it;
  const img = $('#dlg-img');
  img.onload = drawFocus;
  img.src = (it.rot || it.flip) ? getSrc(it).toDataURL('image/jpeg', .85) : it.url;
  $('#dlg-title').textContent = `Enquadramento · ${it.name}`;
  $('#dlg').showModal();
  if(img.complete) drawFocus();
}
function drawFocus(){
  const it = focusIt; if(!it) return;
  const {w, h} = dims(it), r = coverRect(it, plan(it)), box = $('#cropbox');
  box.style.left = (r.sx / w * 100) + '%'; box.style.top = (r.sy / h * 100) + '%';
  box.style.width = (r.sw / w * 100) + '%'; box.style.height = (r.sh / h * 100) + '%';
  $('#fdot').style.left = (it.focus.x * 100) + '%'; $('#fdot').style.top = (it.focus.y * 100) + '%';
}
function setFocusFromEvent(e){
  const r = $('#stage').getBoundingClientRect();
  focusIt.focus = {x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1)};
  drawFocus();
}
$('#stage').addEventListener('pointerdown', e => { $('#stage').setPointerCapture(e.pointerId); setFocusFromEvent(e); });
$('#stage').addEventListener('pointermove', e => { if(e.buttons) setFocusFromEvent(e); });
$('#dlg-center').addEventListener('click', () => { focusIt.focus = {x:.5, y:.5}; drawFocus(); });
$('#dlg-all').addEventListener('click', () => { for(const it of items){ it.focus = {...focusIt.focus}; clearOut(it); } toast('Mesmo enquadramento aplicado em todas'); $('#dlg').close(); });
$('#dlg-ok').addEventListener('click', () => $('#dlg').close());
$('#dlg').addEventListener('close', () => { if(focusIt){ clearOut(focusIt); focusIt = null; render(); } });

/* ---------- comparar antes e depois ---------- */
const cmpUrls = [];
async function openCompare(it){
  let after, p, label;
  if(S.mode === 'kit'){
    const pref = it.outs.filter(o => o.fmt === (kitFmts().includes('webp') ? 'webp' : kitFmts()[0]));
    const o = pref[pref.length - 1]; after = o.blob; p = {W: o.w, H: o.h, mode: 'plain'}; label = `${FORMATS[o.fmt].label} ${o.w}px`;
  } else { after = it.out.blob; p = plan(it); label = FORMATS[it.out.fmt].label; }
  const bg = S.mode === 'convert' && (!FORMATS[fmtOf(it)].alpha || p.mode === 'contain') ? S.bg : null;
  const before = await toBlob(renderCanvas(it, p, bg), 'image/png');
  cmpUrls.push(URL.createObjectURL(before), URL.createObjectURL(after));
  $('#cmp-before').src = cmpUrls[cmpUrls.length - 2];
  $('#cmp-after').src = cmpUrls[cmpUrls.length - 1];
  $('#cmp-title').textContent = `Comparar · ${it.name}`;
  $('#cmp-tag-r').textContent = `${label} · ${fmtBytes(after.size)}`;
  $('#cmp-info').textContent = `${p.W} × ${p.H} · original ${fmtBytes(it.size)} → ${fmtBytes(after.size)}. Arraste a linha para comparar.`;
  $('#cmp').style.setProperty('--cut', '50%');
  setCmpZoom(true);
  $('#cmpdlg').showModal();
}
function setCmpZoom(fit){ $('#cmp').classList.toggle('fit', fit); $('#cmp-fit').setAttribute('aria-pressed', fit); $('#cmp-100').setAttribute('aria-pressed', !fit); }
const cmpMove = e => { const r = $('#cmp-in').getBoundingClientRect(); $('#cmp').style.setProperty('--cut', clamp((e.clientX - r.left) / r.width * 100, 0, 100) + '%'); };
$('#cmp-in').addEventListener('pointerdown', e => { $('#cmp-in').setPointerCapture(e.pointerId); cmpMove(e); });
$('#cmp-in').addEventListener('pointermove', e => { if(e.buttons) cmpMove(e); });
$('#cmp-fit').addEventListener('click', () => setCmpZoom(true));
$('#cmp-100').addEventListener('click', () => setCmpZoom(false));
$('#cmp-close').addEventListener('click', () => $('#cmpdlg').close());
$('#cmpdlg').addEventListener('close', () => { cmpUrls.splice(0).forEach(u => URL.revokeObjectURL(u)); });

/* ---------- eventos ---------- */
const drop = $('#drop'), fileIn = $('#file');
$('#add').addEventListener('click', () => fileIn.click());
$('#add2').addEventListener('click', () => fileIn.click());
$('#add-more').addEventListener('click', e => {
  e.stopPropagation();
  const m = $('#add-menu'), open = m.hidden; closeMenus(); closeFmt();
  m.hidden = !open; e.currentTarget.setAttribute('aria-expanded', String(open));
  if(open) m.querySelector('button').focus();
});
$('#add-menu').addEventListener('click', async e => {
  const b = e.target.closest('[data-add]'); if(!b) return;
  closeMenus();
  if(b.dataset.add === 'file') return fileIn.click();
  // colar pelo menu precisa de permissão do navegador; se não der, ensina o atalho
  try{
    const files = [];
    for(const ci of await navigator.clipboard.read()){
      const type = ci.types.find(t => t.startsWith('image/'));
      if(type) files.push(new File([await ci.getType(type)], `colada-${seq + 1}.${type.split('/')[1]}`, {type}));
    }
    files.length ? addFiles(files) : toast('Não há imagem copiada. Copie uma imagem e tente de novo');
  }catch{ toast('Use Ctrl + V para colar a imagem aqui'); }
});
fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; });
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', e => { if(hasFiles(e)){ dragDepth++; drop.classList.add('over'); } });
window.addEventListener('dragleave', e => { if(hasFiles(e) && --dragDepth <= 0){ dragDepth = 0; drop.classList.remove('over'); } });
window.addEventListener('dragover', e => { if(hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => { if(hasFiles(e)){ e.preventDefault(); dragDepth = 0; drop.classList.remove('over'); addFiles(e.dataTransfer.files); } });
window.addEventListener('paste', e => {
  if(e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if(files.length){ e.preventDefault(); addFiles(files); }
});

// reordenar arrastando
let dragId = null;
const list = $('#list');
list.addEventListener('dragstart', e => { const li = e.target.closest('.it'); if(!li || busy) return e.preventDefault(); dragId = +li.dataset.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', li.dataset.id); });
list.addEventListener('dragend', () => { dragId = null; $$('.it').forEach(li => li.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom')); });
list.addEventListener('dragover', e => {
  if(dragId === null) return;
  const li = e.target.closest('.it'); if(!li) return;
  e.preventDefault();
  const r = li.getBoundingClientRect(), top = e.clientY < r.top + r.height / 2;
  $$('.it').forEach(x => x.classList.remove('drag-over-top', 'drag-over-bottom'));
  li.classList.add(top ? 'drag-over-top' : 'drag-over-bottom');
});
list.addEventListener('drop', e => {
  if(dragId === null) return;
  e.preventDefault(); e.stopPropagation();
  const li = e.target.closest('.it'); if(!li) return;
  const r = li.getBoundingClientRect(), top = e.clientY < r.top + r.height / 2;
  const moved = items.splice(items.findIndex(i => i.id === dragId), 1)[0];
  let to = items.findIndex(i => i.id === +li.dataset.id); if(!top) to++;
  items.splice(to, 0, moved);
  manualOrder = true; dragId = null;
  // a ordem muda os números dos nomes (e qual imagem vira favicon)
  if(S.names === 'prefix' || S.mode === 'favicon') invalidate();
  render();
});
// menu ⋯: abre um de cada vez; fecha ao clicar fora ou apertar Esc
function closeMenus(except){
  $$('.menu').forEach(m => { if(m !== except){ m.hidden = true; m.previousElementSibling?.setAttribute('aria-expanded', 'false'); } });
}
document.addEventListener('click', e => {
  if(!e.target.closest('.more')) closeMenus();
  if(!e.target.closest('.fmtpop, [data-act="fmt"]')) closeFmt();
});
document.addEventListener('keydown', e => { if(e.key === 'Escape'){ closeMenus(); closeFmt(); } });
window.addEventListener('resize', () => closeFmt());

// escolha de formato: um painel só, aberto junto do botão da linha
let fmtFor = null;
const FMT_DESC = {webp: 'leve, ideal para sites', avif: 'o mais leve de todos', jpeg: 'abre em qualquer lugar', png: 'sem perda, com transparência'};
function openFmt(btn, it){
  const pop = $('#fmtpop');
  if(!pop.hidden && fmtFor === it){ closeFmt(); return; }
  closeMenus(); closeFmt(); fmtFor = it;
  const cur = fmtOf(it);
  $('#fp-grid').innerHTML = Object.entries(FORMATS).map(([k, f]) => `<button type="button" data-f="${k}" aria-pressed="${k === cur}"><b>${f.label.toUpperCase()}</b><span>${FMT_DESC[k]}</span></button>`).join('');
  $('#fp-all').closest('.switch').hidden = items.length < 2;
  pop.hidden = false;
  const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight, vw = document.documentElement.clientWidth;
  const left = clamp(r.right - pw, 16, vw - pw - 16);
  const up = r.bottom + 6 + ph > innerHeight && r.top - ph - 6 > 0;
  pop.style.left = (left + scrollX) + 'px';
  pop.style.top = ((up ? r.top - ph - 6 : r.bottom + 6) + scrollY) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  pop.querySelector('[aria-pressed="true"]')?.focus();
}
function closeFmt(){
  $('#fmtpop').hidden = true; fmtFor = null;
  $$('.fmt-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
$('#fp-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if(!b || !fmtFor) return;
  const f = b.dataset.f, it = fmtFor;
  closeFmt();
  if($('#fp-all').checked || items.length < 2){
    // vale para todas: refaz só as que mudam de formato
    items.forEach(i => { if(fmtOf(i) !== f) clearOut(i); i.fmt = null; });
    S.fmt = f; saveS(); renderSettings();
  } else if(fmtOf(it) !== f){ it.fmt = f; clearOut(it); }
  render();
  if(f === 'avif' || f === 'png') (Pool.ready || Pool.init());
});
list.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const it = items.find(i => i.id === +b.closest('.it').dataset.id); if(!it) return;
  const act = b.dataset.act;
  if(act === 'more'){
    const m = b.nextElementSibling; closeMenus(m);
    m.hidden = !m.hidden; b.setAttribute('aria-expanded', String(!m.hidden));
    if(!m.hidden) m.querySelector('button')?.focus();
    return;
  }
  closeMenus();
  if(act === 'go') enqueue([it]);
  else if(act === 'fmt') openFmt(b, it);
  else if(act === 'rm'){
    URL.revokeObjectURL(it.url); clearOut(it); items.splice(items.indexOf(it), 1);
    if(S.names === 'prefix' || S.mode === 'favicon') invalidate();
    render();
  } else if(act === 'rot' || act === 'flip'){
    if(act === 'rot') it.rot = (it.rot + 90) % 360; else it.flip = !it.flip;
    it.focus = {x:.5, y:.5}; clearOut(it);
    if(S.mode === 'favicon') invalidate();
    render();
  } else if(act === 'dl'){ save(it.out.blob, it.out.name); it.saved = true; }
  else if(act === 'focus') openFocus(it);
  else if(act === 'cmp') openCompare(it);
  else if(act === 'code'){ if(await copyText(it.snippet)) toast('Código <picture> copiado'); }
  else if(act === 'data'){
    const url = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(it.out.blob); });
    if(await copyText(url)) toast(it.out.blob.size > 102400 ? `Data URI copiado (${fmtBytes(it.out.blob.size)}). Só compensa para imagens pequenas, tipo ícones.` : 'Data URI copiado');
  }
});
list.addEventListener('dblclick', e => {
  const li = e.target.closest('.it'); if(!li || !advOn() || S.mode !== 'convert' || !isFixed() || S.fit !== 'cover') return;
  const it = items.find(i => i.id === +li.dataset.id); if(it && it.img) openFocus(it);
});
$('#extra').addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]'); if(!b) return;
  if(b.dataset.copy === 'fav' && FAV){ if(await copyText(FAV.head)) toast('Código do <head> copiado'); }
  if(b.dataset.copy === 'kit'){ const code = items.filter(i => i.snippet).map(i => `<!-- ${i.name} -->\n${i.snippet}`).join('\n\n'); if(await copyText(code)) toast('Código copiado'); }
});
$('#sort').addEventListener('click', () => sortByName());
$('#clear').addEventListener('click', () => { for(const it of items){ URL.revokeObjectURL(it.url); clearOut(it); } items = []; manualOrder = false; invalidate(); render(); });
// botão principal: converte o que falta; depois de pronto, baixa
$('#download').addEventListener('click', e => {
  const a = e.currentTarget.dataset.act;
  if(a === 'go') enqueue(pending());
  else if(a === 'dl') downloadAll();
});
// modo avançado: mostra os outros modos, ajustes finos e as ações extras de cada imagem
const adv = $('#adv');
function syncAdv(){
  document.querySelector('.cv').classList.toggle('is-adv', adv.open);
  try{ localStorage.setItem('cv-adv', adv.open ? '1' : ''); }catch{}
}
adv.addEventListener('toggle', () => {
  syncAdv();
  if(!adv.open && S.mode !== 'convert') setS({mode: 'convert'}); else render();
});
// atalhos prontos
$('#presets').addEventListener('click', e => {
  const b = e.target.closest('[data-p]'); if(!b) return;
  if(b.dataset.p === 'custom'){ $('#adv-fields').scrollIntoView({behavior: 'smooth', block: 'start'}); return; }
  const p = PRESETS.find(x => x.id === b.dataset.p); if(p) setS({...p.set});
});

// configurações
const segs = {'#mode':'mode', '#fmt':'fmt', '#fit':'fit', '#names':'names', '#fav-bg':'favBg', '#wm-type':'wmType', '#wm-pos':'wmPos', '#wm-color':'wmColor'};
for(const [sel, key] of Object.entries(segs)) $(sel).addEventListener('click', e => { const b = e.target.closest('[data-v]'); if(b) setS({[key]: b.dataset.v}); });
const onChange = (sel, key, fn = v => v) => $(sel).addEventListener('change', e => setS({[key]: fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value)}));
$('#q').addEventListener('input', e => { $('#q-out').textContent = e.target.value + '%'; });
onChange('#q', 'q', Number);
onChange('#maxkb', 'maxKB'); onChange('#optpng', 'optPng'); onChange('#size', 'size');
onChange('#cw', 'cw'); onChange('#ch', 'ch'); onChange('#bg', 'bg');
onChange('#kit-path', 'kitPath'); onChange('#kit-sizes', 'kitSizes');
onChange('#fav-color', 'favColor'); onChange('#fav-name', 'favName'); onChange('#fav-theme', 'favTheme');
$('#fav-pad').addEventListener('input', e => { $('#fav-pad-out').textContent = e.target.value + '%'; });
onChange('#fav-pad', 'favPad', Number);
onChange('#wm-on', 'wmOn'); onChange('#wm-text', 'wmText');
$('#wm-size').addEventListener('input', e => { $('#wm-size-out').textContent = e.target.value + '% da largura'; });
$('#wm-op').addEventListener('input', e => { $('#wm-op-out').textContent = e.target.value + '%'; });
onChange('#wm-size', 'wmSize', Number); onChange('#wm-op', 'wmOp', Number);
$('#kit-fmts').addEventListener('change', () => setS({kitFmts: $$('#kit-fmts input:checked').map(i => i.value)}));
$('#kit-widths').addEventListener('change', () => setS({kitWidths: $$('#kit-widths input:checked').map(i => +i.value)}));
$('#wm-logo-btn').addEventListener('click', () => $('#wm-logo').click());
$('#wm-logo').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if(!f) return;
  if(f.size > 1.5 * 1048576){ toast('Logo grande demais: use um arquivo de até 1,5 MB'); return; }
  const url = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  S.wmLogo = url; S.wmLogoName = f.name; S.wmType = 'logo'; S.wmOn = true;
  await loadWmLogo(); setS({});
});
// nomes só mudam o texto: atualiza sem jogar fora as conversões
const renameOnly = patch => {
  Object.assign(S, patch); saveS();
  const bases = outBases();
  items.forEach((it, i) => {
    if(it.out) it.out.name = `${bases[i]}.${FORMATS[it.out.fmt].ext}`;
    if(it.outs){ it.outs.forEach(o => { o.name = `${bases[i]}-${o.w}.${FORMATS[o.fmt].ext}`; }); it.snippet = pictureSnippet(it.outs); }
  });
  render();
};
$('#prefix').addEventListener('input', e => renameOnly({prefix: e.target.value}));
$('#start').addEventListener('input', e => renameOnly({start: e.target.value}));
$('#clean').addEventListener('change', e => renameOnly({clean: e.target.checked}));

// tema
const themeBtn = $('#theme');
function syncThemeBtn(){ const dark = document.documentElement.dataset.theme === 'dark'; const l = dark ? 'Ativar modo claro' : 'Ativar modo escuro'; themeBtn.setAttribute('aria-label', l); themeBtn.title = l; }
themeBtn.addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try{ localStorage.setItem('rx-theme', next); }catch{} syncThemeBtn(); });
syncThemeBtn();

// avisa antes de sair com resultados não baixados
window.addEventListener('beforeunload', e => {
  if(busy || items.some(i => i.status === 'done' && !i.saved) || (FAV && !FAV.saved)){ e.preventDefault(); e.returnValue = ''; }
});

/* ---------- início ---------- */
$('#size').innerHTML = SIZES.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
if(!FORMATS[S.fmt]) S.fmt = 'webp';
if(!SIZES.some(s => s.id === S.size)) S.size = 'original';
try{ adv.open = localStorage.getItem('cv-adv') === '1'; }catch{}
syncAdv();
if(!['convert', 'kit', 'favicon'].includes(S.mode) || !adv.open) S.mode = 'convert';
if(!Array.isArray(S.kitFmts)) S.kitFmts = DEFAULTS.kitFmts.slice();
if(!Array.isArray(S.kitWidths)) S.kitWidths = DEFAULTS.kitWidths.slice();
loadWmLogo().then(() => { renderSettings(); render(); });
renderSettings(); render();
