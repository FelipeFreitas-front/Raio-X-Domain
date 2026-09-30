// Editor de vídeo no navegador, organizado como o OpenCut: biblioteca, preview, propriedades e timeline.
// Trilhas: vídeo principal (magnético, com transições) + quantas trilhas livres quiser. Uma trilha nova começa
// genérica e vira de vídeo ou de áudio conforme o primeiro arquivo solto nela.
// Exporta em tempo real com MediaRecorder. Músicas e efeitos vêm do Openverse; elementos, do Iconify.
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FPS = 30, MIN = 0.1;
function fmtTime(t, cs = true){
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return cs ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}
const fmtSec = s => (+s).toFixed(1).replace('.', ',') + ' s';
function toast(msg){ const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(el._h); el._h = setTimeout(() => el.classList.remove('show'), 2800); }
const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const noAccent = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/* ---------- popups com efeito gelatinoso (animações em motion.css) ---------- */
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function gelHide(el, done){
  const tk = el._gel = {};
  el.classList.add('gel-out');
  const end = e => { if(e && e.target !== el) return; if(el._gel !== tk) return; el._gel = null; el.removeEventListener('animationend', end); el.classList.remove('gel-out'); done(); };
  if(calm()) return end();
  el.addEventListener('animationend', end); setTimeout(end, 400);
}
const gelShow = el => { el._gel = null; el.classList.remove('gel-out'); el.hidden = false; };
const gelOpen = d => { d._gel = null; d.classList.remove('gel-out'); if(!d.open) d.showModal(); };
const gelClose = d => { if(d.open && !d._gel) gelHide(d, () => d.close()); };
const isOpen = el => !el.hidden && !el._gel;

/* ---------- estado ---------- */
const media = new Map();            // arquivos importados (fora do desfazer)
// o que o desfazer guarda. Começa com a trilha de vídeo principal ('v') e uma trilha de áudio.
let S = {clips: [], ratio: '16:9', ratioAuto: true, bg: '#000000', tracks: [{id: 'a1', kind: 'audio'}], main: {}, master: {vol: 1, fx: []}};
let sel = null, selSet = new Set(), t = 0, playing = false, pps = 60, snapOn = true, dirty = true, layoutCache = null;
const hist = {past: [], future: []};
const RATIOS = {'16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5};
const TRS = [
  {id: 'fade', label: 'Dissolver'}, {id: 'black', label: 'Preto'}, {id: 'white', label: 'Flash'}, {id: 'slide', label: 'Deslizar'},
  {id: 'up', label: 'Subir'}, {id: 'zoom', label: 'Zoom'}, {id: 'wipe', label: 'Cortina'}, {id: 'circle', label: 'Círculo'},
];
const TR = Object.fromEntries(TRS.map(x => [x.id, x]));
const TRD = {type: 'fade', d: .6};   // última transição escolhida e duração padrão
const MAIN_TF = {x: .5, y: .5, s: 1, r: 0, op: 1};
/* ---------- transformação no tempo: keyframes, recorte e giro ---------- */
// c.tf = posição/tamanho fixos; c.kf = [{t, x, y, s, r, op}] (t = segundos desde o começo do clipe na timeline)
const TF_KEYS = ['x', 'y', 's', 'r', 'op'];
const baseTf = c => ({...(c.track === 'v' ? MAIN_TF : {x: .5, y: .5, s: .3, r: 0, op: 1}), ...(c.tf || {})});
const pickTf = o => Object.fromEntries(TF_KEYS.map(k => [k, o[k] ?? (k === 'op' ? 1 : 0)]));
const clipLen = c => { const e = entryOf(c); return e ? e.end - e.start : clipDur(c); };
const localT = c => { const e = entryOf(c); return e ? t - e.start : 0; };
const easeKf = x => x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
function tfAt(c, lt = localT(c)){
  const b = baseTf(c), kf = c.kf;
  if(!kf || !kf.length) return b;
  if(lt <= kf[0].t) return {...b, ...pickTf(kf[0])};
  const z = kf[kf.length - 1];
  if(lt >= z.t) return {...b, ...pickTf(z)};
  let i = 0; while(kf[i + 1].t < lt) i++;
  const a = kf[i], n = kf[i + 1], p = easeKf((lt - a.t) / Math.max(1e-6, n.t - a.t));
  const out = {...b};
  for(const k of TF_KEYS) out[k] = a[k] + (n[k] - a[k]) * p;
  return out;
}
const kfHere = c => { const lt = localT(c); return (c.kf || []).find(k => Math.abs(k.t - lt) < 1 / 50); };
// mexer no tamanho/posição: sem keyframes muda o fixo; com keyframes grava no ponto do cursor (cria se não existir)
function editTf(c, fn){
  if(c.kf?.length){
    const lt = clamp(localT(c), 0, clipLen(c));
    let k = c.kf.find(x => Math.abs(x.t - lt) < 1 / 50);
    if(!k){ k = {t: lt, ...pickTf(tfAt(c, lt))}; c.kf.push(k); c.kf.sort((a, b) => a.t - b.t); }
    fn(k);
  } else { c.tf = baseTf(c); fn(c.tf); }
}
// atalhos de animação prontos
const KF_PRESETS = {
  kenburns: {label: 'Zoom lento', f: (b, d) => [{t: 0, ...b, x: b.x - .02}, {t: d, ...b, s: b.s * 1.18, x: b.x + .02}]},
  zoomin: {label: 'Aproximar', f: (b, d) => [{t: 0, ...b}, {t: d, ...b, s: b.s * 1.4}]},
  zoomout: {label: 'Afastar', f: (b, d) => [{t: 0, ...b, s: b.s * 1.4}, {t: d, ...b}]},
  left: {label: 'Entrar pela esquerda', f: (b, d, w) => [{t: 0, ...b, x: -w / 2 - .02}, {t: Math.min(.7, d / 2), ...b}]},
  bottom: {label: 'Entrar por baixo', f: (b, d, w, h) => [{t: 0, ...b, y: 1 + h / 2 + .02}, {t: Math.min(.7, d / 2), ...b}]},
  fadein: {label: 'Aparecer', f: (b, d) => [{t: 0, ...b, op: 0}, {t: Math.min(.6, d / 2), ...b}]},
  pulse: {label: 'Pulsar', f: (b, d) => Array.from({length: Math.max(2, Math.floor(d / .5) + 1)}, (_, i) => ({t: Math.min(d, i * .5), ...b, s: b.s * (i % 2 ? 1.1 : 1)}))},
};
// dimensões da imagem depois do recorte e do giro de 90°
function srcDims(c){
  const m = media.get(c.mid), cr = c.crop;
  let w = m?.w || 16, h = m?.h || 9;
  if(cr){ w *= Math.max(.05, 1 - cr.l - cr.r); h *= Math.max(.05, 1 - cr.t - cr.b); }
  return (c.rot90 || 0) % 180 ? {w: h, h: w} : {w, h};
}


/* ---------- texto ---------- */
// um clipe de texto não tem arquivo: guarda o texto e o estilo em c.text. Tamanho da letra = fração da altura do vídeo
const FONTS = ['Inter', 'Poppins', 'Montserrat', 'Bebas Neue', 'Playfair Display', 'Permanent Marker'];
const TXT_BASE = {content: 'Seu texto aqui', font: 'Inter', weight: 700, italic: false, size: .08, color: '#ffffff', align: 'center',
  stroke: 0, strokeColor: '#000000', bg: 'none', bgColor: '#000000', bgOp: .6, shadow: 'soft', ain: 'fade', aout: 'fade'};
const TXT_PRESETS = [
  {id: 'titulo', label: 'Título', o: {content: 'TÍTULO', font: 'Bebas Neue', weight: 400, size: .17, stroke: .05, ain: 'pop'}},
  {id: 'sub', label: 'Subtítulo', o: {content: 'Subtítulo do vídeo', font: 'Inter', weight: 600, size: .06}},
  {id: 'legenda', label: 'Legenda', o: {content: 'Legenda aqui', font: 'Inter', weight: 700, size: .055, bg: 'box', bgOp: .7, shadow: 'none', ain: 'none', aout: 'none'}, y: .86},
  {id: 'destaque', label: 'Destaque', o: {content: 'OFERTA!', font: 'Poppins', weight: 800, size: .11, color: '#ffd21f', stroke: .09, strokeColor: '#111111', ain: 'pop'}},
  {id: 'neon', label: 'Neon', o: {content: 'neon', font: 'Montserrat', weight: 900, size: .11, color: '#63f5ff', shadow: 'glow'}},
  {id: 'elegante', label: 'Elegante', o: {content: 'Elegante', font: 'Playfair Display', weight: 700, italic: true, size: .1}},
  {id: 'mao', label: 'Manuscrito', o: {content: 'feito à mão', font: 'Permanent Marker', weight: 400, size: .09}},
  {id: 'etiqueta', label: 'Etiqueta', o: {content: 'Nome · Cargo', font: 'Poppins', weight: 600, size: .05, bg: 'box', bgColor: '#016a71', bgOp: 1, shadow: 'none', align: 'left', ain: 'up'}, x: .26, y: .8},
];
const TXT_ANIMS = {none: 'Nenhuma', fade: 'Aparecer', up: 'Subir', pop: 'Pop', type: 'Máquina de escrever'};
const textClip = (pid, over, start, dur, track, caption = false) => {
  const p = TXT_PRESETS.find(x => x.id === pid) || TXT_PRESETS[1];
  return {id: uid(), mid: null, in: 0, out: dur, speed: 1, volume: 1, muted: false, fit: 'contain', fi: 0, fo: 0, start, track, caption,
    text: {...TXT_BASE, ...p.o, ...over}, tf: {x: p.x ?? .5, y: caption ? .86 : p.y ?? .5, s: 1, r: 0, op: 1}};
};
const txtFont = (T, px) => `${T.italic ? 'italic ' : ''}${T.weight} ${px}px "${T.font}"`;
// fonte ainda não baixada: pede e redesenha quando chegar
function ensureFont(T){ const f = txtFont(T, 40); if(!document.fonts.check(f)) document.fonts.load(f).then(() => { dirty = true; }); }
const mctx = document.createElement('canvas').getContext('2d');
function textMetrics(c, W, H){
  const T = c.text, px = Math.max(4, T.size * H * (tfAt(c).s ?? 1));
  mctx.font = txtFont(T, px);
  const lines = (T.content || ' ').split('\n'), widths = lines.map(l => mctx.measureText(l).width);
  const lh = px * 1.2, pad = T.bg === 'box' ? px * .38 : px * .08;
  return {px, lines, widths, lh, pad, w: Math.max(px * .6, ...widths) + pad * 2, h: lines.length * lh + pad * 2};
}
const easeBack = x => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2);
// animação de entrada e saída do texto no instante atual
function textAnim(c, e){
  const T = c.text, lt = t - e.start, d = e.end - e.start, A = Math.min(.45, d / 3);
  const r = {alpha: 1, dy: 0, scale: 1, chars: Infinity};
  const pin = clamp(lt / A, 0, 1), pout = clamp((d - lt) / A, 0, 1);
  if(T.ain === 'fade') r.alpha *= pin;
  if(T.ain === 'up'){ r.alpha *= pin; r.dy += (1 - ease(pin)) * .06; }
  if(T.ain === 'pop'){ r.alpha *= Math.min(1, pin * 2); r.scale *= pin < 1 ? .5 + .5 * easeBack(pin) : 1; }
  if(T.ain === 'type') r.chars = Math.floor((T.content || '').length * clamp(lt / Math.min(1.4, d * .6), 0, 1));
  if(T.aout === 'fade') r.alpha *= pout;
  if(T.aout === 'up'){ r.alpha *= pout; r.dy -= (1 - ease(pout)) * .06; }
  if(T.aout === 'pop'){ r.alpha *= pout; r.scale *= .7 + .3 * pout; }
  return r;
}
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
function drawText(ctx, c, W, H){
  const T = c.text, e = entryOf(c); if(!e) return;
  ensureFont(T);
  const M = textMetrics(c, W, H), b = boxOf(c, W, H), an = textAnim(c, e);
  if(an.alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= (tfAt(c).op ?? 1) * an.alpha;
  ctx.translate(b.cx, b.cy + an.dy * H); ctx.rotate(b.r); ctx.scale(an.scale, an.scale);
  if(T.bg === 'box'){
    ctx.fillStyle = hexA(T.bgColor, T.bgOp);
    ctx.beginPath(); ctx.roundRect(-M.w / 2, -M.h / 2, M.w, M.h, M.px * .22); ctx.fill();
  }
  ctx.font = txtFont(T, M.px); ctx.textBaseline = 'middle'; ctx.textAlign = T.align; ctx.lineJoin = 'round';
  let left = an.chars;
  M.lines.forEach((ln, i) => {
    if(left <= 0) return;
    const txt = ln.slice(0, left); left -= ln.length + 1;
    const y = -M.h / 2 + M.pad + M.lh * (i + .5), x = T.align === 'left' ? -M.w / 2 + M.pad : T.align === 'right' ? M.w / 2 - M.pad : 0;
    ctx.save();
    if(T.shadow === 'soft'){ ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = M.px * .16; ctx.shadowOffsetY = M.px * .04; }
    if(T.shadow === 'glow'){ ctx.shadowColor = T.color; ctx.shadowBlur = M.px * .45; }
    if(T.stroke > 0){ ctx.lineWidth = M.px * T.stroke * 2; ctx.strokeStyle = T.strokeColor; ctx.strokeText(txt, x, y); if(T.shadow === 'soft') ctx.shadowColor = 'transparent'; }
    ctx.fillStyle = T.color; ctx.fillText(txt, x, y);
    if(T.shadow === 'glow'){ ctx.shadowBlur = M.px * .15; ctx.fillText(txt, x, y); }
    ctx.restore();
  });
  ctx.restore();
}

const clipDur = c => (c.out - c.in) / c.speed;
const clipById = id => S.clips.find(c => c.id === id);
const trackById = id => S.tracks.find(x => x.id === id);
const hasSound = c => { const m = media.get(c.mid); return !!m && m.kind !== 'image'; };
const sels = () => [...selSet].map(clipById).filter(Boolean);
// posições: vídeo em sequência (a transição puxa o clipe seguinte para cima do anterior); trilhas livres onde foram colocados
function layout(){
  let x = 0, prev = null; const v = [];
  for(const c of S.clips) if(c.track === 'v'){
    const d = clipDur(c);
    const td = prev && c.tr && TR[c.tr.type] ? Math.max(0, Math.min(c.tr.d, prev.end - prev.start - .1, d - .1)) : 0;
    const e = {c, start: x - td, end: x - td + d, td};
    v.push(e); x = e.end; prev = e;
  }
  const free = kind => S.clips.filter(c => c.track !== 'v' && trackById(c.track)?.kind === kind).map(c => ({c, start: c.start, end: c.start + clipDur(c)}));
  const a = free('audio'), o = free('video');
  // o vídeo termina onde acaba a imagem; música mais longa é cortada no fim (só áudio: vale o áudio)
  const vis = Math.max(x, ...o.map(e => e.end), 0), aEnd = Math.max(0, ...a.map(e => e.end));
  return {v, a, o, vEnd: x, total: vis || aEnd, end: Math.max(vis, aEnd)};
}
const L = () => layoutCache || (layoutCache = layout());
const entryOf = c => { const l = L(); return l.v.find(e => e.c === c) || l.a.find(e => e.c === c) || l.o.find(e => e.c === c); };
// ordem das trilhas na tela: vídeo/genéricas em cima (a de cima aparece na frente), principal, áudio embaixo
const upperTracks = () => S.tracks.filter(x => x.kind !== 'audio');
const audioTracks = () => S.tracks.filter(x => x.kind === 'audio');
const zOf = c => { const up = upperTracks(); return up.length - up.findIndex(x => x.id === c.track); };

/* ---------- desfazer / refazer ---------- */
const snap = () => JSON.stringify(S);
function pushHist(before){ hist.past.push(before); if(hist.past.length > 120) hist.past.shift(); hist.future = []; }
function edit(fn){ const before = snap(); fn(); if(snap() !== before) pushHist(before); changed(); }
function undo(){ if(!hist.past.length) return; hist.future.push(snap()); S = JSON.parse(hist.past.pop()); afterRestore(); }
function redo(){ if(!hist.future.length) return; hist.past.push(snap()); S = JSON.parse(hist.future.pop()); afterRestore(); }
function afterRestore(){ changed(); sizeScreen(); }
// mudanças contínuas (controle deslizante, arrastar no preview): guarda o "antes" uma vez e registra ao soltar
let liveBefore = null;
function live(fn){ if(liveBefore === null) liveBefore = snap(); fn(); layoutCache = null; dirty = true; }
function liveEnd(){ if(liveBefore !== null && liveBefore !== snap()) pushHist(liveBefore); liveBefore = null; changed(); }

function changed(){
  layoutCache = null;
  selSet = new Set([...selSet].filter(id => clipById(id)));
  if(sel && !selSet.has(sel)) sel = [...selSet].pop() || null;
  t = clamp(t, 0, L().total);
  normalize();
  renderTimeline(); renderProps(); updateUi();
  syncMixer(); if($('#mixer').open) renderMixer();
  syncMedia(!playing); dirty = true;
  pruneEls();
  markDirty();
}
// seleção: um clipe (ou vários); "sel" é o que aparece no painel
function select(id, add = false){
  if(add && id){ if(selSet.has(id)){ selSet.delete(id); if(sel === id) sel = [...selSet].pop() || null; } else { selSet.add(id); sel = id; } }
  else { selSet = new Set(id ? [id] : []); sel = id; }
  closeTrPop(); renderTimeline(); renderProps(); updateUi(); dirty = true;
}
function setSelection(ids){ selSet = new Set(ids); sel = ids[ids.length - 1] || null; }

/* ---------- importar arquivos ---------- */
const ICON = {
  video: '<svg viewBox="0 0 16 16"><rect x="1.8" y="3" width="12.4" height="10" rx="1.8"/><path d="M6.8 6v4l3.2-2z"/></svg>',
  image: '<svg viewBox="0 0 16 16"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><circle cx="5.5" cy="6.3" r="1.1"/><path d="M2.5 12l3.4-3 2.6 2.1 1.8-1.4 3.2 2.6"/></svg>',
  audio: '<svg viewBox="0 0 16 16"><path d="M6 12V3.5l7-1.5v8.5"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10.5" r="1.8"/></svg>',
  layer: '<svg viewBox="0 0 16 16"><path d="M8 2 1.5 5.5 8 9l6.5-3.5z"/><path d="M1.5 8.5 8 12l6.5-3.5"/></svg>',
  any: '<svg viewBox="0 0 16 16"><rect x="1.8" y="3.5" width="12.4" height="9" rx="2" stroke-dasharray="2 2"/><path d="M8 6v4M6 8h4"/></svg>',
  trans: '<svg viewBox="0 0 16 16"><path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/></svg>',
  plus: '<svg viewBox="0 0 12 12"><path d="M6 2v8M2 6h8"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M5 3.2v9.6L12.8 8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M5 3v10M11 3v10" style="fill:none;stroke-width:2.4"/></svg>',
};
function kindOf(f){
  const ty = f.type || '';
  if(ty.startsWith('video/')) return 'video';
  if(ty.startsWith('image/')) return 'image';
  if(ty.startsWith('audio/')) return 'audio';
  if(/\.(mp4|mov|webm|mkv|m4v|ogv)$/i.test(f.name)) return 'video';
  if(/\.(jpe?g|png|webp|gif|avif|bmp|svg)$/i.test(f.name)) return 'image';
  if(/\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i.test(f.name)) return 'audio';
  return null;
}
const once = (el, ok, bad, ms = 20000) => new Promise((res, rej) => {
  const off = () => { el.removeEventListener(ok, a); if(bad) el.removeEventListener(bad, b); clearTimeout(tm); };
  const a = () => { off(); res(); }, b = () => { off(); rej(new Error('erro ao ler')); };
  const tm = setTimeout(() => { off(); rej(new Error('demorou demais')); }, ms);
  el.addEventListener(ok, a); if(bad) el.addEventListener(bad, b);
});
const loadImg = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('imagem não suportada')); i.src = url; });
// miniatura 16:9 guardada como arquivo; figurinhas ficam inteiras e com fundo transparente
function thumbOf(src, sw, sh, sticker = false){
  const c = document.createElement('canvas'); c.width = 192; c.height = 108;
  const x = c.getContext('2d'), k = sticker ? Math.min(160 / sw, 92 / sh) : Math.max(192 / sw, 108 / sh);
  if(!sticker){ x.fillStyle = '#111'; x.fillRect(0, 0, 192, 108); }
  x.drawImage(src, (192 - sw * k) / 2, (108 - sh * k) / 2, sw * k, sh * k);
  return new Promise(r => c.toBlob(b => r(b ? URL.createObjectURL(b) : ''), sticker ? 'image/png' : 'image/jpeg', .72));
}
function waveOf(buf){
  const W = 800, H = 80, data = buf.getChannelData(0), step = Math.max(1, Math.floor(data.length / W));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--teal').trim() || '#016a71';
  let peak = 0.0001; const peaks = [];
  for(let i = 0; i < W; i++){ let m = 0; for(let j = i * step, e = Math.min(data.length, j + step); j < e; j += 8) m = Math.max(m, Math.abs(data[j])); peaks.push(m); peak = Math.max(peak, m); }
  peaks.forEach((m, i) => { const h = Math.max(1, m / peak * (H - 8)); x.fillRect(i, (H - h) / 2, 1, h); });
  return new Promise(r => c.toBlob(b => r(b ? URL.createObjectURL(b) : ''), 'image/png'));
}

// meta: {name, credit, sticker} para o que vem da biblioteca; autoAdd: onde colocar na timeline depois de ler
function addFiles(files, autoAdd = null, meta = null){
  let skipped = 0; const made = [];
  for(const f of files){
    const kind = kindOf(f);
    if(!kind){ skipped++; continue; }
    const m = {id: uid(), file: f, name: meta?.name || f.name, kind, url: URL.createObjectURL(f), duration: 0, w: 0, h: 0, thumbs: [], status: 'loading', credit: meta?.credit || null, sticker: !!meta?.sticker};
    media.set(m.id, m); made.push(m);
    ensureProject(); saveMedia(m);
    probe(m).then(() => { if(autoAdd && m.status === 'ready') addToTimeline(m, autoAdd); });
  }
  if(skipped) toast(skipped === 1 ? '1 arquivo ignorado: não é vídeo, foto nem áudio' : `${skipped} arquivos ignorados: não são vídeo, foto nem áudio`);
  renderMedia();
  return made;
}
async function probe(m){
  try{
    if(m.kind === 'image'){
      m.img = await loadImg(m.url);
      m.w = m.img.naturalWidth || 512; m.h = m.img.naturalHeight || 512; m.duration = 5;
      m.thumb = await thumbOf(m.img, m.w, m.h, m.sticker); m.thumbs = [{t: 0, url: m.thumb}];
      m.status = 'ready';
    } else if(m.kind === 'video'){
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = m.url;
      await once(v, 'loadedmetadata', 'error');
      if(!isFinite(v.duration)){ v.currentTime = 1e7; await once(v, 'durationchange', null, 8000).catch(() => {}); }
      m.duration = v.duration; m.w = v.videoWidth; m.h = v.videoHeight;
      if(!m.w){ m.kind = 'audio'; return probeAudio(m); }   // arquivo de vídeo só com som
      if(!isFinite(m.duration) || !m.duration) throw new Error('duração');
      m.status = 'ready'; renderMedia();
      // miniaturas ao longo do vídeo para a tira da timeline
      const n = clamp(Math.ceil(m.duration / 2), 4, 30);
      for(let i = 0; i < n; i++){
        const tt = Math.min(m.duration - .05, (i + .5) * m.duration / n);
        v.currentTime = tt;
        try{ await once(v, 'seeked', 'error', 6000); }catch{ break; }
        const url = await thumbOf(v, m.w, m.h);
        m.thumbs.push({t: tt, url});
        if(i === 0){ m.thumb = url; renderMedia(); }
        if(i % 4 === 3) renderTimeline();
      }
      v.removeAttribute('src'); v.load();
    } else await probeAudio(m);
  }catch{
    m.status = 'bad';
    m.err = m.kind === 'video' ? 'o navegador não abre este vídeo (tente MP4 H.264)' : m.kind === 'audio' ? 'o navegador não abre este áudio' : 'imagem não suportada';
  }
  renderMedia(); renderTimeline(); renderProps();
}
async function probeAudio(m){
  const a = new Audio(); a.preload = 'metadata'; a.src = m.url;
  await once(a, 'loadedmetadata', 'error');
  m.duration = a.duration;
  if(!isFinite(m.duration) || !m.duration) throw new Error('duração');
  m.status = 'ready'; renderMedia();
  if(m.file.size < 150 * 1048576){
    try{
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
      m.wave = await waveOf(await ctx.decodeAudioData(await m.file.arrayBuffer()));
    }catch{}
  }
}
function renderMedia(){
  const list = [...media.values()];
  $('#media-empty').hidden = !!list.length;
  $('#media-grid').hidden = !list.length;
  $('#media-grid').innerHTML = list.map(m => {
    const img = m.kind === 'audio' ? m.wave : m.thumb;
    return `<li class="mi ${m.status}" draggable="${m.status === 'ready'}" data-mid="${m.id}" title="${esc(m.name)}">
      <div class="mi-thumb${m.kind === 'audio' ? ' wave' : ''}${m.sticker ? ' sticker' : ''}">${img ? `<img src="${img}" alt="">` : ICON[m.kind].replace('<svg', '<svg class="ph"')}
        ${m.duration && m.kind !== 'image' ? `<span class="mi-dur">${fmtTime(m.duration, false)}</span>` : ''}
        <span class="mi-kind">${ICON[m.kind]}</span></div>
      <span class="mi-name">${esc(m.name)}</span>
      ${m.status === 'bad' ? `<span class="mi-err">${esc(m.err)}</span>` : ''}
      ${m.status === 'ready' ? `<button class="mi-add" type="button" data-act="add" title="${m.sticker ? 'Pôr por cima do vídeo' : 'Colocar na timeline'}" aria-label="Colocar ${esc(m.name)} na timeline">${ICON.plus}</button>` : ''}
      <button class="mi-rm" type="button" data-act="rm" title="Remover arquivo" aria-label="Remover ${esc(m.name)}"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>
    </li>`;
  }).join('');
}

/* ---------- trilhas ---------- */
function newTrack(kind){
  const tr = {id: 't' + uid(), kind};
  if(kind === 'audio') S.tracks.push(tr); else S.tracks.unshift(tr);   // vídeo nasce em cima de tudo
  return tr.id;
}
// trilha genérica vira de vídeo ou de áudio; as de áudio descem para baixo da principal
function convertTrack(tr, kind){
  if(tr.kind === kind) return;
  tr.kind = kind;
  if(kind === 'audio'){ S.tracks.splice(S.tracks.indexOf(tr), 1); S.tracks.push(tr); }
}
// escolhe onde cabe um clipe livre: na trilha pedida; senão numa do mesmo tipo livre no trecho; senão numa genérica; senão cria
function pickTrack(kind, start, end, pref = null, except = null){
  const fits = tr => !S.clips.some(x => x !== except && x.track === tr.id && x.start < end - 1e-3 && x.start + clipDur(x) > start + 1e-3);
  const p = pref && trackById(pref);
  if(p && (p.kind === kind || p.kind === 'any') && fits(p)){ convertTrack(p, kind); return p.id; }
  const same = S.tracks.filter(x => x.kind === kind);
  for(const tr of kind === 'video' ? same.slice().reverse() : same) if(fits(tr)) return tr.id;
  const any = S.tracks.find(x => x.kind === 'any' && fits(x));
  if(any){ convertTrack(any, kind); return any.id; }
  return newTrack(kind);
}
const defaultTf = m => ({x: .5, y: .5, s: m.sticker ? .22 : .42, r: 0, op: 1});
// coloca na timeline. opt.track: 'v' (principal), id de uma trilha, ou nada (decide sozinho)
function addToTimeline(m, opt = {}){
  const c = {id: uid(), mid: m.id, in: 0, out: m.sticker ? 4 : m.duration, speed: 1, volume: 1, muted: false, fit: 'contain', fi: 0, fo: 0};
  const wasEmpty = !S.clips.length;
  edit(() => {
    const pref = opt.track && opt.track !== 'v' ? opt.track : null;
    if(m.kind === 'audio'){
      const first = audioTracks()[0];
      const ends = first ? S.clips.filter(x => x.track === first.id).map(x => x.start + clipDur(x)) : [];
      c.start = Math.max(0, opt.start ?? (ends.length ? Math.max(...ends) : 0));
      c.track = pickTrack('audio', c.start, c.start + clipDur(c), pref || first?.id);
      S.clips.push(c);
    } else if(opt.track === 'v' || (!opt.track && !m.sticker)){
      c.track = 'v';
      const vs = S.clips.filter(x => x.track === 'v'), i = opt.index ?? vs.length;
      if(i >= vs.length) S.clips.push(c); else S.clips.splice(S.clips.indexOf(vs[i]), 0, c);
      // formato do projeto segue o primeiro vídeo até a pessoa escolher outro
      if(S.ratioAuto && vs.length === 0) S.ratio = m.h > m.w * 1.15 ? (m.h / m.w < 1.5 ? '4:5' : '9:16') : m.w > m.h * 1.15 ? '16:9' : '1:1';
    } else {
      c.start = Math.max(0, opt.start ?? t);
      c.track = pickTrack('video', c.start, c.start + clipDur(c), pref);
      c.tf = defaultTf(m);
      S.clips.push(c);
    }
    setSelection([c.id]);
  });
  if(wasEmpty || autoFit) zoomFit();
  changed(); sizeScreen();
}

/* ---------- timeline ---------- */
const content = $('#tl-content'), scroller = $('#tl-scroll'), tracksEl = $('#tracks'), headsEl = $('#heads');
const TILE_W = 104;
function rows(){
  const up = upperTracks(), vids = up.filter(x => x.kind === 'video');
  return [
    ...up.map(x => ({k: x.kind === 'any' ? 'any' : 'o', id: x.id, name: x.name, n: x.kind === 'video' ? vids.length - vids.indexOf(x) + 1 : 0})),
    {k: 'v', id: 'v', n: 1},
    ...audioTracks().map((x, i) => ({k: 'a', id: x.id, name: x.name, n: i + 1})),
  ];
}
function clipHTML(e){
  const c = e.c, m = media.get(c.mid), x = e.start * pps, w = Math.max(3, (e.end - e.start) * pps);
  const aud = m?.kind === 'audio', free = c.track !== 'v';
  let inner = '';
  if(c.text) inner = `<span class="txt-prev" style="font-family:'${esc(c.text.font)}';font-weight:${c.text.weight}">${esc(c.text.content.replace(/\n/g, ' '))}</span>`;
  else if(!aud && m?.thumbs.length){
    const tiles = [], tw = free ? 60 : TILE_W;
    for(let px = 0; px < w; px += tw){
      const mt = c.in + (px + tw / 2) / pps * c.speed;
      let best = m.thumbs[0];
      for(const th of m.thumbs) if(Math.abs(th.t - mt) < Math.abs(best.t - mt)) best = th;
      tiles.push(`<span style="width:${Math.min(tw, w - px)}px;background-image:url(${best.url})"></span>`);
    }
    inner = `<div class="strip">${tiles.join('')}</div>`;
  } else if(aud && m?.wave){
    inner = `<div class="wave" style="background-image:url(${m.wave});background-size:${m.duration / c.speed * pps}px 100%;background-position:${-c.in / c.speed * pps}px 0"></div>`;
  }
  // entrada e saída suave do som: triângulo desenhado + bolinhas para arrastar
  if(hasSound(c)){
    // a saída suave termina onde o vídeo acaba, se o clipe passar do fim
    const fi = (c.fi || 0) * pps, fo = (c.fo || 0) * pps, cut = (e.end - cutEnd(e)) * pps;
    inner += `${fi ? `<span class="afade in" style="width:${fi}px"></span>` : ''}${fo ? `<span class="afade out" style="width:${fo}px;right:${cut}px"></span>` : ''}
      <span class="fh in${fi ? ' on' : ''}" style="left:${Math.max(6, fi)}px" title="Arraste: o som começa baixinho e vai subindo"></span>
      <span class="fh out${fo ? ' on' : ''}" style="right:${Math.max(6, fo + cut)}px" title="Arraste: o som vai sumindo no fim"></span>`;
  }
  if(c.kf?.length && media.get(c.mid)?.kind !== 'audio') inner += c.kf.map(k => `<i class="kfd" data-kt="${k.t}" style="left:${k.t * pps}px" title="Keyframe em ${fmtTime(k.t)} (clique para ir até ele)"></i>`).join('');
  const tags = [c.speed !== 1 ? `${c.speed}×` : '', c.muted ? 'mudo' : '', c.rot90 ? `${c.rot90}°` : ''].filter(Boolean).join(' · ');
  const kind = c.track === 'v' ? 'v' : aud ? 'a' : c.text ? 'o t' : 'o';
  return `<div class="clip ${kind}${selSet.has(c.id) ? ' sel' : ''}${selSet.size > 1 && selSet.has(c.id) ? ' multi' : ''}${w < 60 ? ' narrow' : ''}" data-id="${c.id}" style="left:${x}px;width:${w}px">${inner}
    <span class="clip-name">${c.text ? (c.caption ? 'Legenda' : 'Texto') : esc(m?.name || 'arquivo removido')}</span>${tags ? `<span class="clip-tag">${tags}</span>` : ''}
    <span class="h l" title="Arraste para cortar o começo"></span><span class="h r" title="Arraste para cortar o fim"></span></div>`;
}
function renderRuler(width){
  const steps = [.1, .2, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find(s => s * pps >= 72) || 600;
  const minor = step / (step * pps >= 150 ? 10 : 5);
  const out = [], end = width / pps;
  for(let i = 0, tt = 0; tt <= end; i++, tt = i * minor){
    const big = Math.abs(tt / step - Math.round(tt / step)) < 1e-6;
    const lbl = big ? `<span>${fmtTime(tt, false)}${step < 1 ? '.' + Math.round((tt % 1) * 10) : ''}</span>` : '';
    out.push(`<i class="tick${big ? ' big' : ''}" style="left:${(tt * pps).toFixed(1)}px">${lbl}</i>`);
  }
  $('#ruler').innerHTML = out.join('');
}
// controles de cada trilha (como no CapCut): travar, esconder, mutar, renomear e menu
const trkCfg = id => id === 'v' ? S.main : trackById(id);
const isLocked = id => !!trkCfg(id)?.locked;
const isHidden = id => !!trkCfg(id)?.hidden;
const TI = {
  lock: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
  unlock: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>',
  eye: '<svg viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5l11 11M6.4 4a6.9 6.9 0 0 1 1.6-.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.8 2.3M9.8 11.9A6 6 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a11.6 11.6 0 0 1 2.4-2.9"/></svg>',
  vol: '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/></svg>',
  volOff: '<svg viewBox="0 0 16 16"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M11 6l3.5 4M14.5 6 11 10"/></svg>',
  more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>',
};
const trackName = r => r.k === 'v' ? (S.main.name || 'Vídeo 1') : r.name || (r.k === 'any' ? 'Nova trilha' : r.k === 'o' ? 'Vídeo ' + r.n : 'Áudio ' + r.n);
function headHTML(r){
  const cfg = trkCfg(r.id) || {}, fxN = (cfg.fx || []).filter(f => f.on).length;
  const icon = r.k === 'v' ? ICON.video : r.k === 'a' ? ICON.audio : r.k === 'any' ? ICON.any : ICON.layer;
  const b = (act, on, a, b2, title) => `<button type="button" data-act="${act}" aria-pressed="${!!on}" title="${title}">${on ? a : b2}</button>`;
  return `<div class="th ${r.k}${cfg.locked ? ' is-locked' : ''}${cfg.hidden ? ' is-hidden' : ''}${cfg.mute ? ' is-muted' : ''}" data-track="${r.id}" title="${r.k === 'v' ? 'Trilha principal: os clipes ficam colados um no outro' : r.k === 'any' ? 'Trilha nova: vira de vídeo ou de áudio conforme o que você soltar nela' : ''}">
    <div class="th-top">${icon}<span class="th-name" title="Dois cliques para renomear">${esc(trackName(r))}</span>${fxN ? `<button class="th-fx" type="button" data-act="mixer" title="${fxN} ${fxN === 1 ? 'efeito' : 'efeitos'} nesta trilha">fx</button>` : ''}</div>
    <div class="th-btns">
      ${b('lock', cfg.locked, TI.lock, TI.unlock, cfg.locked ? 'Destravar trilha' : 'Travar trilha (os clipes não mexem)')}
      ${r.k !== 'a' ? b('hide', cfg.hidden, TI.eyeOff, TI.eye, cfg.hidden ? 'Mostrar no vídeo' : 'Esconder do vídeo') : ''}
      ${b('mute', cfg.mute, TI.volOff, TI.vol, cfg.mute ? 'Ligar o som da trilha' : 'Mutar a trilha toda')}
      <button type="button" data-act="menu" title="Mais opções da trilha" aria-haspopup="menu">${TI.more}</button>
    </div>
  </div>`;
}
function renderTimeline(){
  const l = L(), R = rows();
  const width = Math.max(scroller.clientWidth, (l.end + 8) * pps);
  content.style.width = width + 'px';
  renderRuler(width);
  // faixas finas no topo e no fim: soltar ali cria uma trilha nova
  headsEl.innerHTML = '<div class="th new-zone"></div>' + R.map(headHTML).join('') + '<div class="th new-zone"></div>';
  const zone = w => `<div class="track new-zone" data-new="${w}"><span>${w === 'top' ? 'Solte aqui para criar uma trilha de vídeo' : 'Solte aqui para criar uma trilha de áudio'}</span></div>`;
  tracksEl.innerHTML = zone('top') + R.map(r => {
    const cfg = trkCfg(r.id) || {}, st = `${cfg.locked ? ' is-locked' : ''}${cfg.hidden ? ' is-hidden' : ''}${cfg.mute ? ' is-muted' : ''}`;
    if(r.k === 'v'){
      const marks = l.v.slice(1).map(e => {
        const on = e.td > 0, mid = e.start + e.td / 2;
        return `${on ? `<span class="tr-zone" style="left:${e.start * pps}px;width:${e.td * pps}px"></span>` : ''}<button class="tr-mark${on ? ' on' : ''}" type="button" data-tr="${e.c.id}" style="left:${mid * pps}px" title="${on ? 'Transição: ' + TR[e.c.tr.type].label : 'Adicionar transição'}" aria-label="${on ? 'Transição: ' + TR[e.c.tr.type].label : 'Adicionar transição'}">${on ? ICON.trans : ICON.plus}</button>`;
      }).join('');
      return `<div class="track v${st}" data-track="v">${l.v.map(clipHTML).join('') || '<span class="track-empty">Arraste vídeos e fotos para cá</span>'}${marks}</div>`;
    }
    const list = [...l.o, ...l.a].filter(e => e.c.track === r.id);
    const hint = r.k === 'any' ? 'Solte um vídeo, foto ou áudio: a trilha vira desse tipo' : r.k === 'a' ? 'Arraste músicas para cá (ou use a aba Músicas)' : '';
    return `<div class="track ${r.k}${st}" data-track="${r.id}">${list.map(clipHTML).join('')}${!list.length && hint ? `<span class="track-empty">${hint}</span>` : ''}</div>`;
  }).join('') + zone('bottom') + (l.total && l.end > l.total + .05 ? `<div class="tl-end" style="left:${l.total * pps}px" title="Depois daqui não entra no vídeo"><span>fim do vídeo</span></div>` : '');
  placePlayhead();
  renderHint();
}
function renderHint(){
  const c = sel && clipById(sel);
  $('#tl-hint').textContent = !S.clips.length ? 'Arraste arquivos para a timeline ou use o + em cada arquivo'
    : selSet.size > 1 ? `${selSet.size} clipes selecionados · arraste um deles para mover todos · Delete exclui`
    : c ? (c.track === 'v' || media.get(c.mid)?.kind !== 'audio' ? 'Clique no vídeo do preview para mover e redimensionar · bordas do clipe cortam · S divide' : 'Bolinhas no topo do clipe suavizam a entrada e a saída do som')
    : 'Arraste num espaço vazio para selecionar vários · o losango entre dois clipes adiciona transição';
}
function placePlayhead(follow = false){
  const x = t * pps;
  $('#playhead').style.transform = `translateX(${x}px)`;
  if(follow){ const vw = scroller.clientWidth; if(x > scroller.scrollLeft + vw - 40 || x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - 40); }
}
scroller.addEventListener('scroll', () => { headsEl.style.transform = `translateY(${-scroller.scrollTop}px)`; });
const capture = (el, e) => { try{ el.setPointerCapture(e.pointerId); }catch{} };
const xToTime = ev => Math.max(0, (ev.clientX - content.getBoundingClientRect().left) / pps);

// ímã: gruda no cursor, no começo e nas bordas dos outros clipes
function snapPoints(except){
  const l = L(), pts = [0, t], ex = except instanceof Set ? except : new Set(except ? [except] : []);
  const vi = ex.size === 1 && [...ex][0].track === 'v' ? l.v.findIndex(e => ex.has(e.c)) : -1;
  l.v.forEach((e, i) => { if(!ex.has(e.c) && (vi < 0 || i < vi)) pts.push(e.start, e.end); });
  for(const e of [...l.a, ...l.o]) if(!ex.has(e.c)) pts.push(e.start, e.end);
  return pts;
}
function snapTo(val, pts){
  const mark = $('#snap-mark');
  if(!snapOn){ mark.hidden = true; return val; }
  const th = 8 / pps; let best = null;
  for(const p of pts) if(Math.abs(p - val) <= th && (best === null || Math.abs(p - val) < Math.abs(best - val))) best = p;
  mark.hidden = best === null;
  if(best !== null){ mark.style.left = best * pps + 'px'; return best; }
  return val;
}

content.addEventListener('pointerdown', e => {
  if(e.button !== 0 || e.target.closest('.tr-mark')) return;
  const kd = e.target.closest('.kfd');
  if(kd){ const c = clipById(kd.closest('.clip').dataset.id), en = c && entryOf(c); if(en){ if(sel !== c.id) select(c.id); if(playing) pause(); seek(en.start + +kd.dataset.kt); renderProps(); } return; }
  const clipEl = e.target.closest('.clip');
  if(clipEl) return dragClip(e, clipEl);
  if(e.target.closest('#ph-grip, #ruler')) return scrub(e);
  marquee(e);
});
content.addEventListener('click', e => { const m = e.target.closest('.tr-mark'); if(m) openTrPop(m); });
headsEl.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const id = b.closest('.th')?.dataset.track, cfg = id && trkCfg(id); if(!cfg) return;
  const a = b.dataset.act;
  if(a === 'lock'){ edit(() => { cfg.locked = !cfg.locked; }); toast(cfg.locked ? 'Trilha travada: os clipes dela não mexem' : 'Trilha destravada'); }
  else if(a === 'hide'){ edit(() => { cfg.hidden = !cfg.hidden; }); toast(cfg.hidden ? 'Trilha escondida do vídeo' : 'Trilha visível de novo'); }
  else if(a === 'mute') edit(() => { cfg.mute = !cfg.mute; });
  else if(a === 'mixer') openMixer(id);
  else if(a === 'menu') openTrkMenu(b, id);
});
headsEl.addEventListener('dblclick', e => { const n = e.target.closest('.th-name'); if(n) renameTrack(n.closest('.th').dataset.track); });
$('#add-layer').addEventListener('click', () => { edit(() => { S.tracks.unshift({id: 't' + uid(), kind: 'any'}); }); toast('Trilha nova: solte um vídeo, foto ou áudio nela'); });
// renomear direto no nome da trilha
function renameTrack(id){
  const n = headsEl.querySelector(`.th[data-track="${id}"] .th-name`), cfg = trkCfg(id); if(!n || !cfg) return;
  const inp = document.createElement('input');
  inp.className = 'th-input'; inp.value = n.textContent; inp.maxLength = 30;
  n.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = ok => { if(done) return; done = true; if(ok){ const v = inp.value.trim(); edit(() => { cfg.name = v || undefined; }); } else renderTimeline(); };
  inp.addEventListener('keydown', ev => { ev.stopPropagation(); if(ev.key === 'Enter') finish(true); if(ev.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
}
// menu ⋯ da trilha
let trkMenuFor = null;
function openTrkMenu(btn, id){
  const m = $('#trk-menu'), main = id === 'v', has = S.clips.some(c => c.track === id);
  const tr = trackById(id), group = tr ? S.tracks.filter(x => (x.kind === 'audio') === (tr.kind === 'audio')) : [], gi = group.indexOf(tr);
  if(isOpen(m) && trkMenuFor === id){ closeTrkMenu(); return; }
  trkMenuFor = id;
  m.innerHTML = [['rename', 'Renomear'], ['mixer', 'Volume e efeitos (mixer)'],
    !main && gi > 0 && ['up', 'Subir a trilha'], !main && gi >= 0 && gi < group.length - 1 && ['down', 'Descer a trilha'],
    !main && ['del', has ? 'Excluir a trilha e os clipes dela' : 'Excluir a trilha']].filter(Boolean)
    .map(([a, l]) => `<button type="button" role="menuitem" data-a="${a}"${a === 'del' ? ' class="danger"' : ''}>${l}</button>`).join('');
  if(!m.hidden){ m.hidden = true; void m.offsetWidth; }
  gelShow(m);
  const r = btn.getBoundingClientRect();
  m.style.left = clamp(r.left, 8, innerWidth - m.offsetWidth - 8) + scrollX + 'px';
  const up = r.bottom + m.offsetHeight + 8 > innerHeight;
  m.style.top = (up ? r.top - m.offsetHeight - 6 : r.bottom + 6) + scrollY + 'px';
  m.style.setProperty('--gel-origin', up ? '10px 100%' : '10px 0');
}
function closeTrkMenu(){ const m = $('#trk-menu'); trkMenuFor = null; if(isOpen(m)) gelHide(m, () => { m.hidden = true; }); }
$('#trk-menu').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if(!b) return;
  const id = trkMenuFor, a = b.dataset.a; closeTrkMenu();
  if(a === 'rename') return renameTrack(id);
  if(a === 'mixer') return openMixer(id);
  const tr = trackById(id); if(!tr) return;
  if(a === 'up' || a === 'down'){
    const group = S.tracks.filter(x => (x.kind === 'audio') === (tr.kind === 'audio')), other = group[group.indexOf(tr) + (a === 'up' ? -1 : 1)];
    if(other) edit(() => { const i = S.tracks.indexOf(tr), j = S.tracks.indexOf(other); S.tracks[i] = other; S.tracks[j] = tr; });
  } else if(a === 'del'){
    const n = S.clips.filter(c => c.track === id).length;
    if(n && !confirm(`Excluir a trilha e ${n === 1 ? 'o clipe' : `os ${n} clipes`} dela?`)) return;
    edit(() => { S.clips = S.clips.filter(c => c.track !== id); S.tracks = S.tracks.filter(x => x.id !== id); });
  }
});
document.addEventListener('pointerdown', e => { if(trkMenuFor && !e.target.closest('#trk-menu, [data-act="menu"]')) closeTrkMenu(); });
function scrub(e){
  const wasPlaying = playing; if(playing) pause();
  capture(content, e);
  const l = L(), pts = [0, ...[...l.v, ...l.a, ...l.o].flatMap(x => [x.start, x.end])];
  const go = ev => seek(snapOn ? snapTo(xToTime(ev), pts) : xToTime(ev));
  go(e);
  const mv = ev => go(ev);
  const up = () => { content.removeEventListener('pointermove', mv); content.removeEventListener('pointerup', up); content.removeEventListener('pointercancel', up); $('#snap-mark').hidden = true; if(wasPlaying) play(); };
  content.addEventListener('pointermove', mv); content.addEventListener('pointerup', up); content.addEventListener('pointercancel', up);
}
// arrastar num espaço vazio desenha um retângulo e seleciona os clipes dentro dele; só clicar leva o cursor até ali
function marquee(e){
  const cr = content.getBoundingClientRect(), x0 = e.clientX - cr.left, y0 = e.clientY - cr.top;
  const add = e.shiftKey || e.ctrlKey || e.metaKey, base = add ? [...selSet] : [];
  const box = $('#marquee');
  let moved = false;
  capture(content, e);
  const mv = ev => {
    const x1 = ev.clientX - cr.left, y1 = ev.clientY - cr.top;
    if(!moved && Math.hypot(x1 - x0, y1 - y0) < 5) return;
    if(!moved && playing) pause();
    moved = true;
    const L_ = Math.min(x0, x1), T_ = Math.min(y0, y1), R_ = Math.max(x0, x1), B_ = Math.max(y0, y1);
    Object.assign(box.style, {left: L_ + 'px', top: T_ + 'px', width: R_ - L_ + 'px', height: B_ - T_ + 'px'}); box.hidden = false;
    const hits = $$('.clip').filter(el => !el.closest('.is-locked')).filter(el => { const r = el.getBoundingClientRect(); const l = r.left - cr.left, tp = r.top - cr.top; return l < R_ && l + r.width > L_ && tp < B_ && tp + r.height > T_; }).map(el => el.dataset.id);
    setSelection([...new Set([...base, ...hits])]);
    $$('.clip').forEach(el => { const on = selSet.has(el.dataset.id); el.classList.toggle('sel', on); el.classList.toggle('multi', on && selSet.size > 1); });
  };
  const up = ev => {
    content.removeEventListener('pointermove', mv); content.removeEventListener('pointerup', up); content.removeEventListener('pointercancel', up);
    box.hidden = true;
    if(!moved){ if(!add && selSet.size) select(null); seek(xToTime(ev)); return; }
    closeTrPop(); renderTimeline(); renderProps(); updateUi(); dirty = true;
  };
  content.addEventListener('pointermove', mv); content.addEventListener('pointerup', up); content.addEventListener('pointercancel', up);
}
// trilha debaixo do ponteiro (ou a faixa de "nova trilha" no topo/fim)
function trackUnder(ev){
  const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.track');
  if(!el || !tracksEl.contains(el)) return null;
  if(el.dataset.new) return {zone: el.dataset.new, el};
  return {id: el.dataset.track, el, cfg: trkCfg(el.dataset.track)};
}
function dragClip(e, el){
  const c = clipById(el.dataset.id); if(!c) return;
  if(isLocked(c.track)){ toast('Trilha travada: clique no cadeado para destravar'); return; }
  const add = e.shiftKey || e.ctrlKey || e.metaKey;
  if(add){ select(c.id, true); return; }   // Shift/Ctrl + clique: soma ou tira da seleção
  const wasIn = selSet.has(c.id) && selSet.size > 1;
  if(!selSet.has(c.id)){ setSelection([c.id]); closeTrPop(); $$('.clip').forEach(x => x.classList.toggle('sel', x === el)); $$('.clip.multi').forEach(x => x.classList.remove('multi')); renderProps(); renderHint(); updateUi(); dirty = true; }
  else sel = c.id;
  const fh = e.target.closest('.fh'), h = e.target.closest('.h');
  const mode = fh ? (fh.classList.contains('in') ? 'fi' : 'fo') : h ? (h.classList.contains('l') ? 'trimL' : 'trimR') : 'move';
  const m = media.get(c.mid), still = !!c.text || m?.kind === 'image', maxOut = still ? 3600 : (m?.duration || c.out), free = c.track !== 'v';
  const kind = m?.kind === 'audio' ? 'audio' : 'video', visual = kind === 'video';
  // em grupo: move junto os clipes livres selecionados
  const group = mode === 'move' && free && wasIn ? sels().filter(x => x.track !== 'v' && !isLocked(x.track)) : [c];
  const before = snap(), x0 = e.clientX, y0 = e.clientY, e0 = entryOf(c), o = {in: c.in, out: c.out, start: e0.start, end: e0.end, fi: c.fi || 0, fo: c.fo || 0};
  const starts = new Map(group.map(g => [g, g.start]));
  const pts = snapPoints(new Set(group));
  let moved = false, dropIdx = null, target = null, lastDx = 0, ghost = null;
  const hot = elx => { $$('.track.drop-here').forEach(x => x !== elx && x.classList.remove('drop-here')); elx?.classList.add('drop-here'); };
  const showGhost = ev => {
    if(!ghost){ ghost = document.createElement('div'); ghost.className = 'clip-ghost'; ghost.textContent = c.text ? c.text.content.split('\n')[0] : m?.name || 'clipe'; document.body.appendChild(ghost); }
    ghost.style.left = ev.clientX + 12 + 'px'; ghost.style.top = ev.clientY + 12 + 'px';
  };
  const dropGhost = () => { ghost?.remove(); ghost = null; };
  capture(content, e);
  const mv = ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if(!moved && Math.hypot(dx, dy) < 4) return;
    if(!moved && playing) pause();
    moved = true; lastDx = dx;
    const dt = dx / pps, dur = o.end - o.start, vdur = cutEnd(e0) - o.start;
    if(mode === 'fi') c.fi = clamp(o.fi + dt, 0, vdur - (c.fo || 0));
    else if(mode === 'fo') c.fo = clamp(o.fo - dt, 0, vdur - (c.fi || 0));
    else if(mode === 'trimR'){
      const end = snapTo(o.end + dt, pts);
      c.out = clamp(o.in + (end - o.start) * c.speed, o.in + MIN * c.speed, maxOut);
    } else if(mode === 'trimL'){
      if(!free){ if(still) c.out = clamp(o.out - dt, c.in + MIN, 3600); else c.in = clamp(o.in + dt * c.speed, 0, o.out - MIN * c.speed); }
      else {
        let d = snapTo(o.start + dt, pts) - o.start;
        if(still){ d = clamp(d, -o.start, o.out - o.in - MIN); c.start = o.start + d; c.out = o.out - d; }
        else {
          let nin = clamp(o.in + d * c.speed, 0, o.out - MIN * c.speed);
          if(o.start + (nin - o.in) / c.speed < 0) nin = o.in - o.start * c.speed;
          c.in = nin; c.start = o.start + (nin - o.in) / c.speed;
        }
      }
    } else {
      // subir/descer: trilha principal ↔ trilhas de cima, ou faixa de nova trilha. Aplicado ao soltar
      const tu = group.length === 1 ? trackUnder(ev) : null;
      target = null;
      if(tu?.zone && ((tu.zone === 'top' && visual) || (tu.zone === 'bottom' && !visual))) target = tu;
      else if(tu?.id && !tu.cfg?.locked){
        if(!free && visual && tu.id !== 'v' && ['video', 'any'].includes(tu.cfg?.kind)) target = tu;
        else if(free && visual && !c.text && tu.id === 'v') target = tu;
      }
      if(target){
        hot(target.el); showGhost(ev);
        const mark = $('#drop-mark'); mark.hidden = false;
        if(target.id === 'v'){ const {v} = L(), tt = xToTime(ev), i = v.findIndex(x => tt < (x.start + x.end) / 2); mark.style.left = (i < 0 ? L().vEnd : v[i].start) * pps + 'px'; }
        else mark.style.left = Math.max(0, o.start + dt) * pps + 'px';
        el.classList.add('dragging');
        return;
      }
      dropGhost(); hot(null); el.classList.remove('dragging');
      if(free){
        let ns = o.start + dt;
        const a1 = snapTo(ns, pts);
        if(a1 !== ns) ns = a1; else { const b1 = snapTo(ns + dur, pts); if(b1 !== ns + dur) ns = b1 - dur; }
        // o grupo anda junto e ninguém passa do começo
        const minStart = Math.min(...group.map(g => starts.get(g)));
        const shift = Math.max(ns - o.start, -minStart);
        group.forEach(g => { g.start = starts.get(g) + shift; });
        // entre trilhas do mesmo tipo (ou genéricas), a troca é na hora
        if(tu?.id && tu.id !== 'v' && tu.id !== c.track && !tu.cfg?.locked && (tu.cfg?.kind === kind || tu.cfg?.kind === 'any')){ convertTrack(tu.cfg, kind); c.track = tu.id; }
      } else {
        // trilha principal: o clipe acompanha o ponteiro e a marca mostra onde vai entrar
        el.classList.add('dragging');
        el.style.transform = `translateX(${dx}px)`;
        const tt = xToTime(ev), others = L().v.filter(x => x.c !== c);
        dropIdx = others.findIndex(x => tt < (x.start + x.end) / 2);
        if(dropIdx < 0) dropIdx = others.length;
        const at = dropIdx < others.length ? others[dropIdx].start : (others.length ? others[others.length - 1].end : 0);
        const mark = $('#drop-mark'); mark.hidden = false; mark.style.left = at * pps + 'px';
        return;
      }
    }
    layoutCache = null; dirty = true;
    renderTimeline(); if(mode !== 'move') renderProps(); updateUi();
  };
  const up = ev => {
    content.removeEventListener('pointermove', mv); content.removeEventListener('pointerup', up); content.removeEventListener('pointercancel', up);
    $('#drop-mark').hidden = true; $('#snap-mark').hidden = true; dropGhost(); hot(null);
    if(!moved && wasIn){ select(c.id); return; }   // clique simples num clipe do grupo: fica só ele
    if(mode === 'move' && moved && target){
      const st = Math.max(0, o.start + lastDx / pps);
      if(target.id === 'v'){
        // de uma trilha de cima para a principal: entra na posição do ponteiro
        const {v} = L(), tt = xToTime(ev); let i = v.findIndex(x => tt < (x.start + x.end) / 2);
        S.clips.splice(S.clips.indexOf(c), 1);
        c.track = 'v'; delete c.start; c.tf = undefined; c.kf = undefined; c.fit = 'contain';
        const vs = S.clips.filter(x => x.track === 'v');
        if(i < 0 || i >= vs.length) S.clips.push(c); else S.clips.splice(S.clips.indexOf(vs[i]), 0, c);
      } else {
        let tid = target.id;
        if(target.zone) tid = newTrack(visual ? 'video' : 'audio');
        else convertTrack(target.cfg, kind);
        if(c.track === 'v'){
          // da principal para cima: mantém o tamanho que tinha na tela
          const r = RATIOS[S.ratio], bx = boxOf(c, 1000 * r, 1000);
          c.tf = {x: (c.tf || MAIN_TF).x, y: (c.tf || MAIN_TF).y, s: bx.w / (1000 * r), r: (c.tf || MAIN_TF).r, op: (c.tf || MAIN_TF).op ?? 1};
          c.tr = null; c.kf = undefined; c.start = st;
        } else c.start = st;
        c.track = tid;
      }
    } else if(mode === 'move' && c.track === 'v' && moved && dropIdx !== null){
      const vs = S.clips.filter(x => x.track === 'v' && x !== c);
      S.clips.splice(S.clips.indexOf(c), 1);
      if(dropIdx >= vs.length) S.clips.push(c); else S.clips.splice(S.clips.indexOf(vs[dropIdx]), 0, c);
    }
    if(snap() !== before) pushHist(before);
    changed();
  };
  content.addEventListener('pointermove', mv); content.addEventListener('pointerup', up); content.addEventListener('pointercancel', up);
}
// soltar na trilha: arquivos da lista, músicas e elementos da biblioteca, arquivos do computador e transições
const MT = {media: 'application/x-wk-media', audio: 'application/x-wk-lib-audio', el: 'application/x-wk-lib-el', tr: 'application/x-wk-tr', txt: 'application/x-wk-txt'};
function nearestCut(tt){
  const l = L(); let best = null;
  for(const e of l.v.slice(1)){ const b = e.start + e.td / 2; if(!best || Math.abs(b - tt) < Math.abs(best.b - tt)) best = {c: e.c, b}; }
  return best;
}
function clearDrop(){ $$('.track.drop-here').forEach(x => x.classList.remove('drop-here')); $$('.tr-mark.hot').forEach(x => x.classList.remove('hot')); $('#drop-mark').hidden = true; $('#snap-mark').hidden = true; }
tracksEl.addEventListener('dragover', e => {
  const types = [...e.dataTransfer.types], tr = e.target.closest('.track'); if(!tr) return;
  const tt = xToTime(e);
  if(types.includes(MT.tr)){
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    const cut = nearestCut(tt);
    $$('.tr-mark').forEach(mk => mk.classList.toggle('hot', !!cut && mk.dataset.tr === cut.c.id));
    return;
  }
  if(![MT.media, MT.audio, MT.el, MT.txt, 'Files'].some(x => types.includes(x))) return;
  e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
  $$('.track.drop-here').forEach(x => x !== tr && x.classList.remove('drop-here')); tr.classList.add('drop-here');
  const mark = $('#drop-mark'); mark.hidden = false;
  if(tr.dataset.track === 'v'){ const {v} = L(), i = v.findIndex(x => tt < (x.start + x.end) / 2); mark.style.left = (i < 0 ? L().vEnd : v[i].start) * pps + 'px'; }
  else mark.style.left = snapTo(tt, snapPoints(null)) * pps + 'px';
});
tracksEl.addEventListener('dragleave', e => { if(!tracksEl.contains(e.relatedTarget)) clearDrop(); });
tracksEl.addEventListener('drop', e => {
  const tr = e.target.closest('.track'); if(!tr) return;
  e.preventDefault(); e.stopPropagation();
  const dt = e.dataTransfer, tt = xToTime(e); let id = tr.dataset.track;
  if(tr.dataset.new){ id = 't' + uid(); const nt = {id, kind: 'any'}; if(tr.dataset.new === 'top') S.tracks.unshift(nt); else S.tracks.push(nt); normalize(); }
  const at = snapTo(tt, snapPoints(null)); clearDrop();
  if(dt.types.includes(MT.tr)){ const cut = nearestCut(tt); if(cut) setTransition(cut.c, dt.getData(MT.tr)); else toast('Coloque pelo menos dois clipes na trilha de vídeo'); return; }
  const {v} = L(); let idx = v.findIndex(x => tt < (x.start + x.end) / 2); if(idx < 0) idx = v.length;
  const opt = id === 'v' ? {track: 'v', index: idx} : {track: id, start: at};
  const mid = dt.getData(MT.media);
  if(mid){ const m = media.get(mid); if(m?.status === 'ready') addToTimeline(m, m.kind === 'audio' && id === 'v' ? {start: at} : opt); return; }
  const au = dt.getData(MT.audio); if(au){ importAudio(JSON.parse(au), id === 'v' ? {start: at} : opt); return; }
  const el = dt.getData(MT.el); if(el){ importEl(JSON.parse(el), id === 'v' ? {start: at} : opt); return; }
  const tx = dt.getData(MT.txt); if(tx){ addText(tx, id === 'v' ? {start: at} : opt); return; }
  if(dt.files.length) addFiles(dt.files, opt);
});

/* ---------- zoom ---------- */
const PPS_MIN = 4, PPS_MAX = 400;
const ppsToSlider = p => Math.log(p / PPS_MIN) / Math.log(PPS_MAX / PPS_MIN) * 100;
let autoFit = true;
function setPps(p, anchorX = null){
  const old = pps; pps = clamp(p, PPS_MIN, PPS_MAX);
  const ax = anchorX ?? (t * old - scroller.scrollLeft);   // mantém parado o ponto sob o mouse (ou o cursor)
  const at = (scroller.scrollLeft + ax) / old;
  $('#zoom').value = ppsToSlider(pps);
  renderTimeline();
  scroller.scrollLeft = Math.max(0, at * pps - ax);
}
function zoomFit(){ layoutCache = null; const total = Math.max(L().total, 3); setPps((scroller.clientWidth - 48) / total); scroller.scrollLeft = 0; }
const manualZoom = p => { autoFit = false; setPps(p); };
$('#zoom').addEventListener('input', e => manualZoom(PPS_MIN * (PPS_MAX / PPS_MIN) ** (e.target.value / 100)));
$('#z-in').addEventListener('click', () => manualZoom(pps * 1.4));
$('#z-out').addEventListener('click', () => manualZoom(pps / 1.4));
$('#z-fit').addEventListener('click', () => { autoFit = true; zoomFit(); });
scroller.addEventListener('wheel', e => {
  if(!e.ctrlKey && !e.metaKey) return;
  e.preventDefault(); autoFit = false;
  setPps(pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - scroller.getBoundingClientRect().left);
}, {passive: false});

/* ---------- reprodução ---------- */
const els = new Map();   // um <video>/<audio> por clipe, criado quando precisa
let actx = null, master = null, buffering = false;
const clock = {base: 0, tBase: 0};
function ensureAudio(){
  if(!actx){
    try{
      actx = new (window.AudioContext || window.webkitAudioContext)();
      master = actx.createGain(); master.connect(actx.destination);
      syncMixer();
      for(const o of els.values()) wire(o);
    }catch{ actx = null; }
  }
  if(actx && actx.state === 'suspended') actx.resume();
}
// o som de cada clipe passa pelo mixer: volume acima de 100%, fades, cruzamento nas transições e gravação na exportação
function wire(o){
  if(!actx || o.node) return;
  try{ o.node = actx.createMediaElementSource(o.el); o.gain = actx.createGain(); o.node.connect(o.gain); }catch{}
}
function getEl(c){
  const m = media.get(c.mid);
  if(!m || m.kind === 'image' || m.status !== 'ready') return null;
  let o = els.get(c.id);
  if(!o){
    const el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
    el.preload = 'auto'; el.playsInline = true; el.src = m.url;
    el.addEventListener('seeked', () => { dirty = true; });
    el.addEventListener('loadeddata', () => { dirty = true; });
    o = {el}; els.set(c.id, o); wire(o);
  }
  o.used = performance.now();
  return o;
}
function applyVol(o, c, f = 1){
  const v = (c.muted ? 0 : c.volume) * f;
  if(o.gain){
    o.gain.gain.value = v; o.el.volume = 1; o.el.muted = false;
    // manda para o canal da trilha onde o clipe está (muda se o clipe trocar de trilha)
    const b = busFor(c.track);
    if(b && o.bus !== b){ try{ o.gain.disconnect(); }catch{} o.gain.connect(b.input); o.bus = b; }
  }
  else { o.el.volume = clamp(v, 0, 1); o.el.muted = c.muted || !!trkCfg(c.track)?.mute; }
}
// fade de áudio: 0 no começo da entrada suave, 1 no meio, 0 no fim da saída suave.
// Se o clipe passa do fim do vídeo, a saída suave termina no fim do vídeo (senão ficaria na parte cortada)
const cutEnd = e => { const tot = L().total; return tot > 0 ? Math.min(e.end, tot) : e.end; };
function fadeGain(e){
  const c = e.c, lt = t - e.start, d = cutEnd(e) - e.start;
  let f = 1;
  if(c.fi > 0) f = Math.min(f, lt / c.fi);
  if(c.fo > 0) f = Math.min(f, (d - lt) / c.fo);
  return clamp(f, 0, 1);
}
// libera elementos de clipes apagados e os menos usados (o navegador limita quantos vídeos abertos)
function pruneEls(){
  const alive = new Set(S.clips.map(c => c.id));
  const drop = [...els.entries()].filter(([id]) => !alive.has(id));
  const rest = [...els.entries()].filter(([id]) => alive.has(id)).sort((a, b) => b[1].used - a[1].used);
  drop.push(...rest.slice(16));
  for(const [id, o] of drop){ o.el.pause(); o.el.removeAttribute('src'); o.el.load(); try{ o.node?.disconnect(); }catch{} els.delete(id); }
}
// clipes da trilha principal no instante (dois durante uma transição)
function activeV(){
  const l = L(), act = l.v.filter(e => t >= e.start && t < e.end);
  if(!act.length && l.v.length && t >= l.vEnd - 1e-6 && t - l.vEnd < .05) act.push(l.v[l.v.length - 1]);
  return act;
}
const activeO = () => L().o.filter(e => t >= e.start && t < e.end);
function syncMedia(paused){
  const l = L(), keep = new Set(), av = activeV();
  let buf = false;
  const B = av.length === 2 ? av[1] : null, p = B ? clamp((t - B.start) / B.td, 0, 1) : 0;
  const handle = (e, visual, f = 1) => {
    const c = e.c, o = getEl(c); if(!o) return;
    keep.add(c.id);
    const el = o.el, want = clamp(c.in + (t - e.start) * c.speed, 0, Math.max(0, (media.get(c.mid)?.duration || 0) - .01));
    applyVol(o, c, f * fadeGain(e));
    if(paused || !playing){ if(!el.paused) el.pause(); if(Math.abs(el.currentTime - want) > .02 && !el.seeking) el.currentTime = want; return; }
    el.playbackRate = c.speed;
    if(el.paused){ if(Math.abs(el.currentTime - want) > .06) el.currentTime = want; el.play().catch(() => {}); }
    else if(Math.abs(el.currentTime - want) > .3) el.currentTime = want;
    if(visual && (el.readyState < 3 || el.seeking)) buf = true;
  };
  const preload = e => {
    const o = e && getEl(e.c); if(!o) return;
    keep.add(e.c.id);
    if(!o.el.paused) o.el.pause();
    if(Math.abs(o.el.currentTime - e.c.in) > .05 && !o.el.seeking) o.el.currentTime = e.c.in;
  };
  av.forEach((e, i) => handle(e, true, !B ? 1 : i === 0 ? 1 - p : p));
  for(const e of l.a) if(t >= e.start && t < e.end) handle(e, false);
  for(const e of l.o) if(t >= e.start && t < e.end) handle(e, true);
  // deixa pronto o que vem a seguir, para a troca não engasgar
  const last = av[av.length - 1];
  if(last) preload(l.v[l.v.indexOf(last) + 1]);
  for(const e of [...l.o, ...l.a]) if(e.start > t && e.start - t < 1.5) preload(e);
  for(const [id, o] of els) if(!keep.has(id) && !o.el.paused) o.el.pause();
  buffering = buf;
}
function play(){
  if(!L().total) return;
  ensureAudio();
  if(t >= L().total - .02) t = 0;
  playing = true; clock.base = performance.now(); clock.tBase = t;
  $('#play').classList.add('on'); $('#play').setAttribute('aria-label', 'Pausar'); $('#play').title = 'Pausar (Espaço)';
  syncMedia(false);
}
function pause(){
  playing = false;
  for(const o of els.values()) o.el.pause();
  $('#play').classList.remove('on'); $('#play').setAttribute('aria-label', 'Tocar'); $('#play').title = 'Tocar (Espaço)';
  syncMedia(true); dirty = true;
}
const toggle = () => playing ? pause() : play();
function seek(nt){
  t = clamp(nt, 0, L().total);
  clock.base = performance.now(); clock.tBase = t;
  syncMedia(!playing); dirty = true;
  updateTime(); placePlayhead();
  const sc = sel && clipById(sel);
  if(sc?.kf?.length && !playing) renderProps();
}

/* ---------- desenho (preview e exportação) ---------- */
const screen = $('#screen'), sctx = screen.getContext('2d');
function sizeScreen(){
  const wrap = $('#stage-wrap'), r = RATIOS[S.ratio];
  const W = Math.max(40, wrap.clientWidth - 24), H = Math.max(40, wrap.clientHeight - 24);
  let w = W, h = w / r; if(h > H){ h = H; w = h * r; }
  screen.style.width = Math.floor(w) + 'px'; screen.style.height = Math.floor(h) + 'px';
  wrap.style.setProperty('--sw', Math.floor(w) + 'px'); wrap.style.setProperty('--sh', Math.floor(h) + 'px');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  screen.width = Math.round(w * dpr); screen.height = Math.round(h * dpr);
  dirty = true;
}
new ResizeObserver(() => sizeScreen()).observe($('#stage-wrap'));
// quadro de um clipe: imagem pronta, null (sem imagem) ou false (vídeo ainda carregando)
function frameOf(c){
  if(c.text) return {text: true};
  if(EXP.fast && EXP.ov?.has(c.id)) return EXP.ov.get(c.id) || false;
  const m = media.get(c.mid); if(!m) return null;
  if(m.kind === 'image') return m.img ? {src: m.img, w: m.w, h: m.h} : null;
  const o = els.get(c.id);
  return o && o.el.readyState >= 2 && o.el.videoWidth ? {src: o.el, w: o.el.videoWidth, h: o.el.videoHeight} : false;
}
// caixa de um clipe no quadro (centro, tamanho, rotação). Principal: encaixado na tela × tamanho escolhido
function boxOf(c, W, H){
  const tf = tfAt(c);
  if(c.text){ const M = textMetrics(c, W, H); return {cx: tf.x * W, cy: tf.y * H, w: M.w, h: M.h, r: tf.r * Math.PI / 180}; }
  const {w: mw, h: mh} = srcDims(c);
  if(c.track === 'v'){
    const k = (c.fit === 'cover' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh)) * tf.s;
    return {cx: tf.x * W, cy: tf.y * H, w: mw * k, h: mh * k, r: tf.r * Math.PI / 180};
  }
  const w = tf.s * W;
  return {cx: tf.x * W, cy: tf.y * H, w, h: w * mh / mw, r: tf.r * Math.PI / 180};
}
function drawBox(ctx, c, f, W, H){
  if(!f) return;
  if(c.text) return drawText(ctx, c, W, H);
  const b = boxOf(c, W, H), op = tfAt(c).op ?? 1, r90 = c.rot90 || 0, odd = r90 % 180;
  const cr = c.crop || {l: 0, t: 0, r: 0, b: 0};
  const sx = f.w * cr.l, sy = f.h * cr.t, sw = Math.max(1, f.w * (1 - cr.l - cr.r)), sh = Math.max(1, f.h * (1 - cr.t - cr.b));
  const dw = odd ? b.h : b.w, dh = odd ? b.w : b.h;
  ctx.save(); ctx.globalAlpha *= op; ctx.translate(b.cx, b.cy); ctx.rotate(b.r + r90 * Math.PI / 180);
  ctx.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
  ctx.drawImage(f.src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
function drawFull(ctx, c, f, W, H){ ctx.fillStyle = S.bg; ctx.fillRect(0, 0, W, H); drawBox(ctx, c, f, W, H); }
const ease = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
function drawTransition(ctx, A, fa, B, fb, W, H){
  const p = clamp((t - B.start) / B.td, 0, 1), q = ease(p);
  const a = () => drawFull(ctx, A.c, fa, W, H), b = () => drawFull(ctx, B.c, fb, W, H);
  const around = (s, fn) => { ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2); fn(); ctx.restore(); };
  switch(B.c.tr.type){
    case 'fade': a(); ctx.globalAlpha = p; b(); ctx.globalAlpha = 1; break;
    case 'black': case 'white':
      (p < .5 ? a : b)();
      ctx.fillStyle = B.c.tr.type === 'black' ? '#000' : '#fff'; ctx.globalAlpha = 1 - Math.abs(p * 2 - 1); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; break;
    case 'slide': ctx.save(); ctx.translate(-q * W, 0); a(); ctx.translate(W, 0); b(); ctx.restore(); break;
    case 'up': ctx.save(); ctx.translate(0, -q * H); a(); ctx.translate(0, H); b(); ctx.restore(); break;
    case 'zoom': around(1 + q * .5, a); ctx.globalAlpha = q; around(.7 + .3 * q, b); ctx.globalAlpha = 1; break;
    case 'wipe': a(); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * q, H); ctx.clip(); b(); ctx.restore(); break;
    case 'circle': a(); ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * q, 0, Math.PI * 2); ctx.clip(); b(); ctx.restore(); break;
    default: b();
  }
}
const byZ = (x, y) => zOf(x.c) - zOf(y.c) || S.clips.indexOf(x.c) - S.clips.indexOf(y.c);
function render(ctx, W, H){
  const av = S.main.hidden ? [] : activeV(), fr = av.map(e => frameOf(e.c));
  const ov = activeO().filter(e => !isHidden(e.c.track)).sort(byZ), ofr = ov.map(e => frameOf(e.c));
  if(fr.includes(false) || ofr.includes(false)) return false;   // mantém o quadro anterior até carregar
  ctx.save(); ctx.imageSmoothingQuality = 'high';
  if(!av.length){ ctx.fillStyle = S.bg; ctx.fillRect(0, 0, W, H); }
  else if(av.length === 1) drawFull(ctx, av[0].c, fr[0], W, H);
  else drawTransition(ctx, av[0], fr[0], av[1], fr[1], W, H);
  ov.forEach((e, i) => drawBox(ctx, e.c, ofr[i], W, H));
  ctx.restore();
  return true;
}
// moldura do clipe selecionado no preview (só na tela, não vai para o vídeo): 4 cantos para redimensionar
const guides = {x: false, y: false};
const visibleNow = c => !isHidden(c.track) && (activeO().some(e => e.c === c) || activeV().some(e => e.c === c));
function drawSelUi(){
  const c = sel && clipById(sel);
  if(!c || selSet.size > 1 || media.get(c.mid)?.kind === 'audio' || !visibleNow(c)) return;
  const W = screen.width, H = screen.height, b = boxOf(c, W, H), k = W / screen.getBoundingClientRect().width || 1;
  sctx.save();
  if(guides.x || guides.y){
    sctx.strokeStyle = '#ff3bd4'; sctx.lineWidth = k; sctx.setLineDash([6 * k, 4 * k]);
    if(guides.x){ sctx.beginPath(); sctx.moveTo(W / 2, 0); sctx.lineTo(W / 2, H); sctx.stroke(); }
    if(guides.y){ sctx.beginPath(); sctx.moveTo(0, H / 2); sctx.lineTo(W, H / 2); sctx.stroke(); }
    sctx.setLineDash([]);
  }
  sctx.translate(b.cx, b.cy); sctx.rotate(b.r);
  sctx.strokeStyle = 'rgba(0,0,0,.5)'; sctx.lineWidth = 3 * k; sctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
  sctx.strokeStyle = '#fff'; sctx.lineWidth = 1.5 * k; sctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
  const hs = 7 * k;
  for(const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]){
    sctx.fillStyle = '#fff'; sctx.strokeStyle = '#1a8a92'; sctx.lineWidth = 2 * k;
    sctx.beginPath(); sctx.arc(sx * b.w / 2, sy * b.h / 2, hs, 0, Math.PI * 2); sctx.fill(); sctx.stroke();
  }
  sctx.restore();
}
function frame(now){
  requestAnimationFrame(frame);
  if(playing){
    const hold = buffering || (EXP.on && document.hidden);
    if(hold){ clock.base = now; clock.tBase = t; }
    else t = clock.tBase + (now - clock.base) / 1000;
    const total = L().total;
    if(t >= total){ t = total; if(EXP.on) finishExport(); pause(); }
    else syncMedia(false);
    if(EXP.on) expTick(hold);
    updateTime(); placePlayhead(true);
    dirty = true;
  }
  if($('#mixer').open && actx) drawMeters();
  if(dirty && EXP.fast){
    // modo rápido: o preview só acompanha; um quadro do decodificador pode ter sido liberado no meio do caminho
    try{ render(sctx, screen.width, screen.height); }catch{}
    dirty = false;
  }
  else if(dirty){
    if(render(sctx, screen.width, screen.height)){ dirty = false; if(!EXP.on && !playing) drawSelUi(); }
    if(EXP.on) render(EXP.cx, EXP.cv.width, EXP.cv.height);
  }
}
requestAnimationFrame(frame);

/* ---------- mover e redimensionar direto no preview (vídeo principal e trilhas de cima) ---------- */
function canvasPt(e){ const r = screen.getBoundingClientRect(); return {x: (e.clientX - r.left) * screen.width / r.width, y: (e.clientY - r.top) * screen.height / r.height, k: screen.width / r.width}; }
function toLocal(b, p){ const dx = p.x - b.cx, dy = p.y - b.cy, co = Math.cos(-b.r), si = Math.sin(-b.r); return {x: dx * co - dy * si, y: dx * si + dy * co}; }
function hitTest(p){
  const W = screen.width, H = screen.height, sc = sel && clipById(sel);
  if(sc && selSet.size === 1 && media.get(sc.mid)?.kind !== 'audio' && visibleNow(sc)){
    const b = boxOf(sc, W, H), lp = toLocal(b, p);
    for(const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) if(Math.hypot(lp.x - sx * b.w / 2, lp.y - sy * b.h / 2) < 14 * p.k) return {c: sc, mode: 'scale', corner: [sx, sy]};
  }
  const inside = c => { const b = boxOf(c, W, H), lp = toLocal(b, p); return Math.abs(lp.x) <= b.w / 2 && Math.abs(lp.y) <= b.h / 2; };
  const ok = c => !isLocked(c.track) && !isHidden(c.track);
  for(const e of activeO().sort(byZ).reverse()) if(ok(e.c) && inside(e.c)) return {c: e.c, mode: 'move'};
  for(const e of activeV().slice().reverse()) if(ok(e.c) && inside(e.c)) return {c: e.c, mode: 'move'};
  return null;
}
screen.addEventListener('pointermove', e => {
  if(e.buttons) return;
  const h = hitTest(canvasPt(e));
  screen.classList.toggle('can-move', h?.mode === 'move');
  screen.classList.toggle('can-scale', h?.mode === 'scale');
  if(h?.mode === 'scale') screen.style.cursor = h.corner[0] * h.corner[1] > 0 ? 'nwse-resize' : 'nesw-resize'; else screen.style.cursor = '';
});
screen.addEventListener('pointerdown', e => {
  if(e.button !== 0) return;
  const p = canvasPt(e), hit = hitTest(p);
  if(!hit){
    // clique fora: toca/pausa e tira a seleção
    const up = () => { screen.removeEventListener('pointerup', up); if(sel) select(null); toggle(); };
    screen.addEventListener('pointerup', up);
    return;
  }
  e.preventDefault();
  const wasSel = sel === hit.c.id && selSet.size === 1;
  if(playing) pause();
  if(!wasSel) select(hit.c.id);
  const c = hit.c, W = screen.width, H = screen.height, b0 = boxOf(c, W, H), d0 = Math.max(1, Math.hypot(p.x - b0.cx, p.y - b0.cy));
  const tf0 = {...tfAt(c)};
  let moved = false;
  capture(screen, e);
  const mv = ev => {
    const q = canvasPt(ev);
    if(!moved && Math.hypot(q.x - p.x, q.y - p.y) < 3 * q.k) return;
    moved = true;
    live(() => editTf(c, tf => {
      if(hit.mode === 'scale') tf.s = clamp(tf0.s * Math.hypot(q.x - b0.cx, q.y - b0.cy) / d0, .03, 8);
      else {
        let nx = tf0.x + (q.x - p.x) / W, ny = tf0.y + (q.y - p.y) / H;
        guides.x = Math.abs(nx - .5) < 10 * q.k / W; guides.y = Math.abs(ny - .5) < 10 * q.k / H;
        if(guides.x) nx = .5; if(guides.y) ny = .5;
        tf.x = clamp(nx, -1, 2); tf.y = clamp(ny, -1, 2);
      }
    }));
  };
  const up = () => { screen.removeEventListener('pointermove', mv); screen.removeEventListener('pointerup', up); screen.removeEventListener('pointercancel', up); guides.x = guides.y = false; if(moved) liveEnd(); else dirty = true; };
  screen.addEventListener('pointermove', mv); screen.addEventListener('pointerup', up); screen.addEventListener('pointercancel', up);
});

screen.addEventListener('dblclick', e => {
  const hit = hitTest(canvasPt(e));
  if(hit?.c.text){ if(sel !== hit.c.id) select(hit.c.id); setTimeout(() => { const ta = $('#p-text'); if(ta){ ta.focus(); ta.select(); } }, 30); }
});

function updateTime(){ $('#tc-now').textContent = fmtTime(t); $('#tc-total').textContent = fmtTime(L().total); }
function updateUi(){
  updateTime();
  const l = L();
  $('#stage-empty').hidden = l.v.length > 0 || l.o.length > 0;
  $('#export-btn').disabled = !l.total;
  $('#undo').disabled = !hist.past.length; $('#redo').disabled = !hist.future.length;
  $('#t-del').disabled = $('#t-dup').disabled = !selSet.size;
  $('#t-split').disabled = !S.clips.length;
  $('#ratio-badge').textContent = S.ratio;
}

/* ---------- editar clipes ---------- */
const copyClip = c => ({...c, id: uid(), tf: c.tf ? {...c.tf} : undefined, text: c.text ? {...c.text} : undefined, kf: c.kf ? c.kf.map(k => ({...k})) : undefined, crop: c.crop ? {...c.crop} : undefined, tr: null});
function split(){
  const l = L(), picked = sels().filter(c => !isLocked(c.track));
  const inside = e => e && !isLocked(e.c.track) && t > e.start + .04 && t < e.end - .04;
  const targets = picked.length ? picked.map(entryOf).filter(inside) : [...l.v, ...l.a, ...l.o].filter(inside);
  if(!targets.length){ toast(picked.length ? 'Coloque o cursor em cima do clipe selecionado para dividir' : 'Coloque o cursor em cima de um clipe para dividir'); return; }
  edit(() => {
    const news = [];
    for(const e of targets){
      const c = e.c, cut = c.in + (t - e.start) * c.speed;
      const b = {...copyClip(c), in: cut, fi: 0};
      if(c.kf?.length){
        const lt = t - e.start, mid = {t: lt, ...pickTf(tfAt(c, lt))};
        b.kf = [{...mid, t: 0}, ...c.kf.filter(k => k.t > lt).map(k => ({...k, t: k.t - lt}))];
        c.kf = [...c.kf.filter(k => k.t < lt), mid];
      }
      if(c.track !== 'v') b.start = t;
      c.out = cut; c.fo = 0;
      S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
      news.push(b.id);
    }
    if(picked.length) setSelection(news);
  });
}
function del(){
  const list = sels().filter(c => !isLocked(c.track)); if(!list.length){ if(selSet.size) toast('Trilha travada: destrave para excluir'); return; }
  const ids = new Set(list.map(c => c.id));
  edit(() => { S.clips = S.clips.filter(c => !ids.has(c.id)); setSelection([]); });
  if(list.length > 1) toast(`${list.length} clipes excluídos`);
}
function duplicate(){
  const list = sels(); if(!list.length) return;
  edit(() => {
    const news = [];
    for(const c of list){
      const e = entryOf(c), b = copyClip(c);
      if(c.track !== 'v'){ b.start = e.end; b.track = pickTrack(media.get(c.mid)?.kind === 'audio' ? 'audio' : 'video', b.start, b.start + clipDur(b), c.track); }
      S.clips.splice(S.clips.indexOf(c) + 1, 0, b); news.push(b.id);
    }
    setSelection(news);
  });
}
// levar um clipe da trilha principal para uma trilha de cima (e voltar)
function toUpper(c){
  const e = entryOf(c), m = media.get(c.mid);
  edit(() => { c.start = e.start; c.tr = null; c.tf = defaultTf(m || {}); c.kf = undefined; c.track = pickTrack('video', c.start, c.start + clipDur(c), null, c); });
  toast('Agora está por cima do vídeo: arraste no preview para posicionar');
}
function toMain(c){
  const {v} = L(), i = v.findIndex(x => c.start < (x.start + x.end) / 2);
  edit(() => {
    S.clips.splice(S.clips.indexOf(c), 1);
    c.track = 'v'; delete c.start; delete c.tf; delete c.kf; c.fit = 'contain';
    const vs = S.clips.filter(x => x.track === 'v');
    if(i < 0 || i >= vs.length) S.clips.push(c); else S.clips.splice(S.clips.indexOf(vs[i]), 0, c);
  });
}
// para frente/para trás: troca para a trilha de vídeo de cima/de baixo (cria se precisar)
function moveUpper(c, dir){
  const up = upperTracks().filter(x => x.kind === 'video'), i = up.findIndex(x => x.id === c.track);
  edit(() => {
    const e = entryOf(c);
    let target = up[i - dir];
    if(!target && dir > 0){ const id = newTrack('video'); target = trackById(id); }
    if(!target) return;
    const clash = S.clips.some(x => x !== c && x.track === target.id && x.start < e.end && x.start + clipDur(x) > e.start);
    if(clash && dir > 0){ const id = 't' + uid(); S.tracks.splice(S.tracks.indexOf(trackById(c.track)), 0, {id, kind: 'video'}); c.track = id; }
    else if(!clash) c.track = target.id;
  });
}
function setTransition(c, type, d){
  if(!c) return;
  const l = L(); if(l.v.findIndex(e => e.c === c) < 1){ toast('A transição fica entre dois clipes da trilha de vídeo'); return; }
  edit(() => { c.tr = type === 'none' ? null : {type, d: d ?? c.tr?.d ?? TRD.d}; });
  if(type !== 'none'){ TRD.type = type; toast(`Transição "${TR[type].label}" aplicada`); }
}
$('#t-split').addEventListener('click', split);
$('#t-del').addEventListener('click', del);
$('#t-dup').addEventListener('click', duplicate);
const setSnap = on => { snapOn = on; $('#t-snap').setAttribute('aria-pressed', String(on)); };
$('#t-snap').addEventListener('click', () => { setSnap(!snapOn); toast(snapOn ? 'Ímã ligado' : 'Ímã desligado'); });

/* ---------- popover de transição (clicar no losango entre dois clipes) ---------- */
let trFor = null;
const trPrev = id => `<span class="tp-prev ${id}"><i></i><b></b></span>`;
function openTrPop(mark){
  const c = clipById(mark.dataset.tr); if(!c) return;
  const pop = $('#trpop');
  if(isOpen(pop) && trFor === c.id){ closeTrPop(); return; }
  trFor = c.id; renderTrPop();
  if(!pop.hidden){ pop.hidden = true; void pop.offsetWidth; }
  gelShow(pop);
  const r = mark.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = clamp(r.left + r.width / 2 - pw / 2, 8, document.documentElement.clientWidth - pw - 8);
  const up = r.top - ph - 10 > 8;
  pop.style.left = left + scrollX + 'px';
  pop.style.top = (up ? r.top - ph - 10 : r.bottom + 10) + scrollY + 'px';
  pop.style.setProperty('--gel-origin', `${Math.round(r.left + r.width / 2 - left)}px ${up ? '100%' : '0'}`);
}
function renderTrPop(){
  const c = clipById(trFor); if(!c){ closeTrPop(); return; }
  const cur = c.tr?.type || 'none', vi = L().v.findIndex(e => e.c === c);
  $('#trpop-where').textContent = `entre o clipe ${vi} e o ${vi + 1}`;
  $('#trpop-grid').innerHTML = [{id: 'none', label: 'Nenhuma'}, ...TRS].map(x => `<button type="button" data-v="${x.id}" aria-pressed="${cur === x.id}">${trPrev(x.id)}${x.label}</button>`).join('');
  const d = c.tr?.d ?? TRD.d;
  $('#trpop-dur').value = d; $('#trpop-dur-out').textContent = fmtSec(d);
  $('#trpop-dur').disabled = cur === 'none';
}
function closeTrPop(){ const pop = $('#trpop'); trFor = null; if(isOpen(pop)) gelHide(pop, () => { pop.hidden = true; }); }
$('#trpop-grid').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if(!b) return; setTransition(clipById(trFor), b.dataset.v); renderTrPop(); });
$('#trpop-dur').addEventListener('input', e => {
  const c = clipById(trFor); if(!c?.tr) return;
  live(() => { c.tr.d = +e.target.value; }); TRD.d = +e.target.value;
  $('#trpop-dur-out').textContent = fmtSec(e.target.value);
  renderTimeline(); updateUi();
});
$('#trpop-dur').addEventListener('change', () => { liveEnd(); renderTrPop(); });
document.addEventListener('pointerdown', e => { if(trFor && !e.target.closest('#trpop, .tr-mark')) closeTrPop(); });

/* ---------- propriedades ---------- */
const SPEEDS = [.5, 1, 1.5, 2];
const RATIO_ICON = {'16:9': [26, 15], '9:16': [13, 22], '1:1': [18, 18], '4:5': [16, 20]};
const range = (id, label, min, max, step, val, out) => `<div class="pr"><div class="pr-h"><label for="${id}">${label}</label><output id="${id}-out">${out}</output></div><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`;
function creditsText(){
  const used = new Set(S.clips.map(c => c.mid));
  return [...media.values()].filter(m => m.credit && used.has(m.id)).map(m => `"${m.credit.title}" — ${m.credit.creator} · ${m.credit.license} · ${m.credit.url}`).join('\n');
}
const POS9 = '<div class="pos9" id="p-pos">' + ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].map(v => `<button type="button" data-v="${v}" aria-label="Posição ${v}"></button>`).join('') + '</div>';
// painel do texto: conteúdo, fonte, cor, contorno, fundo, sombra e animações
function textProps(c){
  const T = c.text, opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${l}</option>`).join('');
  const seg = (id, list, cur) => `<div class="seg" id="${id}">${list.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</div>`;
  return `<div class="pr"><div class="pr-h"><label for="p-text">Texto</label></div><textarea class="p-text" id="p-text" rows="3">${esc(T.content)}</textarea></div>
    <div class="pr-grid2">
      <label>Fonte<select class="inp" id="p-font" style="font-family:'${esc(T.font)}'">${FONTS.map(f => `<option value="${f}" style="font-family:'${f}'"${T.font === f ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
      <label>Peso<select class="inp" id="p-weight">${opt([[400, 'Normal'], [600, 'Médio'], [700, 'Negrito'], [800, 'Extra'], [900, 'Black']], T.weight)}</select></label>
    </div>
    <div class="pr"><div class="pr-h">Alinhamento</div>${seg('p-align', [['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']], T.align)}</div>
    <div class="pr-colors"><label>Cor <input type="color" id="p-tcolor" value="${esc(T.color)}"></label><label class="chk"><input type="checkbox" id="p-italic"${T.italic ? ' checked' : ''}> Itálico</label></div>
    ${range('p-stroke', 'Contorno', 0, 20, 1, Math.round(T.stroke * 100), Math.round(T.stroke * 100) + '%')}
    <div class="pr-colors"><label>Cor do contorno <input type="color" id="p-scolor" value="${esc(T.strokeColor)}"></label></div>
    <div class="pr"><div class="pr-h">Fundo</div>${seg('p-tbg', [['none', 'Sem fundo'], ['box', 'Caixa']], T.bg)}
      ${T.bg === 'box' ? `<div class="pr-colors"><label>Cor <input type="color" id="p-bgcolor" value="${esc(T.bgColor)}"></label></div>${range('p-bgop', 'Transparência da caixa', 10, 100, 5, Math.round(T.bgOp * 100), Math.round(T.bgOp * 100) + '%')}` : ''}</div>
    <div class="pr"><div class="pr-h">Sombra</div>${seg('p-shadow', [['none', 'Nenhuma'], ['soft', 'Suave'], ['glow', 'Neon']], T.shadow)}</div>
    <div class="pr-grid2">
      <label>Entrada<select class="inp" id="p-ain">${opt(Object.entries(TXT_ANIMS), T.ain)}</select></label>
      <label>Saída<select class="inp" id="p-aout">${opt(Object.entries(TXT_ANIMS).filter(([k]) => k !== 'type'), T.aout)}</select></label>
    </div>`;
}
// keyframes: marcar no cursor, remover, limpar e atalhos prontos
function kfProps(c){
  const n = c.kf?.length || 0, here = kfHere(c), lt = localT(c), inside = lt >= -1e-3 && lt <= clipLen(c) + 1e-3;
  return `<div class="pr kf-box"><div class="pr-h">Animação <span class="kf-count">${n ? `${n} keyframe${n > 1 ? 's' : ''}` : 'sem keyframes'}</span></div>
    <div class="kf-row">
      <button class="ghost sm kf-add${here ? ' on' : ''}" id="p-kf-add" type="button"${inside ? '' : ' disabled'} title="Marca a posição, o tamanho, a rotação e a opacidade neste ponto">◆ ${here ? 'Keyframe aqui' : 'Marcar aqui'}</button>
      <button class="ghost sm" id="p-kf-del" type="button"${here ? '' : ' disabled'}>Remover</button>
      <button class="ghost sm" id="p-kf-clear" type="button"${n ? '' : ' disabled'}>Limpar</button>
      <button class="ib sm" id="p-kf-prev" type="button" title="Keyframe anterior"${n ? '' : ' disabled'}>‹</button><button class="ib sm" id="p-kf-next" type="button" title="Próximo keyframe"${n ? '' : ' disabled'}>›</button>
    </div>
    <div class="kf-presets">${Object.entries(KF_PRESETS).map(([k, p]) => `<button type="button" data-kfp="${k}">${p.label}</button>`).join('')}</div>
    <p class="hint">${n ? 'Mexa no preview ou nos controles acima: o valor vale para o ponto onde o cursor está, e o editor anima entre os pontos.' : 'Marque um ponto, leve o cursor para outro momento e mude o tamanho ou a posição: o editor anima entre os dois.'}</p>
  </div>`;
}
// recortar bordas, girar de 90 em 90 e espelhar
function cropProps(c){
  const cr = c.crop || {l: 0, t: 0, r: 0, b: 0}, pct = v => Math.round(v * 100);
  return `<div class="pr crop-box"><div class="pr-h">Recortar e girar <button class="ghost sm" id="p-crop-reset" type="button">Resetar</button></div>
    <div class="rot-row">
      <button class="ghost sm" type="button" data-rot="-90" title="Girar 90° para a esquerda">⟲ 90°</button>
      <button class="ghost sm" type="button" data-rot="90" title="Girar 90° para a direita">⟳ 90°</button>
      <button class="ghost sm" type="button" data-flip="flipH" aria-pressed="${!!c.flipH}" title="Espelhar na horizontal">⇆</button>
      <button class="ghost sm" type="button" data-flip="flipV" aria-pressed="${!!c.flipV}" title="Espelhar na vertical">⇅</button>
    </div>
    <div class="crop-grid">
      ${[['l', 'Esquerda'], ['r', 'Direita'], ['t', 'Cima'], ['b', 'Baixo']].map(([k, l]) => `<label>${l}<output id="p-crop-${k}-out">${pct(cr[k])}%</output><input type="range" id="p-crop-${k}" min="0" max="45" step="1" value="${pct(cr[k])}"></label>`).join('')}
    </div>
  </div>`;
}
function renderProps(){
  const p = $('#props');
  if(selSet.size > 1){
    const list = sels();
    p.innerHTML = `<div class="pane-h"><b>${list.length} clipes selecionados</b><button class="ib" id="p-close" type="button" title="Tirar a seleção (Esc)" aria-label="Tirar a seleção"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
      <div class="props-body">
        <div class="multi-list">${list.map(c => `<span>${esc(media.get(c.mid)?.name || 'clipe')}</span>`).join('')}</div>
        <p class="hint">Arraste um deles na timeline para mover os clipes das trilhas livres juntos. <kbd>S</kbd> divide todos no cursor.</p>
        ${list.some(hasSound) ? `${range('p-mfi', 'Entrada suave do som', 0, 5, .1, 0, fmtSec(0))}${range('p-mfo', 'Saída suave do som', 0, 5, .1, 0, fmtSec(0))}` : ''}
        <div class="pr-acts"><button class="ghost" id="p-split" type="button">Dividir <kbd>S</kbd></button><button class="ghost" id="p-dup" type="button">Duplicar</button><button class="ghost danger" id="p-del" type="button" style="grid-column:1/-1">Excluir ${list.length} clipes</button></div>
      </div>`;
    return;
  }
  const c = sel && clipById(sel);
  if(!c){
    const {v, a, o, total} = L();
    p.innerHTML = `<div class="pane-h"><b>Projeto</b></div><div class="props-body">
      <div class="pr"><div class="pr-h">Formato</div>
        <div class="ratios" id="p-ratio">${Object.keys(RATIOS).map(r => `<button type="button" data-v="${r}" aria-pressed="${S.ratio === r}"><i style="width:${RATIO_ICON[r][0]}px;height:${RATIO_ICON[r][1]}px"></i>${r}</button>`).join('')}</div>
        <p class="hint">${S.ratio === '9:16' ? 'Reels, TikTok e Shorts.' : S.ratio === '16:9' ? 'YouTube, sites e apresentações.' : S.ratio === '1:1' ? 'Feed quadrado.' : 'Feed do Instagram (retrato).'}</p></div>
      <div class="pr"><div class="pr-h">Cor do fundo</div>
        <div class="pr-row"><input type="color" id="p-bg" value="${esc(S.bg)}" aria-label="Cor do fundo"><span class="hint">Aparece nas bordas quando o vídeo não preenche a tela.</span></div></div>
      <div class="pr-stats"><span>Duração</span><b>${fmtTime(total)}</b><span>Clipes na principal</span><b>${v.length}</b><span>Por cima do vídeo</span><b>${o.length}</b><span>Clipes de áudio</span><b>${a.length}</b><span>Trilhas</span><b>${S.tracks.length + 1}</b></div>
      <div class="pr-tip"><b>Como usar</b>
        <span>1. Importe seus arquivos ou pegue músicas e elementos nas abas.</span>
        <span>2. Arraste para a timeline. <b>+ Trilha</b> cria trilhas novas: o que fica nas de cima aparece por cima do vídeo.</span>
        <span>3. Clique no vídeo do preview para mover e redimensionar pelos cantos.</span>
        <span>4. Corte arrastando a borda, ou pare o cursor e aperte <kbd>S</kbd>. Arraste num espaço vazio para selecionar vários.</span></div>
    </div>`;
    return;
  }
  const m = media.get(c.mid), e = entryOf(c), T = c.text, still = !!T || m?.kind === 'image', aud = m?.kind === 'audio', sound = hasSound(c);
  const vi = c.track === 'v' ? L().v.findIndex(x => x.c === c) : -1, tf = tfAt(c), main = c.track === 'v';
  const d = e.end - e.start, fmax = Math.min(10, +((cutEnd(e) - e.start) / 2).toFixed(1));
  const title = T ? (c.caption ? 'Legenda' : 'Texto') : aud ? 'Áudio' : main ? (still ? 'Foto' : 'Vídeo') : 'Por cima do vídeo';
  p.innerHTML = `<div class="pane-h"><b>${title}</b><button class="ib" id="p-close" type="button" title="Voltar ao projeto (Esc)" aria-label="Fechar"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
    <div class="props-body">
      ${T ? textProps(c) : `<div class="pr-name">${m?.thumb ? `<img src="${m.thumb}" alt="">` : `<span class="ph"></span>`}<div><b title="${esc(m?.name)}">${esc(m?.name || 'arquivo removido')}</b><span>${fmtTime(d)} na timeline</span></div></div>`}
      ${!aud ? `
        ${range('p-size', 'Tamanho', main ? 10 : 3, main ? 400 : 300, 1, Math.round(tf.s * 100), Math.round(tf.s * 100) + '%')}
        ${range('p-rot', 'Rotação', -180, 180, 1, Math.round(tf.r), Math.round(tf.r) + '°')}
        ${range('p-op', 'Opacidade', 0, 100, 1, Math.round((tf.op ?? 1) * 100), Math.round((tf.op ?? 1) * 100) + '%')}
        <div class="pr"><div class="pr-h">Posição <button class="ghost sm" id="p-reset" type="button">Resetar</button></div><div class="pr-2">${POS9}<span class="hint">Ou clique no preview e arraste. Os cantos mudam o tamanho.</span></div></div>
        ${kfProps(c)}${T ? '' : cropProps(c)}` : ''}
      ${sound ? `<div class="pr"><div class="pr-h"><label for="p-vol">Volume</label><output id="p-vol-out">${Math.round(c.volume * 100)}%</output></div>
        <input type="range" id="p-vol" min="0" max="200" step="5" value="${Math.round(c.volume * 100)}">
        <label class="chk"><input type="checkbox" id="p-mute"${c.muted ? ' checked' : ''}> Sem som</label></div>
        ${range('p-fi', 'Entrada suave do som', 0, fmax, .1, c.fi || 0, fmtSec(c.fi || 0))}
        ${range('p-fo', 'Saída suave do som', 0, fmax, .1, c.fo || 0, fmtSec(c.fo || 0))}` : ''}
      ${!still ? `<div class="pr"><div class="pr-h">Velocidade</div><div class="seg" id="p-speed">${SPEEDS.map(s => `<button type="button" data-v="${s}" aria-pressed="${c.speed === s}">${String(s).replace('.', ',')}×</button>`).join('')}</div></div>` : ''}
      ${main ? `<div class="pr"><div class="pr-h">Encaixe</div><div class="seg" id="p-fit"><button type="button" data-v="contain" aria-pressed="${c.fit !== 'cover'}">Mostrar inteiro</button><button type="button" data-v="cover" aria-pressed="${c.fit === 'cover'}">Preencher a tela</button></div></div>` : ''}
      ${vi > 0 ? `<div class="pr"><div class="pr-h"><label for="p-tr">Transição de entrada</label></div><select class="inp" id="p-tr"><option value="none">Nenhuma</option>${TRS.map(x => `<option value="${x.id}"${c.tr?.type === x.id ? ' selected' : ''}>${x.label}</option>`).join('')}</select></div>` : ''}
      ${still ? `<div class="pr"><div class="pr-h"><label for="p-dur">Duração na tela</label></div><div class="pr-row"><input class="inp" id="p-dur" type="number" min="0.1" max="3600" step="0.5" value="${+(c.out - c.in).toFixed(2)}"><span class="hint">segundos</span></div></div>` : ''}
      <div class="pr-stats"><span>Começa em</span><b>${fmtTime(e.start)}</b><span>Termina em</span><b>${fmtTime(e.end)}</b>${!still ? `<span>Trecho do arquivo</span><b>${fmtTime(c.in)} → ${fmtTime(c.out)}</b>` : ''}</div>
      ${!main && !aud ? `<div class="pr-acts"><button class="ghost" id="p-front" type="button">Para frente</button><button class="ghost" id="p-back" type="button">Para trás</button>${T ? '' : '<button class="ghost" id="p-tomain" type="button" style="grid-column:1/-1">Pôr na trilha principal</button>'}</div>`
        : main ? `<div class="pr-acts"><button class="ghost" id="p-toupper" type="button" style="grid-column:1/-1">Pôr por cima do vídeo</button></div>` : ''}
      <div class="pr-acts"><button class="ghost" id="p-split" type="button">Dividir <kbd>S</kbd></button><button class="ghost" id="p-dup" type="button">Duplicar</button><button class="ghost danger" id="p-del" type="button" style="grid-column:1/-1">Excluir clipe</button></div>
    </div>`;
}
$('#props').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  const c = sel && clipById(sel);
  if(b.id === 'p-close') select(null);
  else if(b.id === 'p-split') split();
  else if(b.id === 'p-dup') duplicate();
  else if(b.id === 'p-del') del();
  else if(b.id === 'p-toupper' && c) toUpper(c);
  else if(b.id === 'p-tomain' && c) toMain(c);
  else if(b.id === 'p-front' && c) moveUpper(c, 1);
  else if(b.id === 'p-back' && c) moveUpper(c, -1);
  else if(b.id === 'p-reset' && c){ edit(() => { c.tf = c.track === 'v' ? undefined : c.text ? {x: .5, y: c.caption ? .86 : .5, s: 1, r: 0, op: 1} : defaultTf(media.get(c.mid) || {}); c.kf = undefined; }); }
  else if(b.id === 'p-kf-add' && c) edit(() => { editTf(c, () => {}); if(!c.kf?.length){ const lt = clamp(localT(c), 0, clipLen(c)); c.kf = [{t: lt, ...pickTf(tfAt(c, lt))}]; } });
  else if(b.id === 'p-kf-del' && c){ const k = kfHere(c); if(k) edit(() => { c.kf = c.kf.filter(x => x !== k); if(!c.kf.length){ c.tf = pickTf(k); c.kf = undefined; } }); }
  else if(b.id === 'p-kf-clear' && c){ const cur = pickTf(tfAt(c)); edit(() => { c.kf = undefined; c.tf = cur; }); }
  else if((b.id === 'p-kf-prev' || b.id === 'p-kf-next') && c?.kf?.length){
    const lt = localT(c), e0 = entryOf(c), list = b.id === 'p-kf-next' ? c.kf.filter(k => k.t > lt + .01) : c.kf.filter(k => k.t < lt - .01).reverse();
    if(list[0]) seek(e0.start + list[0].t);
  }
  else if(b.dataset.kfp && c){
    const e0 = entryOf(c), d = e0.end - e0.start, base = pickTf(c.kf?.length ? tfAt(c, 0) : baseTf(c));
    const bx = boxOf({...c, kf: undefined, tf: base}, screen.width, screen.height);
    edit(() => { c.kf = KF_PRESETS[b.dataset.kfp].f(base, d, bx.w / screen.width, bx.h / screen.height).map(k => ({...pickTf(k), t: clamp(k.t, 0, d)})); });
    toast(`Animação "${KF_PRESETS[b.dataset.kfp].label}" aplicada`);
  }
  else if(b.dataset.rot && c) edit(() => { c.rot90 = ((c.rot90 || 0) + +b.dataset.rot + 360) % 360; });
  else if(b.dataset.flip && c) edit(() => { c[b.dataset.flip] = !c[b.dataset.flip]; });
  else if(b.id === 'p-crop-reset' && c) edit(() => { c.crop = undefined; c.rot90 = 0; c.flipH = false; c.flipV = false; });
  else if(b.closest('#p-ratio')){ edit(() => { S.ratio = b.dataset.v; S.ratioAuto = false; }); sizeScreen(); }
  else if(b.closest('#p-speed') && c) edit(() => { c.speed = +b.dataset.v; });
  else if(b.closest('#p-fit') && c) edit(() => { c.fit = b.dataset.v; });
  else if(b.closest('#p-align') && c?.text) edit(() => { c.text.align = b.dataset.v; });
  else if(b.closest('#p-tbg') && c?.text) edit(() => { c.text.bg = b.dataset.v; });
  else if(b.closest('#p-shadow') && c?.text) edit(() => { c.text.shadow = b.dataset.v; });
  else if(b.closest('#p-pos') && c){
    const W = screen.width, H = screen.height, bx = boxOf({...c, kf: undefined, tf: {...tfAt(c), r: 0}}, W, H), v = b.dataset.v;
    const mx = Math.min(.5, bx.w / 2 / W + (c.track === 'v' ? 0 : .04)), my = Math.min(.5, bx.h / 2 / H + (c.track === 'v' ? 0 : .04));
    edit(() => editTf(c, tf => { tf.x = v[1] === 'l' ? mx : v[1] === 'r' ? 1 - mx : .5; tf.y = v[0] === 't' ? my : v[0] === 'b' ? 1 - my : .5; }));
  }
});
$('#props').addEventListener('input', e => {
  const c = sel && clipById(sel), v = +e.target.value, id = e.target.id;
  if(c?.text){
    const T = c.text, out = txt => { const o = $('#' + id + '-out'); if(o) o.textContent = txt; };
    if(id === 'p-text'){ live(() => { T.content = e.target.value; }); renderTimeline(); return; }
    if(id === 'p-tcolor'){ live(() => { T.color = e.target.value; }); return; }
    if(id === 'p-scolor'){ live(() => { T.strokeColor = e.target.value; }); return; }
    if(id === 'p-bgcolor'){ live(() => { T.bgColor = e.target.value; }); return; }
    if(id === 'p-stroke'){ live(() => { T.stroke = v / 100; }); out(v + '%'); return; }
    if(id === 'p-bgop'){ live(() => { T.bgOp = v / 100; }); out(v + '%'); return; }
  }
  const out = txt => { const o = $('#' + id + '-out'); if(o) o.textContent = txt; };
  const tfSet = fn => live(() => editTf(c, fn));
  const cm = id.match(/^p-crop-([lrtb])$/);
  if(cm && c){ live(() => { c.crop = {l: 0, t: 0, r: 0, b: 0, ...(c.crop || {})}; c.crop[cm[1]] = v / 100; }); out(v + '%'); return; }
  if(id === 'p-vol' && c){ live(() => { c.volume = v / 100; }); out(v + '%'); syncMedia(!playing); }
  else if(id === 'p-bg') live(() => { S.bg = e.target.value; });
  else if(id === 'p-size' && c){ tfSet(tf => { tf.s = v / 100; }); out(v + '%'); }
  else if(id === 'p-rot' && c){ tfSet(tf => { tf.r = v; }); out(v + '°'); }
  else if(id === 'p-op' && c){ tfSet(tf => { tf.op = v / 100; }); out(v + '%'); }
  else if(id === 'p-fi' && c){ live(() => { c.fi = v; }); out(fmtSec(v)); renderTimeline(); }
  else if(id === 'p-fo' && c){ live(() => { c.fo = v; }); out(fmtSec(v)); renderTimeline(); }
  else if(id === 'p-mfi' || id === 'p-mfo'){ const k = id === 'p-mfi' ? 'fi' : 'fo'; live(() => { sels().filter(hasSound).forEach(x => { x[k] = Math.min(v, (cutEnd(entryOf(x)) - entryOf(x).start) / 2); }); }); out(fmtSec(v)); renderTimeline(); }
});
$('#props').addEventListener('change', e => {
  const c = sel && clipById(sel), id = e.target.id;
  if(c?.text){
    const T = c.text;
    if(['p-text', 'p-tcolor', 'p-scolor', 'p-bgcolor', 'p-stroke', 'p-bgop'].includes(id)){ liveEnd(); return; }
    const set = {'p-font': ['font', x => x], 'p-weight': ['weight', Number], 'p-ain': ['ain', x => x], 'p-aout': ['aout', x => x], 'p-italic': ['italic', () => e.target.checked]}[id];
    if(set){ edit(() => { T[set[0]] = set[1](e.target.value); }); return; }
  }
  if(['p-vol', 'p-bg', 'p-size', 'p-rot', 'p-op', 'p-fi', 'p-fo', 'p-mfi', 'p-mfo'].includes(id) || /^p-crop-/.test(id)){ liveEnd(); }
  else if(id === 'p-mute' && c) edit(() => { c.muted = e.target.checked; });
  else if(id === 'p-dur' && c){ const d = clamp(parseFloat(e.target.value) || 5, MIN, 3600); edit(() => { c.out = c.in + d; }); }
  else if(id === 'p-tr' && c) setTransition(c, e.target.value);
});

/* ---------- biblioteca: abas ---------- */
const pv = new Audio(); let pvIdx = -1;   // prévia das músicas
function stopPreview(){ pv.pause(); pvIdx = -1; $$('.lib-play.on').forEach(b => { b.classList.remove('on'); b.innerHTML = ICON.play; }); }
function showTab(id){
  $$('.lib-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
  $$('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== id; });
  if(id !== 'music') stopPreview();
  if(id === 'music' && !MU.loaded) searchMusic();
  if(id === 'els' && !EL.loaded) searchEls();
}
$$('.lib-tabs [data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
// buscas em português viram inglês (as bibliotecas são em inglês)
const PT = {
  calma: 'calm', calmo: 'calm', relaxante: 'relaxing', animada: 'upbeat', animado: 'upbeat', feliz: 'happy', alegre: 'happy', triste: 'sad', piano: 'piano', violao: 'acoustic guitar',
  guitarra: 'guitar', corporativa: 'corporate', corporativo: 'corporate', cinematica: 'cinematic', epica: 'epic', epico: 'epic', suspense: 'suspense', festa: 'party', natal: 'christmas',
  romantica: 'romantic', romantico: 'romantic', infantil: 'kids', eletronica: 'electronic', acustica: 'acoustic', inspiradora: 'inspiring', motivacional: 'motivational',
  aplausos: 'applause', clique: 'click', risada: 'laugh', explosao: 'explosion', chuva: 'rain', vento: 'wind', passos: 'footsteps', porta: 'door', sino: 'bell', transicao: 'whoosh',
  notificacao: 'notification', impacto: 'impact', tambor: 'drum', agua: 'water', carro: 'car', buzina: 'horn', dinheiro: 'money', caixa: 'cash register',
  estrela: 'star', estrelas: 'star', seta: 'arrow', setas: 'arrow', coracao: 'heart', coracoes: 'heart', fogo: 'fire', casa: 'house', telefone: 'phone', celular: 'phone', email: 'mail',
  localizacao: 'location', mapa: 'map', relogio: 'clock', calendario: 'calendar', certo: 'check', errado: 'cross', like: 'thumbs up', joinha: 'thumbs up',
  sol: 'sun', lua: 'moon', flor: 'flower', ferramenta: 'tool', pincel: 'brush', tinta: 'paint', presente: 'gift', trofeu: 'trophy', foguete: 'rocket', raio: 'lightning',
  balao: 'speech bubble', carinha: 'face', rosto: 'face', sorriso: 'smile', olho: 'eye', mao: 'hand', compras: 'shopping', carrinho: 'cart', cadeado: 'lock',
};
const toEn = q => q.trim().split(/\s+/).map(w => PT[noAccent(w)] || w).join(' ');

/* músicas e efeitos (Openverse) */
const MU = {kind: 'music', q: '', chip: 0, page: 1, items: [], loaded: false, busy: false, more: false, err: false};
const MU_CHIPS = {
  music: [['Animada', 'upbeat'], ['Calma', 'calm'], ['Corporativa', 'corporate'], ['Cinemática', 'cinematic'], ['Lo-fi', 'lofi'], ['Acústica', 'acoustic'], ['Eletrônica', 'electronic'], ['Inspiradora', 'inspiring']],
  sfx: [['Whoosh', 'whoosh'], ['Clique', 'click'], ['Pop', 'pop'], ['Aplausos', 'applause'], ['Notificação', 'notification'], ['Impacto', 'impact'], ['Risada', 'laugh'], ['Sino', 'bell']],
};
const licLabel = a => a.license === 'cc0' ? 'CC0' : a.license === 'pdm' ? 'Domínio público' : `CC ${a.license.toUpperCase()} ${a.license_version || ''}`.trim();
function renderMuChips(){ $('#mu-chips').innerHTML = MU_CHIPS[MU.kind].map(([l], i) => `<button type="button" data-i="${i}" aria-pressed="${!MU.q && MU.chip === i}">${l}</button>`).join(''); }
async function searchMusic(more = false){
  if(MU.busy) return;
  MU.busy = true; MU.err = false;
  if(more) MU.page++; else { MU.page = 1; MU.items = []; stopPreview(); }
  renderMusic();
  const q = MU.q ? toEn(MU.q) : MU_CHIPS[MU.kind][MU.chip][1];
  let url = `https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&license_type=commercial,modification&page_size=20&page=${MU.page}`;
  url += MU.kind === 'music' ? '&category=music' : '&source=freesound';
  try{
    const r = await fetch(url); if(!r.ok) throw new Error(r.status);
    const j = await r.json();
    MU.items.push(...j.results.filter(a => a.url));
    MU.more = MU.page < (j.page_count || 1); MU.loaded = true;
  }catch{ MU.err = true; }
  MU.busy = false; renderMusic();
}
function renderMusic(){
  renderMuChips();
  $('#mu-list').innerHTML = MU.items.map((a, i) => `<li class="lib-it" draggable="true" data-i="${i}">
      <button class="lib-play${pvIdx === i ? ' on' : ''}" type="button" data-act="play" aria-label="Ouvir ${esc(a.title)}">${pvIdx === i ? ICON.pause : ICON.play}</button>
      <div><b title="${esc(a.title)}">${esc(a.title || 'Sem título')}</b><span>${esc(a.creator || 'autor desconhecido')} · ${fmtTime((a.duration || 0) / 1000, false)} · ${licLabel(a)}</span></div>
      <button class="lib-add" type="button" data-act="add" title="Colocar na timeline" aria-label="Colocar ${esc(a.title)} na timeline">${ICON.plus}</button></li>`).join('')
    + (MU.busy ? '<li class="lib-msg"><span class="loading">Buscando…</span></li>'
      : MU.err ? '<li class="lib-msg">Não consegui buscar agora. Verifique a internet e tente de novo.</li>'
      : !MU.items.length ? '<li class="lib-msg">Nada encontrado. Tente outra palavra.</li>'
      : MU.more ? '<li class="lib-msg"><button class="ghost sm lib-more" type="button" data-act="more">Carregar mais</button></li>' : '');
}
$('#mu-kind').addEventListener('click', e => {
  const b = e.target.closest('[data-v]'); if(!b || b.dataset.v === MU.kind) return;
  MU.kind = b.dataset.v; MU.chip = 0; MU.q = ''; $('#mu-q').value = '';
  $$('#mu-kind button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  $('#mu-q').placeholder = MU.kind === 'music' ? 'Buscar: calma, animada, rock…' : 'Buscar: aplausos, clique, chuva…';
  searchMusic();
});
$('#mu-chips').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if(!b) return; MU.chip = +b.dataset.i; MU.q = ''; $('#mu-q').value = ''; searchMusic(); });
$('#mu-form').addEventListener('submit', e => { e.preventDefault(); MU.q = $('#mu-q').value.trim(); searchMusic(); });
$('#mu-list').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  if(b.dataset.act === 'more') return searchMusic(true);
  const li = b.closest('.lib-it'), i = +li.dataset.i, a = MU.items[i];
  if(b.dataset.act === 'play'){
    if(pvIdx === i){ stopPreview(); return; }
    stopPreview(); pvIdx = i; pv.src = a.url; pv.play().catch(() => toast('Não consegui tocar a prévia'));
    b.classList.add('on'); b.innerHTML = ICON.pause;
  } else importAudio(a, MU.kind === 'sfx' ? {start: t} : {}, li);
});
pv.addEventListener('ended', stopPreview);
$('#mu-list').addEventListener('dragstart', e => {
  const li = e.target.closest('.lib-it'); if(!li) return;
  e.dataTransfer.setData(MT.audio, JSON.stringify(MU.items[+li.dataset.i])); e.dataTransfer.effectAllowed = 'copy';
});
// baixa a música para o navegador e coloca numa trilha de áudio, guardando os créditos
async function importAudio(a, opt = {}, li = null){
  li = li || $$('#mu-list .lib-it').find(x => MU.items[+x.dataset.i] === a) || null;
  li?.classList.add('busy');
  try{
    const r = await fetch(a.url); if(!r.ok) throw 0;
    const blob = await r.blob();
    const type = blob.type.startsWith('audio/') ? blob.type : 'audio/mpeg';
    const name = (a.title || 'musica').slice(0, 60);
    const f = new File([blob], `${slug(name) || 'musica'}.${type.includes('wav') ? 'wav' : type.includes('ogg') ? 'ogg' : 'mp3'}`, {type});
    addFiles([f], opt, {name, credit: {title: a.title || 'Sem título', creator: a.creator || 'autor desconhecido', license: licLabel(a), url: a.foreign_landing_url || a.url}});
    li?.classList.add('added');
    toast('Adicionada numa trilha de áudio');
  }catch{ toast('Não consegui baixar esse áudio. Tente outro.'); }
  li?.classList.remove('busy');
}

/* elementos (Iconify) */
const EL = {kind: 'color', q: '', chip: 0, color: '#ffffff', icons: [], loaded: false, busy: false, err: false};
const EL_SETS = {color: 'fluent-emoji-flat,noto,flat-color-icons,logos', mono: 'ph,tabler,mdi'};
const EL_CHIPS = [['Emojis', 'face'], ['Estrelas', 'star'], ['Setas', 'arrow'], ['Corações', 'heart'], ['Redes sociais', ['instagram', 'whatsapp', 'youtube', 'tiktok', 'facebook', 'linkedin']],
  ['Fogo', 'fire'], ['Festa', 'party'], ['Check', 'check'], ['Balões', 'speech'], ['Dinheiro', 'money'], ['Casa', 'house'], ['Contato', ['phone', 'mail', 'location']]];
const EL_COLORS = ['#ffffff', '#111111', '#016a71', '#e5484d', '#f5b400', '#2e86de'];
// os desenhos vêm em lote (um pedido por coleção) e o SVG é montado aqui: rápido e sem estourar o limite da API
const ICON_DATA = new Map();   // "prefixo:nome" -> {body, w, h}
function svgOf(id, h, color){
  const d = ICON_DATA.get(id); if(!d) return '';
  const body = color ? d.body.replaceAll('currentColor', color) : d.body;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(h * d.w / d.h)}" height="${h}" viewBox="0 0 ${d.w} ${d.h}">${body}</svg>`;
}
const iconThumb = id => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgOf(id, 64, EL.kind === 'mono' ? EL.color : null));
async function loadIconData(ids){
  const byPre = {};
  for(const id of ids){ if(ICON_DATA.has(id)) continue; const [pre, name] = id.split(':'); (byPre[pre] ||= []).push(name); }
  await Promise.all(Object.entries(byPre).map(async ([pre, names]) => {
    const j = await (await fetch(`https://api.iconify.design/${pre}.json?icons=${names.join(',')}`)).json();
    for(const name of names){
      const al = j.aliases?.[name], ic = j.icons?.[name] || (al && j.icons?.[al.parent]);
      if(ic) ICON_DATA.set(`${pre}:${name}`, {body: ic.body, w: ic.width || al?.width || j.width || 16, h: ic.height || al?.height || j.height || 16});
    }
  }));
}
async function searchEls(){
  if(EL.busy) return;
  EL.busy = true; EL.err = false; renderEls();
  const qs = EL.q ? [toEn(EL.q)] : [].concat(EL_CHIPS[EL.chip][1]);
  const social = !EL.q && Array.isArray(EL_CHIPS[EL.chip][1]);
  try{
    const res = await Promise.all(qs.map(q => fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=${qs.length > 1 ? 16 : 96}&prefixes=${social && EL.kind === 'color' ? 'logos,fluent-emoji-flat,flat-color-icons' : EL_SETS[EL.kind]}`).then(r => r.json())));
    const ids = [...new Set(res.flatMap(j => j.icons || []))];
    await loadIconData(ids);
    EL.icons = ids.filter(id => ICON_DATA.has(id));
    EL.loaded = true;
  }catch{ EL.err = true; EL.icons = []; }
  EL.busy = false; renderEls();
}
function renderEls(){
  $('#el-chips').innerHTML = EL_CHIPS.map(([l], i) => `<button type="button" data-i="${i}" aria-pressed="${!EL.q && EL.chip === i}">${l}</button>`).join('');
  const cols = $('#el-colors');
  cols.hidden = EL.kind !== 'mono';
  cols.innerHTML = '<span>Cor</span>' + EL_COLORS.map(c => `<button type="button" data-c="${c}" style="background:${c}" aria-label="Cor ${c}" aria-pressed="${EL.color === c}"></button>`).join('');
  $('#el-grid').innerHTML = EL.busy ? '<p class="lib-msg"><span class="loading">Buscando…</span></p>'
    : EL.err ? '<p class="lib-msg">Não consegui buscar agora. Verifique a internet.</p>'
    : !EL.icons.length ? '<p class="lib-msg">Nada encontrado. Tente em inglês (ex.: arrow, star).</p>'
    : EL.icons.map(id => `<button type="button" draggable="true" data-id="${esc(id)}" title="${esc(id.split(':')[1].replace(/-/g, ' '))}"><img src="${iconThumb(id)}" alt=""></button>`).join('');
  $('#el-grid').style.setProperty('--el-bg', EL.kind === 'mono' && EL.color === '#ffffff' ? '#8a8780' : '');
}
$('#el-kind').addEventListener('click', e => {
  const b = e.target.closest('[data-v]'); if(!b || b.dataset.v === EL.kind) return;
  EL.kind = b.dataset.v; $$('#el-kind button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  searchEls();
});
$('#el-chips').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if(!b) return; EL.chip = +b.dataset.i; EL.q = ''; $('#el-q').value = ''; searchEls(); });
$('#el-form').addEventListener('submit', e => { e.preventDefault(); EL.q = $('#el-q').value.trim(); searchEls(); });
$('#el-colors').addEventListener('click', e => { const b = e.target.closest('[data-c]'); if(!b) return; EL.color = b.dataset.c; renderEls(); });
$('#el-grid').addEventListener('click', e => { const b = e.target.closest('[data-id]'); if(b) importEl({id: b.dataset.id, color: EL.kind === 'mono' ? EL.color : null}, {start: t}, b); });
$('#el-grid').addEventListener('dragstart', e => {
  const b = e.target.closest('[data-id]'); if(!b) return;
  e.dataTransfer.setData(MT.el, JSON.stringify({id: b.dataset.id, color: EL.kind === 'mono' ? EL.color : null})); e.dataTransfer.effectAllowed = 'copy';
});
// monta o SVG em alta e coloca numa trilha de cima, por cima do vídeo
async function importEl(item, opt, btn = null){
  btn?.classList.add('busy');
  try{
    if(!ICON_DATA.has(item.id)) await loadIconData([item.id]);
    const svg = svgOf(item.id, 512, item.color); if(!svg) throw 0;
    const name = item.id.split(':')[1];
    addFiles([new File([svg], `${name}.svg`, {type: 'image/svg+xml'})], opt, {name: name.replace(/-/g, ' '), sticker: true});
  }catch{ toast('Não consegui carregar esse elemento'); }
  btn?.classList.remove('busy');
}

/* texto (aba) */
const tpStyle = p => { const o = {...TXT_BASE, ...p.o}; return `font-family:'${o.font}';font-weight:${o.weight};${o.italic ? 'font-style:italic;' : ''}color:${o.color};font-size:${clamp(o.size * 190, 13, 26)}px;`
  + (o.stroke ? `-webkit-text-stroke:${Math.max(1, o.stroke * 22)}px ${o.strokeColor};paint-order:stroke fill;` : '')
  + (o.bg === 'box' ? `background:${hexA(o.bgColor, o.bgOp)};padding:3px 8px;border-radius:5px;` : '')
  + (o.shadow === 'glow' ? `text-shadow:0 0 10px ${o.color};` : o.shadow === 'soft' ? 'text-shadow:0 2px 6px rgba(0,0,0,.5);' : ''); };
$('#txt-grid').innerHTML = TXT_PRESETS.map(p => `<button class="txt-card" type="button" draggable="true" data-p="${p.id}" title="${p.label}"><span style="${tpStyle(p)}">${esc(p.o.content)}</span></button>`).join('');
$('#cap-style').innerHTML = TXT_PRESETS.filter(p => ['legenda', 'sub', 'destaque', 'neon'].includes(p.id)).map(p => `<option value="${p.id}">${p.label}</option>`).join('');
// texto novo: começa no cursor, dura 3 s, numa trilha de vídeo livre (ou na trilha onde foi solto)
function addText(pid, opt = {}){
  const start = Math.max(0, opt.start ?? t), dur = 3;
  let c;
  edit(() => { c = textClip(pid, {}, start, dur, pickTrack('video', start, start + dur, opt.track || null)); S.clips.push(c); setSelection([c.id]); });
  changed();
  // já deixa o campo de texto pronto para digitar
  setTimeout(() => { const ta = $('#p-text'); if(ta){ ta.focus(); ta.select(); } }, 50);
  return c;
}
$('#txt-add').addEventListener('click', () => addText('sub'));
$('#txt-grid').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if(b) addText(b.dataset.p); });
$('#txt-grid').addEventListener('dragstart', e => { const b = e.target.closest('[data-p]'); if(!b) return; e.dataTransfer.setData(MT.txt, b.dataset.p); e.dataTransfer.effectAllowed = 'copy'; });
// legendas ficam numa trilha própria, a mais de cima; criar de novo substitui as anteriores (dá para desfazer)
function putCaptions(items, pid){
  edit(() => {
    let tr = S.tracks.find(x => x.name === 'Legendas');
    if(tr) S.clips = S.clips.filter(c => c.track !== tr.id);
    else { tr = {id: 't' + uid(), kind: 'video', name: 'Legendas'}; S.tracks.unshift(tr); }
    S.tracks.splice(S.tracks.indexOf(tr), 1); S.tracks.unshift(tr);
    items.forEach(it => S.clips.push(textClip(pid, {content: it.text}, it.start, Math.max(MIN, it.end - it.start), tr.id, true)));
    setSelection([]);
  });
  if(autoFit) zoomFit();
}
$('#cap-go').addEventListener('click', () => {
  const lines = $('#cap-txt').value.split('\n').map(x => x.trim()).filter(Boolean);
  if(!lines.length){ toast('Cole o texto das legendas, uma por linha'); $('#cap-txt').focus(); return; }
  // espalha no clipe selecionado ou no vídeo todo; linhas mais longas ficam mais tempo na tela
  const s0 = sel && clipById(sel), e0 = s0 && entryOf(s0);
  let a = e0 ? e0.start : 0, b = e0 ? e0.end : L().total;
  if(b - a < lines.length * .6) b = a + lines.length * 2.5;
  const w = lines.map(l => Math.max(8, l.length)), sum = w.reduce((x, y) => x + y, 0);
  let cur = a;
  const items = lines.map((text, i) => { const d = (b - a) * w[i] / sum, it = {text, start: cur, end: cur + d - .05}; cur += d; return it; });
  putCaptions(items, $('#cap-style').value);
  toast(`${lines.length} ${lines.length === 1 ? 'legenda criada' : 'legendas criadas'}`);
});
// .srt (e .vtt): tempos "00:00:01,500 --> 00:00:03,000"
function parseSrt(txt){
  const out = [];
  for(const block of txt.replace(/\r/g, '').split(/\n\s*\n/)){
    const m = block.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/); if(!m) continue;
    const sec = (h, mi, se, ms) => +h * 3600 + +mi * 60 + +se + +ms / 1000;
    const text = block.slice(block.indexOf(m[0]) + m[0].length).replace(/^[^\n]*\n?/, '').replace(/<[^>]+>/g, '').trim();
    if(text) out.push({start: sec(m[1], m[2], m[3], m[4]), end: sec(m[5], m[6], m[7], m[8]), text});
  }
  return out;
}
$('#cap-srt-in').addEventListener('click', () => $('#cap-file').click());
$('#cap-file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if(!f) return;
  const items = parseSrt(await f.text());
  if(!items.length){ toast('Não encontrei legendas nesse arquivo'); return; }
  putCaptions(items, $('#cap-style').value);
  toast(`${items.length} legendas importadas`);
});
$('#cap-srt-out').addEventListener('click', () => {
  const tr = S.tracks.find(x => x.name === 'Legendas');
  const list = S.clips.filter(c => c.text && (tr ? c.track === tr.id : true)).map(c => entryOf(c)).filter(Boolean).sort((a, b) => a.start - b.start);
  if(!list.length){ toast('Ainda não há legendas'); return; }
  const ts = x => { const ms = Math.round(x * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const srt = list.map((e, i) => `${i + 1}\n${ts(e.start)} --> ${ts(e.end)}\n${e.c.text.content}\n`).join('\n');
  save(new Blob([srt], {type: 'text/plain'}), `${slug($('#proj-name').value) || 'video'}.srt`);
});

/* transições (aba) */
$('#tr-grid').innerHTML = TRS.map(x => `<div class="tr-card" draggable="true" role="button" tabindex="0" data-tr="${x.id}" title="Arraste até o encontro de dois clipes">${trPrev(x.id)}${x.label}</div>`).join('');
function quickTransition(type){
  const l = L();
  if(l.v.length < 2){ toast('Coloque pelo menos dois clipes na trilha de vídeo'); return; }
  const s = sel && clipById(sel);
  const target = s?.track === 'v' && l.v.findIndex(e => e.c === s) > 0 ? s : nearestCut(t).c;
  setTransition(target, type, TRD.d);
}
$('#tr-grid').addEventListener('click', e => { const c = e.target.closest('[data-tr]'); if(c) quickTransition(c.dataset.tr); });
$('#tr-grid').addEventListener('keydown', e => { const c = e.target.closest('[data-tr]'); if(c && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); quickTransition(c.dataset.tr); } });
$('#tr-grid').addEventListener('dragstart', e => { const c = e.target.closest('[data-tr]'); if(!c) return; e.dataTransfer.setData(MT.tr, c.dataset.tr); e.dataTransfer.effectAllowed = 'copy'; });
$('#tr-dur').addEventListener('input', e => { TRD.d = +e.target.value; $('#tr-dur-out').textContent = fmtSec(TRD.d); });
$('#tr-all').addEventListener('click', () => {
  const l = L(); if(l.v.length < 2){ toast('Coloque pelo menos dois clipes na trilha de vídeo'); return; }
  edit(() => { l.v.slice(1).forEach(e => { e.c.tr = {type: TRD.type, d: TRD.d}; }); });
  toast(`"${TR[TRD.type].label}" em todos os cortes`);
});
$('#tr-none').addEventListener('click', () => { edit(() => { S.clips.forEach(c => { if(c.tr) c.tr = null; }); }); toast('Transições removidas'); });
// áudio: suaviza entrada e saída de todas as músicas (até 1,5 s, sem passar da metade do clipe)
$('#fade-all').addEventListener('click', () => {
  const list = L().a; if(!list.length){ toast('Ainda não há músicas na timeline'); return; }
  edit(() => { list.forEach(e => { const d = Math.min(1.5, (cutEnd(e) - e.start) / 3); e.c.fi = d; e.c.fo = d; }); });
  toast('O som das músicas agora entra e sai suave');
});
$('#fade-none').addEventListener('click', () => { edit(() => { S.clips.forEach(c => { c.fi = 0; c.fo = 0; }); }); toast('Suavização removida'); });

/* ---------- arquivos: botões e arrastar ---------- */
const fileIn = $('#file');
$('#import').addEventListener('click', () => fileIn.click());
$('#import2').addEventListener('click', () => fileIn.click());
fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; });
$('#media-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const m = media.get(b.closest('.mi').dataset.mid); if(!m) return;
  if(b.dataset.act === 'add') addToTimeline(m, m.sticker ? {start: t} : {});
  else {
    const used = S.clips.filter(c => c.mid === m.id).length;
    if(used && !confirm(`"${m.name}" está em ${used === 1 ? '1 clipe' : used + ' clipes'} da timeline. Remover mesmo assim?`)) return;
    if(used) edit(() => { S.clips = S.clips.filter(c => c.mid !== m.id); });
    URL.revokeObjectURL(m.url); m.thumbs.forEach(x => URL.revokeObjectURL(x.url)); if(m.wave) URL.revokeObjectURL(m.wave);
    media.delete(m.id); if(PID) dbRun('media', 'readwrite', st => st.delete(m.id)).catch(() => {});
    renderMedia(); changed();
  }
});
$('#media-grid').addEventListener('dblclick', e => { const li = e.target.closest('.mi'); const m = li && media.get(li.dataset.mid); if(m?.status === 'ready' && !e.target.closest('button')) addToTimeline(m, m.sticker ? {start: t} : {}); });
$('#media-grid').addEventListener('dragstart', e => { const li = e.target.closest('.mi'); if(!li) return; e.dataTransfer.setData(MT.media, li.dataset.mid); e.dataTransfer.effectAllowed = 'copy'; });
// arquivos do computador soltos em qualquer lugar (fora da timeline) entram na lista
const mediaBody = $('#media-drop');
let depth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if(hasFiles(e)){ depth++; mediaBody.classList.add('over'); } });
window.addEventListener('dragleave', e => { if(hasFiles(e) && --depth <= 0){ depth = 0; mediaBody.classList.remove('over'); } });
window.addEventListener('dragover', e => { if(hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => { depth = 0; mediaBody.classList.remove('over'); if(hasFiles(e)){ e.preventDefault(); showTab('files'); addFiles(e.dataTransfer.files); } });

/* ---------- transporte ---------- */
$('#play').addEventListener('click', toggle);
$('#to-start').addEventListener('click', () => seek(0));
$('#to-end').addEventListener('click', () => { pause(); seek(L().total); });
$('#frame-back').addEventListener('click', () => { pause(); seek(t - 1 / FPS); });
$('#frame-fwd').addEventListener('click', () => { pause(); seek(t + 1 / FPS); });
$('#fullscreen').addEventListener('click', () => { const w = $('#stage-wrap'); document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen?.(); });
document.addEventListener('fullscreenchange', () => setTimeout(sizeScreen, 50));

/* ---------- barra do projeto e diálogos ---------- */
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#keys-btn').addEventListener('click', () => gelOpen($('#keys-dlg')));
$('#keys-x').addEventListener('click', () => gelClose($('#keys-dlg')));
$$('dialog.gel').forEach(d => d.addEventListener('cancel', e => { e.preventDefault(); if(d.id === 'exp-dlg' && EXP.on) return; gelClose(d); }));
$$('dialog.gel').forEach(d => d.addEventListener('click', e => { if(e.target === d && !(d.id === 'exp-dlg' && EXP.on)) gelClose(d); }));

/* ---------- altura da timeline ---------- */
const rz = $('#resizer');
function setTlH(h){ h = clamp(h, 170, Math.max(200, innerHeight * .7)); $('#ed').style.setProperty('--tl-h', h + 'px'); try{ localStorage.setItem('ed-tl-h', h); }catch{} }
try{ const h = +localStorage.getItem('ed-tl-h'); if(h) setTlH(h); }catch{}
rz.addEventListener('pointerdown', e => {
  capture(rz, e); rz.classList.add('drag');
  const y0 = e.clientY, h0 = $('.tl').getBoundingClientRect().height;
  const mv = ev => setTlH(h0 - (ev.clientY - y0));
  const up = () => { rz.classList.remove('drag'); rz.removeEventListener('pointermove', mv); rz.removeEventListener('pointerup', up); renderTimeline(); };
  rz.addEventListener('pointermove', mv); rz.addEventListener('pointerup', up);
});
rz.addEventListener('keydown', e => { if(e.key === 'ArrowUp' || e.key === 'ArrowDown'){ e.preventDefault(); setTlH($('.tl').getBoundingClientRect().height + (e.key === 'ArrowUp' ? 20 : -20)); } });
new ResizeObserver(() => renderTimeline()).observe(scroller);

/* ---------- atalhos ---------- */
document.addEventListener('keydown', e => {
  if(document.querySelector('dialog[open]')) return;
  const tg = e.target instanceof Element ? e.target : document.body;
  if(tg.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select')) return;
  const k = e.key, mod = e.ctrlKey || e.metaKey, low = k.toLowerCase();
  if(mod && low === 'z'){ e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if(mod && low === 'y'){ e.preventDefault(); redo(); return; }
  if(mod && low === 'd'){ e.preventDefault(); duplicate(); return; }
  if(mod && low === 'a'){ e.preventDefault(); setSelection(S.clips.map(c => c.id)); closeTrPop(); renderTimeline(); renderProps(); updateUi(); dirty = true; return; }
  if(mod || e.altKey) return;
  if(tg.closest('input[type="range"]') && k.startsWith('Arrow')) return;
  if(k === ' '){ e.preventDefault(); toggle(); }
  else if(low === 's'){ e.preventDefault(); split(); }
  else if(k === 'Delete' || k === 'Backspace'){ e.preventDefault(); del(); }
  else if(k === 'ArrowLeft' || k === 'ArrowRight'){ e.preventDefault(); pause(); seek(t + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS)); }
  else if(k === 'Home'){ e.preventDefault(); seek(0); }
  else if(k === 'End'){ e.preventDefault(); pause(); seek(L().total); }
  else if(low === 'n'){ setSnap(!snapOn); toast(snapOn ? 'Ímã ligado' : 'Ímã desligado'); }
  else if(k === '+' || k === '='){ manualZoom(pps * 1.4); }
  else if(k === '-' || k === '_'){ manualZoom(pps / 1.4); }
  else if(k === 'Escape'){ if(trkMenuFor) closeTrkMenu(); else if(trFor) closeTrPop(); else if(selSet.size) select(null); }
});

/* ---------- mixer (estilo FL Studio): um canal por trilha + master, com efeitos ---------- */
// caminho do som: clipe → canal da trilha (efeitos → volume → pan → medidor) → master (efeitos → volume → medidor) → saída
// parâmetro: [rótulo, mín, máx, passo, padrão, unidade, 'log'?]  ou  [rótulo, {opções}, padrão]
const FX = {
  eq: {label: 'EQ 3 bandas', p: {low: ['Graves', -15, 15, .5, 0, 'dB'], mid: ['Médios', -15, 15, .5, 0, 'dB'], midf: ['Frequência dos médios', 200, 5000, 10, 1000, 'Hz', 'log'], high: ['Agudos', -15, 15, .5, 0, 'dB']}},
  filter: {label: 'Filtro', p: {mode: ['Tipo', {lowpass: 'Passa-baixa (abafa)', highpass: 'Passa-alta (tira graves)', bandpass: 'Passa-banda (rádio)'}, 'lowpass'], freq: ['Frequência', 40, 18000, 1, 1500, 'Hz', 'log'], q: ['Ressonância', .1, 15, .1, .8, '']}},
  comp: {label: 'Compressor', p: {threshold: ['Limiar', -60, 0, 1, -24, 'dB'], ratio: ['Razão', 1, 20, .5, 4, ':1'], attack: ['Ataque', 0, 200, 1, 5, 'ms'], release: ['Soltura', 10, 1000, 10, 250, 'ms'], makeup: ['Ganho', 0, 24, .5, 0, 'dB']}},
  reverb: {label: 'Reverb', p: {size: ['Tamanho da sala', .3, 8, .1, 2.2, 's'], tone: ['Brilho', 500, 16000, 100, 7000, 'Hz', 'log'], mix: ['Mistura', 0, 100, 1, 30, '%']}},
  delay: {label: 'Delay (eco)', p: {time: ['Tempo', 20, 1500, 5, 320, 'ms'], feedback: ['Repetições', 0, 90, 1, 35, '%'], mix: ['Mistura', 0, 100, 1, 30, '%']}},
  dist: {label: 'Distorção', p: {drive: ['Intensidade', 0, 100, 1, 30, '%'], mix: ['Mistura', 0, 100, 1, 100, '%']}},
  limiter: {label: 'Limitador', p: {ceiling: ['Teto', -12, 0, .5, -1, 'dB']}},
};
const fxDefaults = type => Object.fromEntries(Object.entries(FX[type].p).map(([k, d]) => [k, typeof d[1] === 'object' ? d[2] : d[4]]));
const dB = x => Math.pow(10, x / 20);
// garante os campos de mixagem em todas as trilhas (velhas ou novas)
function normalize(){
  S.main = S.main || {};
  S.master = S.master || {vol: 1, fx: []};
  S.master.vol ??= 1; S.master.fx = S.master.fx || [];
  for(const o of [S.main, ...S.tracks]){ o.vol ??= 1; o.pan ??= 0; o.fx = o.fx || []; }
}
normalize();
const chCfg = id => id === 'master' ? S.master : trkCfg(id);
const channelIds = () => ['master', 'v', ...S.tracks.map(x => x.id)];

function distCurve(amount){ const k = 1 + amount / 8, n = 2048, c = new Float32Array(n); for(let i = 0; i < n; i++){ const x = i * 2 / n - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); } return c; }
// cada efeito vira {input, output, set(params)}; ac = contexto de áudio (ao vivo ou offline, na exportação)
function makeFx(fx, ac = actx){
  const bq = (type, f, q) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; if(q) b.Q.value = q; return b; };
  const wetDry = () => { const input = ac.createGain(), output = ac.createGain(), dry = ac.createGain(), wet = ac.createGain(); input.connect(dry).connect(output); wet.connect(output); return {input, output, wet, setMix(v){ dry.gain.value = 1 - v; wet.gain.value = v; }}; };
  const impulse = sec => { const rate = ac.sampleRate, len = Math.max(1, Math.floor(rate * sec)), b = ac.createBuffer(2, len, rate); for(let ch = 0; ch < 2; ch++){ const d = b.getChannelData(ch); for(let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5); } return b; };
  switch(fx.type){
    case 'eq': { const lo = bq('lowshelf', 120), mi = bq('peaking', 1000, 1), hi = bq('highshelf', 8000); lo.connect(mi).connect(hi);
      return {input: lo, output: hi, set(p){ lo.gain.value = p.low; mi.gain.value = p.mid; mi.frequency.value = p.midf; hi.gain.value = p.high; }}; }
    case 'filter': { const f = bq('lowpass', 1500); return {input: f, output: f, set(p){ f.type = p.mode; f.frequency.value = p.freq; f.Q.value = p.q; }}; }
    case 'comp': { const c = ac.createDynamicsCompressor(), g = ac.createGain(); c.connect(g);
      return {input: c, output: g, set(p){ c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.knee.value = 6; c.attack.value = p.attack / 1000; c.release.value = p.release / 1000; g.gain.value = dB(p.makeup); }}; }
    case 'limiter': { const c = ac.createDynamicsCompressor(); c.knee.value = 0; c.ratio.value = 20; c.attack.value = .001; c.release.value = .05;
      return {input: c, output: c, set(p){ c.threshold.value = p.ceiling; }}; }
    case 'reverb': { const m = wetDry(), conv = ac.createConvolver(), tone = bq('lowpass', 7000); m.input.connect(conv); conv.connect(tone).connect(m.wet); let size = null;
      return {input: m.input, output: m.output, set(p){ if(p.size !== size){ size = p.size; conv.buffer = impulse(size); } tone.frequency.value = p.tone; m.setMix(p.mix / 100); }}; }
    case 'delay': { const m = wetDry(), d = ac.createDelay(2), fb = ac.createGain(); m.input.connect(d); d.connect(fb).connect(d); d.connect(m.wet);
      return {input: m.input, output: m.output, set(p){ d.delayTime.value = p.time / 1000; fb.gain.value = p.feedback / 100; m.setMix(p.mix / 100); }}; }
    case 'dist': { const m = wetDry(), ws = ac.createWaveShaper(); ws.oversample = '4x'; m.input.connect(ws).connect(m.wet); let dr = null;
      return {input: m.input, output: m.output, set(p){ if(p.drive !== dr){ dr = p.drive; ws.curve = distCurve(dr); } m.setMix(p.mix / 100); }}; }
  }
}
const buses = new Map();
function makeBus(id){
  const b = {id, input: actx.createGain(), fader: actx.createGain(), pan: id !== 'master' && actx.createStereoPanner ? actx.createStereoPanner() : null, an: actx.createAnalyser(), nodes: [], sig: null, peak: 0};
  b.an.fftSize = 1024; b.buf = new Float32Array(b.an.fftSize);
  (b.pan ? (b.fader.connect(b.pan), b.pan) : b.fader).connect(b.an);
  b.an.connect(id === 'master' ? master : busFor('master').input);
  b.input.connect(b.fader);
  buses.set(id, b);
  return b;
}
function busFor(id){
  if(!actx) return null;
  if(!chCfg(id)) id = 'v';
  return buses.get(id) || makeBus(id);
}
// aplica o estado do mixer no áudio: refaz a corrente de efeitos só quando muda a lista
function syncMixer(){
  if(!actx) return;
  const ids = channelIds(), anySolo = ids.some(id => id !== 'master' && chCfg(id)?.solo);
  for(const id of ids){
    const cfg = chCfg(id); if(!cfg) continue;
    const b = busFor(id), fx = (cfg.fx || []).filter(f => f.on && FX[f.type]);
    const sig = fx.map(f => f.id).join(',');
    if(b.sig !== sig){
      try{ b.input.disconnect(); }catch{}
      b.nodes.forEach(n => { try{ n.output.disconnect(); }catch{} });
      b.nodes = fx.map(f => Object.assign(makeFx(f), {fid: f.id}));
      let prev = b.input; for(const n of b.nodes){ prev.connect(n.input); prev = n.output; } prev.connect(b.fader);
      b.sig = sig;
    }
    b.nodes.forEach(n => { const f = fx.find(x => x.id === n.fid); if(f) n.set({...fxDefaults(f.type), ...f.p}); });
    const muted = id !== 'master' && (cfg.mute || (anySolo && !cfg.solo));
    b.fader.gain.value = muted ? 0 : (cfg.vol ?? 1);
    if(b.pan) b.pan.pan.value = cfg.pan || 0;
  }
  for(const [id, b] of buses) if(!ids.includes(id)){ try{ b.an.disconnect(); }catch{} buses.delete(id); }
}
function busLevel(b){ b.an.getFloatTimeDomainData(b.buf); let pk = 0; for(const v of b.buf) pk = Math.max(pk, Math.abs(v)); return pk; }

/* janela do mixer */
let mixSel = 'master', fxSel = 0;
const MIX_COLORS = {master: '#8a8780', v: '#1a8a92', video: '#8b5cf6', audio: '#d6336c', any: '#6b7280'};
function channelName(id){
  if(id === 'master') return 'Master';
  const r = rows().find(x => x.id === id);
  return r ? trackName(r) : 'Trilha';
}
const volDb = v => v <= 0.0001 ? '-∞' : (20 * Math.log10(v)).toFixed(1).replace('.', ',') + ' dB';
const panTxt = p => Math.abs(p) < .02 ? 'C' : (p < 0 ? 'E ' : 'D ') + Math.round(Math.abs(p) * 100);
// fader: posição = raiz do volume (0 dB fica a ~80% da altura, sobra um pouco para aumentar até +3,5 dB)
const fpos = v => Math.sqrt(clamp(v, 0, 1.5) / 1.5);
const fval = p => Math.round(1.5 * clamp(p, 0, 1) ** 2 * 100) / 100;
const FDR_MARKS = [[1.5, '+3'], [1, '0'], [.5, '-6'], [.25, '-12'], [.063, '-24'], [0, '-∞']];
const panRing = p => p >= 0 ? `conic-gradient(from 0deg, var(--c) 0 ${p * 135}deg, transparent 0)` : `conic-gradient(from ${p * 135}deg, var(--c) 0 ${-p * 135}deg, transparent 0)`;
function openMixer(id){ ensureAudio(); if(id) mixSel = id; fxSel = 0; renderMixer(); gelOpen($('#mixer')); }
function renderMixer(){
  const ids = ['master', 'v', ...upperTracks().filter(x => x.kind !== 'any').map(x => x.id), ...audioTracks().map(x => x.id)];
  if(!ids.includes(mixSel)) mixSel = 'master';
  $('#mx-strips').innerHTML = ids.map((id, n) => {
    const cfg = chCfg(id), kind = id === 'master' ? 'master' : id === 'v' ? 'v' : trackById(id)?.kind, v = cfg.vol ?? 1, pan = cfg.pan || 0, master = id === 'master';
    const fx = cfg.fx || [];
    return `<div class="mx-ch${id === mixSel ? ' on' : ''}${master ? ' master' : ''}${cfg.mute ? ' muted' : ''}" data-ch="${id}" style="--c:${MIX_COLORS[kind] || '#6b7280'}">
      <button class="ch-head" type="button" data-act="sel" title="${esc(channelName(id))}"><span class="ch-num">${master ? 'M' : n}</span><span class="ch-title">${esc(channelName(id))}</span></button>
      <div class="ch-body">
        <div class="ch-vu">
          <canvas class="st-meter" data-meter="${id}"></canvas>
          <div class="fdr" data-act="vol" role="slider" tabindex="0" aria-label="Volume de ${esc(channelName(id))}" aria-valuemin="0" aria-valuemax="150" aria-valuenow="${Math.round(v * 100)}" title="Arraste para mudar o volume · dois cliques voltam a 0 dB" style="--p:${fpos(v)}">
            <div class="fdr-scale">${FDR_MARKS.map(([g, l]) => `<i style="bottom:${(fpos(g) * 100).toFixed(1)}%"><b>${l}</b></i>`).join('')}</div>
            <div class="fdr-track"><div class="fdr-fill"></div></div>
            <div class="fdr-cap"></div>
          </div>
        </div>
        <output class="st-db">${volDb(v)}</output>
        ${master ? '<div class="ch-out">SAÍDA<small>vai para o vídeo</small></div>' : `<div class="ch-pan"><div class="knob-wrap"><div class="knob-ring" style="background:${panRing(pan)}"></div><div class="knob" data-act="pan" style="--a:${pan * 135}deg" title="Pan: arraste para cima/baixo · dois cliques centralizam"></div></div><span class="st-pan">${panTxt(pan)}</span></div>
        <div class="st-btns"><button class="lbtn m" type="button" data-act="mute" aria-pressed="${!!cfg.mute}" title="Mudo">M</button><button class="lbtn s" type="button" data-act="solo" aria-pressed="${!!cfg.solo}" title="Solo: só este canal toca">S</button></div>`}
        <ul class="st-fx">${Array.from({length: 4}, (_, i) => { const f = fx[i]; return f ? `<li class="${f.on ? 'on' : 'off'}"><i></i>${esc(FX[f.type]?.label || f.type)}</li>` : '<li class="free"><i></i>—</li>'; }).join('')}${fx.length > 4 ? `<li class="more">+${fx.length - 4} efeitos</li>` : ''}</ul>
      </div>
    </div>`;
  }).join('');
  // o medidor ocupa a altura que o fader tiver
  $$('#mx-strips .st-meter').forEach(cv => { cv.width = 14; cv.height = Math.max(60, cv.clientHeight); });
  renderRack();
}
function paramRow(f, k, d){
  const v = f.p[k] ?? (typeof d[1] === 'object' ? d[2] : d[4]);
  if(typeof d[1] === 'object') return `<label class="rk-p">${d[0]}<select class="inp" data-p="${k}">${Object.entries(d[1]).map(([o, l]) => `<option value="${o}"${o === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const [label, min, max, step, , unit, log] = d;
  const pos = log ? Math.round(Math.log(v / min) / Math.log(max / min) * 1000) : v;
  const shown = (Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)).toString().replace('.', ',') + (unit ? ' ' + unit : '');
  return `<div class="rk-p"><div class="pr-h"><span>${label}</span><output>${shown}</output></div><input type="range" data-p="${k}" ${log ? `min="0" max="1000" step="1" data-log="${min},${max}"` : `min="${min}" max="${max}" step="${step}"`} value="${pos}"></div>`;
}
function renderRack(){
  const cfg = chCfg(mixSel), fx = cfg.fx || [];
  if(fxSel >= fx.length) fxSel = Math.max(0, fx.length - 1);
  const f = fx[fxSel];
  const slots = Array.from({length: 8}, (_, i) => {
    const s = fx[i];
    if(!s) return `<li class="slot empty"><span>Slot ${i + 1}</span></li>`;
    return `<li class="slot${i === fxSel ? ' on' : ''}${s.on ? '' : ' off'}" data-i="${i}">
      <button class="led${s.on ? ' lit' : ''}" type="button" data-act="fx-on" title="${s.on ? 'Desligar' : 'Ligar'} efeito" aria-pressed="${s.on}"></button>
      <button class="slot-name" type="button" data-act="fx-sel">${esc(FX[s.type].label)}</button>
      <button class="slot-b" type="button" data-act="fx-up" title="Subir"${i === 0 ? ' disabled' : ''}>↑</button><button class="slot-b" type="button" data-act="fx-down" title="Descer"${i === fx.length - 1 ? ' disabled' : ''}>↓</button><button class="slot-b" type="button" data-act="fx-rm" title="Remover">×</button></li>`;
  }).join('');
  $('#mx-rack').innerHTML = `<div class="rk-h"><b>${esc(channelName(mixSel))}</b><span>Efeitos</span></div>
    <ol class="rk-slots">${slots}</ol>
    ${fx.length < 8 ? `<select class="inp rk-add" id="rk-add"><option value="">+ Adicionar efeito…</option>${Object.entries(FX).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('')}</select>` : ''}
    ${f ? `<div class="rk-params"><div class="rk-ptitle">${esc(FX[f.type].label)}${f.on ? '' : ' <em>(desligado)</em>'}</div>
      ${['eq', 'filter'].includes(f.type) ? '<canvas class="rk-curve" id="rk-curve" width="600" height="200"></canvas>' : ''}
      ${Object.entries(FX[f.type].p).map(([k, d]) => paramRow(f, k, d)).join('')}</div>` : '<p class="rk-empty">Escolha um efeito acima. Cada trilha pode ter até 8, aplicados de cima para baixo.</p>'}`;
  drawCurve();
}
// curva do EQ/filtro, como no FL: calculada pelos próprios filtros do navegador
let respCtx = null;
function drawCurve(){
  const cv = $('#rk-curve'); if(!cv) return;
  const f = chCfg(mixSel).fx[fxSel], p = {...fxDefaults(f.type), ...f.p};
  respCtx = respCtx || new OfflineAudioContext(1, 128, 44100);
  const mk = (type, fr, g, q) => { const b = respCtx.createBiquadFilter(); b.type = type; b.frequency.value = fr; if(g !== undefined) b.gain.value = g; if(q) b.Q.value = q; return b; };
  const filters = f.type === 'eq' ? [mk('lowshelf', 120, p.low), mk('peaking', p.midf, p.mid, 1), mk('highshelf', 8000, p.high)] : [mk(p.mode, p.freq, undefined, p.q)];
  const N = 300, fr = new Float32Array(N), mag = new Float32Array(N), ph = new Float32Array(N), tot = new Float32Array(N).fill(1);
  for(let i = 0; i < N; i++) fr[i] = 20 * Math.pow(1000, i / (N - 1));
  filters.forEach(b => { b.getFrequencyResponse(fr, mag, ph); for(let i = 0; i < N; i++) tot[i] *= mag[i]; });
  const x = cv.getContext('2d'), W = cv.width, H = cv.height, yOf = db => H / 2 - db / 24 * (H / 2 - 10);
  x.clearRect(0, 0, W, H);
  x.fillStyle = '#1b1d1f'; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(255,255,255,.08)'; x.lineWidth = 1; x.font = '18px JetBrains Mono, monospace'; x.fillStyle = 'rgba(255,255,255,.35)';
  for(const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]){ const px = Math.log(hz / 20) / Math.log(1000) * W; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, H); x.stroke(); x.fillText(hz >= 1000 ? hz / 1000 + 'k' : hz, px + 4, H - 8); }
  x.beginPath(); x.moveTo(0, H / 2); x.lineTo(W, H / 2); x.stroke();
  x.beginPath();
  for(let i = 0; i < N; i++){ const db = clamp(20 * Math.log10(tot[i] || 1e-6), -24, 24), px = i / (N - 1) * W; i ? x.lineTo(px, yOf(db)) : x.moveTo(px, yOf(db)); }
  x.strokeStyle = '#ffd21f'; x.lineWidth = 3; x.stroke();
  x.lineTo(W, H); x.lineTo(0, H); x.closePath(); x.fillStyle = 'rgba(255,210,31,.12)'; x.fill();
}
// medidores: pico com queda suave, verde → amarelo → vermelho
function drawMeters(){
  for(const cv of $$('#mx-strips .st-meter')){
    const b = actx && buses.get(cv.dataset.meter), x = cv.getContext('2d'), H = cv.height, W = cv.width;
    let lv = 0;
    if(b){ b.peak = Math.max(busLevel(b), b.peak * .9); lv = fpos(b.peak); if(lv >= (b.hold || 0)){ b.hold = lv; b.holdT = performance.now(); } else if(performance.now() - (b.holdT || 0) > 900) b.hold = Math.max(0, (b.hold || 0) - .012); }
    x.fillStyle = '#0d0f10'; x.fillRect(0, 0, W, H);
    const seg = 4, lit = lv * H;
    for(let y = H - seg; y >= 0; y -= seg){
      const pos = 1 - y / H, on = H - y <= lit;
      x.fillStyle = pos > fpos(1) ? (on ? '#ff5c5c' : '#3a1d1f') : pos > fpos(.5) ? (on ? '#e8d33a' : '#35331a') : (on ? '#3ddc84' : '#15301f');
      x.fillRect(2, y, W - 4, seg - 1);
    }
    if(b && b.hold > .02){ x.fillStyle = '#fff'; x.fillRect(2, H - b.hold * H, W - 4, 2); }
  }
}
$('#mx-x').addEventListener('click', () => gelClose($('#mixer')));
$('#t-mixer').addEventListener('click', () => openMixer());
$('#mx-strips').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'), st = e.target.closest('.mx-ch'); if(!st) return;
  const id = st.dataset.ch, cfg = chCfg(id);
  if(!b || b.dataset.act === 'sel'){ if(mixSel !== id){ mixSel = id; fxSel = 0; renderMixer(); } return; }
  if(b.dataset.act === 'mute') edit(() => { cfg.mute = !cfg.mute; });
  if(b.dataset.act === 'solo') edit(() => { cfg.solo = !cfg.solo; });
});
function setFader(fd, v){
  const st = fd.closest('.mx-ch'), cfg = chCfg(st.dataset.ch);
  live(() => { cfg.vol = v; }); syncMixer();
  fd.style.setProperty('--p', fpos(v)); fd.setAttribute('aria-valuenow', Math.round(v * 100));
  st.querySelector('.st-db').textContent = volDb(v);
}
$('#mx-strips').addEventListener('pointerdown', e => {
  const fd = e.target.closest('.fdr'); if(!fd) return;
  e.preventDefault(); capture(fd, e); fd.focus();
  const tr = fd.querySelector('.fdr-track').getBoundingClientRect();
  const go = ev => setFader(fd, fval(1 - (ev.clientY - tr.top) / tr.height));
  go(e);
  const up = () => { fd.removeEventListener('pointermove', go); fd.removeEventListener('pointerup', up); fd.classList.remove('drag'); liveEnd(); };
  fd.classList.add('drag');
  fd.addEventListener('pointermove', go); fd.addEventListener('pointerup', up);
});
$('#mx-strips').addEventListener('keydown', e => {
  const fd = e.target.closest('.fdr'); if(!fd || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  const cfg = chCfg(fd.closest('.mx-ch').dataset.ch);
  setFader(fd, fval(fpos(cfg.vol ?? 1) + (e.key === 'ArrowUp' ? .02 : -.02))); liveEnd();
});
$('#mx-strips').addEventListener('dblclick', e => {
  const k = e.target.closest('.knob'), f = e.target.closest('.fdr'), st = e.target.closest('.mx-ch'); if(!st) return;
  const cfg = chCfg(st.dataset.ch);
  if(k) edit(() => { cfg.pan = 0; });
  else if(f) edit(() => { cfg.vol = 1; });
});
// botão giratório do pan: arrastar para cima/baixo
$('#mx-strips').addEventListener('pointerdown', e => {
  const k = e.target.closest('.knob'); if(!k) return;
  e.preventDefault(); capture(k, e);
  const st = k.closest('.mx-ch'), cfg = chCfg(st.dataset.ch), y0 = e.clientY, p0 = cfg.pan || 0;
  const mv = ev => { const p = clamp(p0 - (ev.clientY - y0) / 100, -1, 1); live(() => { cfg.pan = Math.round(p * 100) / 100; }); syncMixer(); k.style.setProperty('--a', cfg.pan * 135 + 'deg'); st.querySelector('.knob-ring').style.background = panRing(cfg.pan); st.querySelector('.st-pan').textContent = panTxt(cfg.pan); };
  const up = () => { k.removeEventListener('pointermove', mv); k.removeEventListener('pointerup', up); liveEnd(); };
  k.addEventListener('pointermove', mv); k.addEventListener('pointerup', up);
});
$('#mx-rack').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const cfg = chCfg(mixSel), i = +b.closest('.slot').dataset.i, fx = cfg.fx;
  const a = b.dataset.act;
  if(a === 'fx-sel'){ fxSel = i; renderRack(); return; }
  edit(() => {
    if(a === 'fx-on') fx[i].on = !fx[i].on;
    if(a === 'fx-rm'){ fx.splice(i, 1); fxSel = Math.max(0, Math.min(fxSel, fx.length - 1)); }
    if(a === 'fx-up' && i > 0){ [fx[i - 1], fx[i]] = [fx[i], fx[i - 1]]; fxSel = i - 1; }
    if(a === 'fx-down' && i < fx.length - 1){ [fx[i + 1], fx[i]] = [fx[i], fx[i + 1]]; fxSel = i + 1; }
  });
});
$('#mx-rack').addEventListener('change', e => {
  if(e.target.id === 'rk-add' && e.target.value){
    const type = e.target.value, cfg = chCfg(mixSel);
    edit(() => { cfg.fx.push({id: uid(), type, on: true, p: fxDefaults(type)}); fxSel = cfg.fx.length - 1; });
    toast(`${FX[type].label} adicionado em ${channelName(mixSel)}`);
    return;
  }
  const k = e.target.dataset.p; if(!k) return;
  if(e.target.tagName === 'SELECT'){ const f = chCfg(mixSel).fx[fxSel]; edit(() => { f.p[k] = e.target.value; }); }
  else liveEnd();
});
$('#mx-rack').addEventListener('input', e => {
  const k = e.target.dataset.p; if(!k || e.target.tagName === 'SELECT') return;
  const f = chCfg(mixSel).fx[fxSel], d = FX[f.type].p[k];
  let v = +e.target.value;
  if(e.target.dataset.log){ const [a, b] = e.target.dataset.log.split(',').map(Number); v = Math.round(a * Math.pow(b / a, v / 1000)); }
  live(() => { f.p[k] = v; }); syncMixer(); drawCurve();
  const out = e.target.closest('.rk-p').querySelector('output');
  out.textContent = (Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)).toString().replace('.', ',') + (d[5] ? ' ' + d[5] : '');
});


/* ---------- projetos salvos no navegador (IndexedDB): timeline + arquivos, com salvamento automático ---------- */
let idbP = null;
const idb = () => idbP || (idbP = new Promise((res, rej) => {
  const r = indexedDB.open('webkit-editor', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('projects', {keyPath: 'id'}); d.createObjectStore('media', {keyPath: 'id'}).createIndex('pid', 'pid'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
async function dbRun(store, mode, fn){
  const d = await idb();
  return new Promise((res, rej) => { const tr = d.transaction(store, mode), req = fn(tr.objectStore(store)); tr.oncomplete = () => res(req?.result); tr.onerror = tr.onabort = () => rej(tr.error); });
}
const dbPut = (store, v) => dbRun(store, 'readwrite', s => s.put(v));
const dbGet = (store, k) => dbRun(store, 'readonly', s => s.get(k));
const dbAll = store => dbRun(store, 'readonly', s => s.getAll());
const dbMediaOf = pid => dbRun('media', 'readonly', s => s.index('pid').getAll(pid));
const dbDelMediaOf = pid => dbRun('media', 'readwrite', s => { const c = s.index('pid').openCursor(pid); c.onsuccess = () => { const k = c.result; if(k){ k.delete(); k.continue(); } }; return null; });
let PID = null, projCreated = 0, saveTimer = null, saveFailed = false, persistAsked = false;
function setSaveState(st){
  const el = $('#save-st'); if(!el) return;
  el.dataset.st = st;
  el.textContent = st === 'saving' ? 'Salvando…' : st === 'saved' ? 'Salvo' : st === 'error' ? 'Não salvou (sem espaço?)' : '';
  el.title = st === 'saved' ? 'O projeto fica guardado neste navegador. Abra de novo em "Projetos".' : '';
}
function saveMedia(m){
  if(!PID) return;
  dbPut('media', {id: m.id, pid: PID, name: m.name, kind: kindOf(m.file) || m.kind, file: m.file, type: m.file.type, credit: m.credit, sticker: m.sticker})
    .catch(() => { saveFailed = true; setSaveState('error'); });
}
// o projeto só passa a existir quando entra o primeiro arquivo ou clipe
function ensureProject(){
  if(PID) return;
  PID = 'p' + uid(); projCreated = Date.now();
  for(const m of media.values()) saveMedia(m);
  if(!persistAsked && navigator.storage?.persist){ persistAsked = true; navigator.storage.persist().catch(() => {}); }
}
function markDirty(){
  if(!PID){ if(!S.clips.length && !media.size) return; ensureProject(); }
  setSaveState('saving');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 700);
}
function projectThumb(){
  try{ const c = document.createElement('canvas'); c.width = 240; c.height = 135; const x = c.getContext('2d'); x.fillStyle = '#111'; x.fillRect(0, 0, 240, 135);
    const k = Math.min(240 / screen.width, 135 / screen.height); x.drawImage(screen, (240 - screen.width * k) / 2, (135 - screen.height * k) / 2, screen.width * k, screen.height * k);
    return c.toDataURL('image/jpeg', .6); }catch{ return null; }
}
async function saveProject(){
  saveTimer = null;
  if(!PID) return;
  try{
    await dbPut('projects', {id: PID, name: $('#proj-name').value.trim() || 'Meu vídeo', created: projCreated, updated: Date.now(), S: JSON.parse(snap()), duration: L().total, clips: S.clips.length, thumb: projectThumb()});
    saveFailed = false; setSaveState('saved');
  }catch{ saveFailed = true; setSaveState('error'); }
}
// limpa o editor (antes de abrir outro projeto ou começar um novo)
function resetEditor(){
  if(playing) pause();
  for(const o of els.values()){ o.el.pause(); o.el.removeAttribute('src'); o.el.load(); try{ o.node?.disconnect(); }catch{} }
  els.clear();
  for(const m of media.values()){ URL.revokeObjectURL(m.url); m.thumbs.forEach(x => URL.revokeObjectURL(x.url)); if(m.wave) URL.revokeObjectURL(m.wave); }
  media.clear();
  S = {clips: [], ratio: '16:9', ratioAuto: true, bg: '#000000', tracks: [{id: 'a1', kind: 'audio'}], main: {}, master: {vol: 1, fx: []}};
  normalize(); hist.past = []; hist.future = []; sel = null; selSet = new Set(); t = 0; autoFit = true;
  clearTimeout(saveTimer); saveTimer = null; PID = null; saveFailed = false;
}
async function openProject(id){
  const rec = await dbGet('projects', id); if(!rec) return;
  const meds = await dbMediaOf(id);
  resetEditor();
  PID = id; projCreated = rec.created || Date.now();
  $('#proj-name').value = rec.name || 'Meu vídeo';
  for(const r of meds){
    const f = r.file instanceof File ? r.file : new File([r.file], r.name, {type: r.type || ''});
    const m = {id: r.id, file: f, name: r.name, kind: r.kind, url: URL.createObjectURL(f), duration: 0, w: 0, h: 0, thumbs: [], status: 'loading', credit: r.credit || null, sticker: !!r.sticker};
    media.set(m.id, m); probe(m);
  }
  S = rec.S; normalize();
  renderMedia(); changed(); sizeScreen(); zoomFit(); setSaveState('saved');
  try{ localStorage.setItem('ed-last', id); }catch{}
  toast(`"${rec.name}" aberto`);
}
function newProject(){
  resetEditor(); $('#proj-name').value = 'Meu vídeo';
  renderMedia(); changed(); sizeScreen(); setSaveState('');
}
const ago = ts => { const s = (Date.now() - ts) / 1000; return s < 60 ? 'agora' : s < 3600 ? `há ${Math.round(s / 60)} min` : s < 86400 ? `há ${Math.round(s / 3600)} h` : `há ${Math.round(s / 86400)} dia${s >= 172800 ? 's' : ''}`; };
async function renderProjects(){
  let list = [];
  try{ list = (await dbAll('projects')).sort((a, b) => b.updated - a.updated); }catch{}
  const est = await navigator.storage?.estimate?.().catch(() => null);
  $('#proj-list').innerHTML = list.length ? list.map(p => `<li class="pj${p.id === PID ? ' cur' : ''}" data-pid="${p.id}">
      <button class="pj-open" type="button" data-act="open" title="Abrir ${esc(p.name)}">${p.thumb ? `<img src="${p.thumb}" alt="">` : '<span class="pj-ph"></span>'}</button>
      <div class="pj-info"><b>${esc(p.name)}</b><span>${fmtTime(p.duration || 0, false)} · ${p.clips || 0} clipe${p.clips === 1 ? '' : 's'} · editado ${ago(p.updated)}</span></div>
      <button class="pj-del" type="button" data-act="del" title="Excluir projeto" aria-label="Excluir ${esc(p.name)}"><svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9"/></svg></button>
    </li>`).join('') : '<li class="pj-empty">Nenhum projeto salvo ainda. Tudo o que você fizer no editor é salvo sozinho aqui.</li>';
  $('#proj-foot').textContent = est ? `Espaço usado pelo site neste navegador: ${(est.usage / 1048576).toFixed(0)} MB de ${(est.quota / 1073741824).toFixed(0)} GB` : '';
  return list;
}
async function openProjects(){ await renderProjects(); gelOpen($('#proj-dlg')); }
$('#proj-btn').addEventListener('click', openProjects);
$('#proj-x').addEventListener('click', () => gelClose($('#proj-dlg')));
$('#proj-new').addEventListener('click', () => { if(saveTimer) saveProject(); newProject(); gelClose($('#proj-dlg')); toast('Projeto novo'); });
$('#proj-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'), li = e.target.closest('.pj'); if(!li) return;
  const id = li.dataset.pid;
  if(!b || b.dataset.act === 'open'){ if(saveTimer) await saveProject(); await openProject(id); gelClose($('#proj-dlg')); return; }
  const rec = await dbGet('projects', id);
  if(!confirm(`Excluir "${rec?.name || 'projeto'}" e os arquivos dele deste navegador?`)) return;
  await dbRun('projects', 'readwrite', s => s.delete(id)); await dbDelMediaOf(id);
  if(id === PID){ newProject(); }
  renderProjects();
});
$('#proj-name').addEventListener('input', () => markDirty());


/* ---------- exportação rápida: quadro a quadro com WebCodecs, áudio mixado offline, MP4 com mp4-muxer ---------- */
const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm';
// o navegador freia timers em abas de fundo; mensagens e eventos do codificador não. Por isso nada aqui depende de setTimeout.
const yieldNow = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
const onDequeue = codec => 'ondequeue' in codec ? new Promise(r => codec.addEventListener('dequeue', r, {once: true})) : sleep(2);
async function fastSupport(w, h){
  if(typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof VideoFrame === 'undefined' || typeof OfflineAudioContext === 'undefined') return null;
  for(const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.640033', 'avc1.42001f']){
    try{
      if(!(await VideoEncoder.isConfigSupported({codec, width: w, height: h, bitrate: 8e6, framerate: FPS})).supported) continue;
      let ac = null;
      for(const a of [['mp4a.40.2', 'aac'], ['opus', 'opus']]){
        try{ if((await AudioEncoder.isConfigSupported({codec: a[0], sampleRate: 48000, numberOfChannels: 2, bitrate: 192000})).supported){ ac = a; break; } }catch{}
      }
      return {vcodec: codec, acodec: ac};
    }catch{}
  }
  return null;
}
// volume de um clipe num instante: fades + cruzamento das transições da trilha principal
function gainAt(e, tt){
  const c = e.c, lt = tt - e.start, d = cutEnd(e) - e.start;
  let f = 1;
  if(c.fi > 0) f = Math.min(f, lt / c.fi);
  if(c.fo > 0) f = Math.min(f, (d - lt) / c.fo);
  f = clamp(f, 0, 1);
  if(c.track === 'v'){
    const v = L().v, i = v.indexOf(e), nx = v[i + 1];
    if(e.td > 0 && tt < e.start + e.td) f *= clamp((tt - e.start) / e.td, 0, 1);
    if(nx && nx.td > 0 && tt > nx.start) f *= 1 - clamp((tt - nx.start) / nx.td, 0, 1);
  }
  return f;
}
// o som inteiro do vídeo, com o mesmo mixer (canais, efeitos, volume, pan, mudo, solo), sem tocar nada
async function renderAudioOffline(total){
  const rate = 48000, oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * rate)), rate);
  const ids = channelIds(), anySolo = ids.some(id => id !== 'master' && chCfg(id)?.solo), made = {};
  const mkBus = id => {
    const cfg = chCfg(id), input = oc.createGain(); let prev = input;
    for(const f of (cfg.fx || []).filter(f => f.on && FX[f.type])){ const n = makeFx(f, oc); n.set({...fxDefaults(f.type), ...f.p}); prev.connect(n.input); prev = n.output; }
    const fader = oc.createGain(), muted = id !== 'master' && (cfg.mute || (anySolo && !cfg.solo));
    fader.gain.value = muted ? 0 : (cfg.vol ?? 1); prev.connect(fader);
    let out = fader;
    if(id !== 'master' && oc.createStereoPanner){ const p = oc.createStereoPanner(); p.pan.value = cfg.pan || 0; fader.connect(p); out = p; }
    return {input, out};
  };
  made.master = mkBus('master'); made.master.out.connect(oc.destination);
  const busOf = id => { if(!chCfg(id)) id = 'v'; if(!made[id]){ made[id] = mkBus(id); made[id].out.connect(made.master.input); } return made[id]; };
  const l = L(), entries = [...l.v, ...l.a, ...l.o].filter(e => hasSound(e.c) && !e.c.muted && e.start < total);
  const dec = new Map();
  for(const e of entries){
    const m = media.get(e.c.mid);
    if(!dec.has(m.id)){ try{ dec.set(m.id, await oc.decodeAudioData(await m.file.arrayBuffer())); }catch{ dec.set(m.id, null); } }
  }
  let any = false;
  for(const e of entries){
    const c = e.c, buf = dec.get(c.mid); if(!buf) continue;
    const end = Math.min(e.end, total), dur = end - e.start; if(dur <= .01) continue;
    const src = oc.createBufferSource(), g = oc.createGain();
    src.buffer = buf; src.playbackRate.value = c.speed;
    const N = Math.max(2, Math.ceil(dur * 100)), curve = new Float32Array(N);
    for(let i = 0; i < N; i++) curve[i] = c.volume * gainAt(e, e.start + dur * i / (N - 1));
    g.gain.setValueCurveAtTime(curve, e.start, dur);
    src.connect(g).connect(busOf(c.track).input);
    src.start(e.start, c.in, Math.max(.01, c.out - c.in));
    any = true;
  }
  return any ? oc.startRendering() : null;
}
// deixa cada vídeo visível exatamente no quadro do instante t e espera o navegador decodificar
async function seekExact(){
  const need = [];
  const put = e => {
    if(EXP.fast && EXP.ov?.has(e.c.id)) return;
    const o = getEl(e.c); if(!o) return;
    const el = o.el, want = clamp(e.c.in + (t - e.start) * e.c.speed, 0, Math.max(0, (media.get(e.c.mid)?.duration || 0) - .01));
    if(!el.paused) el.pause();
    if(Math.abs(el.currentTime - want) > 1e-3){ el.currentTime = want; need.push(el); }
    else if(el.readyState < 2 || el.seeking) need.push(el);
  };
  if(!S.main.hidden) activeV().forEach(put);
  activeO().filter(e => !isHidden(e.c.track)).forEach(put);
  await Promise.all(need.map(el => new Promise(res => {
    if(!el.seeking && el.readyState >= 2) return res();
    const done = () => { el.removeEventListener('seeked', done); el.removeEventListener('loadeddata', done); clearTimeout(tm); res(); };
    el.addEventListener('seeked', done); el.addEventListener('loadeddata', done);
    const tm = setTimeout(done, 4000);
  })));
}

// MP4/MOV: em vez de pular de quadro em quadro (lento), lê o arquivo com o mp4box e decodifica em sequência com o WebCodecs
const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.3/+esm';
const demuxCache = new Map();   // arquivo -> dados do vídeo (amostras, codec, giro)
const isMp4 = m => /mp4|quicktime|m4v/.test(m.file.type) || /\.(mp4|mov|m4v)$/i.test(m.file.name || '');
async function demuxMp4(m){
  if(demuxCache.has(m.id)) return demuxCache.get(m.id);
  const p = (async () => {
    const mod = await import(MP4BOX_URL), M = mod.createFile ? mod : mod.default;
    const file = M.createFile(), samples = [];
    let track = null;
    await new Promise(async (res, rej) => {
      file.onError = rej;
      file.onReady = info => { track = info.videoTracks[0]; if(!track) return rej(new Error('sem vídeo')); file.setExtractionOptions(track.id, null, {nbSamples: 1e9}); file.start(); };
      file.onSamples = (id, u, s) => { for(const x of s) samples.push({ts: x.cts / x.timescale, dur: x.duration / x.timescale, key: x.is_sync, data: x.data}); };
      const buf = await m.file.arrayBuffer(); buf.fileStart = 0; file.appendBuffer(buf); file.flush();
      setTimeout(res, 0);
    });
    if(!track || !samples.length) throw new Error('sem amostras');
    const entry = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0], box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    let description;
    if(box){ const ds = new M.DataStream(undefined, 0, M.DataStream.BIG_ENDIAN); box.write(ds); description = new Uint8Array(ds.buffer, 8); }
    const cfg = {codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description};
    if(!(await VideoDecoder.isConfigSupported(cfg)).supported) throw new Error('codec não suportado');
    // giro gravado no arquivo (vídeo em pé de celular)
    const mt = track.matrix || [65536, 0], rot = ((Math.round(Math.atan2(mt[1], mt[0]) * 180 / Math.PI) % 360) + 360) % 360;
    return {cfg, samples, rot};
  })();
  demuxCache.set(m.id, p);
  p.catch(() => demuxCache.delete(m.id));
  return p;
}
// uma fonte de quadros por clipe: decodifica pra frente e devolve o quadro de cada instante pedido
class DecSource {
  constructor(d){ this.d = d; this.q = []; this.next = 0; this.done = false; this.wake = null; this.err = null; this.rc = null; }
  start(fromT){
    const S_ = this.d.samples;
    // começa no quadro-chave antes do ponto de entrada
    let i = S_.findIndex(s => s.ts > fromT + 1e-3); if(i < 0) i = S_.length;
    let k = Math.max(0, i - 1); while(k > 0 && !S_[k].key) k--;
    this.next = k;
    this.dec = new VideoDecoder({output: f => { this.q.push(f); this.q.sort((a, b) => a.timestamp - b.timestamp); this.wake?.(); }, error: e => { this.err = e; this.wake?.(); }});
    this.dec.configure(this.d.cfg);
  }
  // espera um quadro sair do decodificador (ou 15 ms)
  pause(){ return new Promise(r => { this.wake = r; if('ondequeue' in this.dec) this.dec.addEventListener('dequeue', () => r(), {once: true}); setTimeout(r, 15); }); }
  async frameAt(want){
    const S_ = this.d.samples, us = want * 1e6 + 1000;
    for(let guard = 0; guard < 4000 && !EXP.cancelled; guard++){
      if(this.err) throw this.err;
      // libera os quadros que já passaram: o decodificador só trabalha com poucos quadros em memória
      while(this.q.length >= 2 && this.q[1].timestamp <= us) this.q.shift().close();
      const last = this.q[this.q.length - 1];
      if(last && (last.timestamp > us || this.done)) return this.q[0];
      if(this.done) return this.q[0] || null;
      if(this.next >= S_.length){
        // fim do arquivo: pede o resto sem travar (os quadros continuam sendo liberados enquanto isso)
        if(!this.flushing) this.flushing = this.dec.flush().catch(() => {}).then(() => { this.done = true; this.wake?.(); });
        await this.pause(); continue;
      }
      // manda pouco por vez: só o suficiente para chegar no instante pedido
      let fed = 0;
      while(this.dec.decodeQueueSize < 4 && this.q.length < 6 && this.next < S_.length){
        const s = S_[this.next++];
        this.dec.decode(new EncodedVideoChunk({type: s.key ? 'key' : 'delta', timestamp: Math.round(s.ts * 1e6), duration: Math.round(s.dur * 1e6), data: s.data}));
        fed++;
      }
      if(!fed || this.dec.decodeQueueSize >= 4) await this.pause();
    }
    return this.q[0] || null;
  }
  // quadro pronto para desenhar (com o giro do celular aplicado)
  image(f){
    if(!f) return null;
    const rot = this.d.rot, w = f.displayWidth, h = f.displayHeight;
    if(!rot) return {src: f, w, h};
    const odd = rot % 180, cw = odd ? h : w, ch = odd ? w : h;
    if(!this.rc || this.rc.width !== cw || this.rc.height !== ch){ this.rc = new OffscreenCanvas(cw, ch); this.rx = this.rc.getContext('2d'); }
    this.rx.save(); this.rx.translate(cw / 2, ch / 2); this.rx.rotate(rot * Math.PI / 180); this.rx.drawImage(f, -w / 2, -h / 2); this.rx.restore();
    return {src: this.rc, w: cw, h: ch};
  }
  close(){ this.q.forEach(f => f.close()); this.q = []; try{ this.dec?.close(); }catch{} }
}
// prepara os quadros de todos os vídeos visíveis no instante t (MP4 pelo decodificador; o resto pelo tocador)
async function framesAt(){
  const now = [...(S.main.hidden ? [] : activeV()), ...activeO().filter(e => !isHidden(e.c.track))];
  const live = new Set();
  for(const e of now){
    const m = media.get(e.c.mid); if(!m || m.kind !== 'video') continue;
    const want = clamp(e.c.in + (t - e.start) * e.c.speed, 0, Math.max(0, m.duration - .01));
    let src = EXP.srcs.get(e.c.id);
    if(src === undefined && isMp4(m)){
      try{ const d = await demuxMp4(m); src = new DecSource(d); src.start(want); }catch{ src = null; }
      EXP.srcs.set(e.c.id, src);
    }
    if(src){ live.add(e.c.id); try{ EXP.ov.set(e.c.id, src.image(await src.frameAt(want))); }catch{ src.close(); EXP.srcs.set(e.c.id, null); EXP.ov.delete(e.c.id); } }
  }
  // clipes que já passaram: libera o decodificador
  for(const [id, src] of EXP.srcs) if(src && !live.has(id) && !now.some(e => e.c.id === id)){ src.close(); EXP.srcs.set(id, null); EXP.ov.delete(id); }
  await seekExact();
}

async function fastExport(){
  const {w, h} = expSize(EXP.res), sup = await fastSupport(w, h); if(!sup) return false;
  const {Muxer, ArrayBufferTarget} = await import(MUXER_URL);
  const total = L().total, frames = Math.max(1, Math.round(total * FPS));
  pause(); ensureAudio();
  await Promise.all(S.clips.filter(c => c.text).map(c => document.fonts.load(txtFont(c.text, 40)).catch(() => {})));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  Object.assign(EXP, {on: true, fast: true, cancelled: false, total, cv, cx: cv.getContext('2d'), blob: null, mime: 'video/mp4', srcs: new Map(), ov: new Map()});
  showExp('run'); updateFast(0, frames, 'Mixando o som…');
  const t0 = performance.now();
  let abuf = null;
  // se a mixagem falhar, melhor cair no tempo real do que entregar um vídeo mudo
  if(sup.acodec) abuf = await renderAudioOffline(total);
  else if(S.clips.some(c => hasSound(c) && !c.muted)) throw new Error('sem codificador de áudio');
  const muxer = new Muxer({target: new ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: {codec: 'avc', width: w, height: h, frameRate: FPS},
    audio: abuf ? {codec: sup.acodec[1], numberOfChannels: 2, sampleRate: 48000} : undefined});
  let failed = null;
  const venc = new VideoEncoder({output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: err => { failed = err; }});
  venc.configure({codec: sup.vcodec, width: w, height: h, bitrate: EXP.res >= 1080 ? 10e6 : 5e6, framerate: FPS});
  for(let i = 0; i < frames && !EXP.cancelled && !failed; i++){
    t = i / FPS;
    await framesAt();
    let ok = render(EXP.cx, w, h);
    for(let k = 0; !ok && k < 200; k++){ await yieldNow(); ok = render(EXP.cx, w, h); }
    const vf = new VideoFrame(cv, {timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS)});
    venc.encode(vf, {keyFrame: i % (FPS * 2) === 0}); vf.close();
    while(venc.encodeQueueSize > 6) await onDequeue(venc);
    if(i % 4 === 0){ dirty = true; updateFast(i, frames, null, t0); await yieldNow(); }
  }
  if(!EXP.cancelled && !failed){ updateFast(frames, frames, 'Finalizando o arquivo…'); await venc.flush(); }
  try{ venc.close(); }catch{}
  if(abuf && !EXP.cancelled && !failed){
    const aenc = new AudioEncoder({output: (ch, meta) => muxer.addAudioChunk(ch, meta), error: err => { failed = err; }});
    aenc.configure({codec: sup.acodec[0], sampleRate: 48000, numberOfChannels: 2, bitrate: 192000});
    const L0 = abuf.getChannelData(0), R0 = abuf.numberOfChannels > 1 ? abuf.getChannelData(1) : L0, CH = 1024;
    for(let o = 0; o < abuf.length && !failed; o += CH){
      const n = Math.min(CH, abuf.length - o), data = new Float32Array(n * 2);
      data.set(L0.subarray(o, o + n), 0); data.set(R0.subarray(o, o + n), n);
      const ad = new AudioData({format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(o * 1e6 / 48000), data});
      aenc.encode(ad); ad.close();
      if(aenc.encodeQueueSize > 50) await onDequeue(aenc);
    }
    await aenc.flush(); try{ aenc.close(); }catch{}
  }
  for(const src of EXP.srcs.values()) src?.close();
  EXP.srcs.clear(); EXP.ov.clear();
  EXP.on = false; EXP.fast = false;
  t = 0; syncMedia(true); dirty = true; updateTime(); placePlayhead();
  if(failed){ console.warn(failed); throw failed; }
  if(EXP.cancelled){ toast('Exportação cancelada'); showExp('setup'); renderExpSetup(); return true; }
  muxer.finalize();
  EXP.blob = new Blob([muxer.target.buffer], {type: 'video/mp4'});
  EXP.file = `${slug($('#proj-name').value) || 'video'}.mp4`;
  EXP.took = (performance.now() - t0) / 1000;
  save(EXP.blob, EXP.file);
  $('#exp-file').textContent = `${EXP.file} · ${(EXP.blob.size / 1048576).toFixed(1).replace('.', ',')} MB · pronto em ${EXP.took.toFixed(1).replace('.', ',')} s`;
  const cr = creditsText();
  $('#exp-credits').hidden = !cr; $('#credits-txt').value = cr;
  showExp('done');
  return true;
}
function updateFast(i, n, msg, t0){
  const pct = n ? i / n : 0;
  $('#exp-bar').style.width = (pct * 100).toFixed(1) + '%';
  $('#exp-pct').textContent = Math.floor(pct * 100) + '%';
  $('#exp-time').textContent = `quadro ${i} de ${n}`;
  if(msg) $('#exp-msg').textContent = msg;
  else if(t0){ const el = (performance.now() - t0) / 1000, speed = el > 0 ? (i / FPS) / el : 0; $('#exp-msg').textContent = `Modo rápido: ${speed >= 1 ? speed.toFixed(1).replace('.', ',') + '× mais rápido que o tempo real' : 'gerando quadro a quadro'}. Pode trocar de aba.`; }
}

/* ---------- exportar ---------- */
const EXP = {on: false, res: 1080};
function pickMime(){
  if(!window.MediaRecorder) return null;
  return ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || null;
}
function expSize(short){ const r = RATIOS[S.ratio]; return r >= 1 ? {w: Math.round(short * r / 2) * 2, h: short} : {w: short, h: Math.round(short / r / 2) * 2}; }
function renderExpSetup(){
  $$('#exp-res button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.v === EXP.res)));
  const mime = pickMime(), {w, h} = expSize(EXP.res);
  $('#exp-info').innerHTML = `<span>Tamanho</span><b>${w} × ${h}</b><span>Duração</span><b>${fmtTime(L().total)}</b><span>Arquivo</span><b>${mime ? (mime.startsWith('video/mp4') ? 'MP4' : 'WebM') : 'não suportado'}</b>`;
  $('#exp-go').disabled = !mime;
  const hint = $('#exp-setup .hint');
  fastSupport(w, h).then(sup => {
    EXP.realtime = !sup;
    $('#exp-info').insertAdjacentHTML('beforeend', `<span>Modo</span><b>${sup ? 'Rápido (quadro a quadro)' : 'Tempo real'}</b>`);
    if(sup) $('#exp-go').disabled = false;
    hint.textContent = sup ? 'Modo rápido: o vídeo é gerado quadro a quadro, sem precisar tocar. Normalmente fica pronto bem antes da duração do vídeo, e dá para trocar de aba.'
      : 'Este navegador não tem o modo rápido: o vídeo é gerado em tempo real, tocando do começo ao fim. Deixe esta aba aberta e visível até terminar.';
  });
}
function showExp(step){ ['setup', 'run', 'done'].forEach(s => { $('#exp-' + s).hidden = s !== step; }); }
$('#export-btn').addEventListener('click', () => { pause(); closeTrPop(); showExp('setup'); renderExpSetup(); gelOpen($('#exp-dlg')); });
$('#exp-res').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if(b){ EXP.res = +b.dataset.v; renderExpSetup(); } });
$('#exp-cancel').addEventListener('click', () => gelClose($('#exp-dlg')));
$('#exp-x').addEventListener('click', () => { if(EXP.on) stopExport(true); gelClose($('#exp-dlg')); });
$('#exp-close').addEventListener('click', () => gelClose($('#exp-dlg')));
$('#exp-stop').addEventListener('click', () => { stopExport(true); showExp('setup'); renderExpSetup(); });
$('#exp-dl').addEventListener('click', () => { if(EXP.blob) save(EXP.blob, EXP.file); });
$('#exp-go').addEventListener('click', startExport);
$('#credits-copy').addEventListener('click', async () => { try{ await navigator.clipboard.writeText($('#credits-txt').value); toast('Créditos copiados'); }catch{ $('#credits-txt').select(); } });
async function startExport(){
  if(!EXP.realtime){
    try{ if(await fastExport()) return; }
    catch(err){ console.warn(err); for(const src of EXP.srcs?.values() || []) src?.close(); EXP.srcs?.clear(); EXP.ov?.clear(); EXP.on = false; EXP.fast = false; toast('O modo rápido falhou aqui; gerando em tempo real'); }
  }
  const mime = pickMime(); if(!mime) return;
  pause(); ensureAudio();
  await Promise.all(S.clips.filter(c => c.text).map(c => document.fonts.load(txtFont(c.text, 40)).catch(() => {})));
  const {w, h} = expSize(EXP.res);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const stream = cv.captureStream(FPS);
  let dest = null;
  if(actx){ dest = actx.createMediaStreamDestination(); master.disconnect(); master.connect(dest); dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr)); }
  let rec;
  try{ rec = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: EXP.res >= 1080 ? 12e6 : 6e6, audioBitsPerSecond: 192000}); }
  catch{ toast('Não consegui iniciar a gravação neste navegador'); restoreAudio(); return; }
  Object.assign(EXP, {on: true, cv, cx: cv.getContext('2d'), rec, chunks: [], mime, dest, cancelled: false, total: L().total, blob: null});
  rec.ondataavailable = e => { if(e.data.size) EXP.chunks.push(e.data); };
  rec.onstop = onRecStop;
  showExp('run'); updateExp();
  seek(0);
  // espera o primeiro quadro carregar antes de gravar
  for(let i = 0; i < 60 && EXP.on && !render(EXP.cx, w, h); i++) await sleep(100);
  if(!EXP.on) return;
  rec.start(500);
  play();
}
function expTick(hold){
  const r = EXP.rec; if(!r || EXP.fast) return;
  if(hold && r.state === 'recording') r.pause();
  else if(!hold && r.state === 'paused') r.resume();
  updateExp();
}
function updateExp(){
  const pct = EXP.total ? clamp(t / EXP.total, 0, 1) : 0;
  $('#exp-bar').style.width = (pct * 100).toFixed(1) + '%';
  $('#exp-pct').textContent = Math.floor(pct * 100) + '%';
  $('#exp-time').textContent = `${fmtTime(t, false)} de ${fmtTime(EXP.total, false)}`;
  $('#exp-msg').textContent = document.hidden ? 'Pausado: volte para esta aba para continuar.' : buffering ? 'Carregando o próximo trecho…' : 'Gerando… deixe esta aba aberta.';
}
function finishExport(){ if(!EXP.on) return; EXP.on = false; updateExp(); setTimeout(() => { if(EXP.rec && EXP.rec.state !== 'inactive') EXP.rec.stop(); }, 150); }
function stopExport(cancel){
  if(EXP.fast){ EXP.cancelled = true; return; }
  if(!EXP.rec) return;
  EXP.cancelled = cancel; EXP.on = false;
  pause();
  if(EXP.rec.state !== 'inactive') EXP.rec.stop();
}
function restoreAudio(){ if(actx && master){ try{ master.disconnect(); }catch{} master.connect(actx.destination); } }
function onRecStop(){
  restoreAudio();
  const r = EXP; r.rec = null;
  if(r.cancelled){ toast('Exportação cancelada'); return; }
  const type = r.mime.split(';')[0], ext = type === 'video/mp4' ? 'mp4' : 'webm';
  r.blob = new Blob(r.chunks, {type}); r.chunks = [];
  r.file = `${slug($('#proj-name').value) || 'video'}.${ext}`;
  save(r.blob, r.file);
  $('#exp-file').textContent = `${r.file} · ${(r.blob.size / 1048576).toFixed(1).replace('.', ',')} MB`;
  const cr = creditsText();
  $('#exp-credits').hidden = !cr; $('#credits-txt').value = cr;
  showExp('done');
}
function save(blob, name){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
document.addEventListener('visibilitychange', () => { if(EXP.on && !EXP.fast) updateExp(); });

/* ---------- tema e saída ---------- */
const themeBtn = $('#theme');
function syncThemeBtn(){ const dark = document.documentElement.dataset.theme === 'dark'; const l = dark ? 'Ativar modo claro' : 'Ativar modo escuro'; themeBtn.setAttribute('aria-label', l); themeBtn.title = l; }
themeBtn.addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try{ localStorage.setItem('rx-theme', next); }catch{} syncThemeBtn(); });
syncThemeBtn();
window.addEventListener('beforeunload', e => { if(saveTimer) saveProject(); if(EXP.on || (saveFailed && S.clips.length)){ e.preventDefault(); e.returnValue = ''; } });

/* ---------- início ---------- */
renderMedia(); renderProps(); sizeScreen(); setPps(60); updateUi();
dbAll('projects').then(l => { if(l.length) openProjects(); }).catch(() => {});
