// Editor de vídeo no navegador, organizado como o OpenCut: biblioteca, preview, propriedades e timeline.
// Trilhas: camadas de sobreposição (livres) > vídeo principal (magnético, com transições) > áudio (livre).
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
let S = {clips: [], ratio: '16:9', ratioAuto: true, bg: '#000000', layers: 1};   // o que o desfazer guarda
let sel = null, t = 0, playing = false, pps = 60, snapOn = true, dirty = true, layoutCache = null;
const hist = {past: [], future: []};
const RATIOS = {'16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5};
const TRS = [
  {id: 'fade', label: 'Dissolver'}, {id: 'black', label: 'Preto'}, {id: 'white', label: 'Flash'}, {id: 'slide', label: 'Deslizar'},
  {id: 'up', label: 'Subir'}, {id: 'zoom', label: 'Zoom'}, {id: 'wipe', label: 'Cortina'}, {id: 'circle', label: 'Círculo'},
];
const TR = Object.fromEntries(TRS.map(x => [x.id, x]));
const TRD = {type: 'fade', d: .6};   // última transição escolhida e duração padrão

const clipDur = c => (c.out - c.in) / c.speed;
const clipById = id => S.clips.find(c => c.id === id);
// posições: vídeo em sequência (a transição puxa o clipe seguinte para cima do anterior); áudio e camadas onde foram colocados
function layout(){
  let x = 0, prev = null; const v = [];
  for(const c of S.clips) if(c.track === 'v'){
    const d = clipDur(c);
    const td = prev && c.tr && TR[c.tr.type] ? Math.max(0, Math.min(c.tr.d, prev.end - prev.start - .1, d - .1)) : 0;
    const e = {c, start: x - td, end: x - td + d, td};
    v.push(e); x = e.end; prev = e;
  }
  const free = k => S.clips.filter(c => c.track === k).map(c => ({c, start: c.start, end: c.start + clipDur(c)}));
  const a = free('a'), o = free('o');
  // o vídeo termina onde acaba a imagem; música mais longa é cortada no fim (só áudio: vale o áudio)
  const vis = Math.max(x, ...o.map(e => e.end), 0), aEnd = Math.max(0, ...a.map(e => e.end));
  return {v, a, o, vEnd: x, total: vis || aEnd, end: Math.max(vis, aEnd)};
}
const L = () => layoutCache || (layoutCache = layout());
const entryOf = c => { const l = L(); return l.v.find(e => e.c === c) || l.a.find(e => e.c === c) || l.o.find(e => e.c === c); };

/* ---------- desfazer / refazer ---------- */
const snap = () => JSON.stringify(S);
function pushHist(before){ hist.past.push(before); if(hist.past.length > 120) hist.past.shift(); hist.future = []; }
function edit(fn){ const before = snap(); fn(); if(snap() !== before) pushHist(before); changed(); }
function undo(){ if(!hist.past.length) return; hist.future.push(snap()); S = JSON.parse(hist.past.pop()); afterRestore(); }
function redo(){ if(!hist.future.length) return; hist.past.push(snap()); S = JSON.parse(hist.future.pop()); afterRestore(); }
function afterRestore(){ if(sel && !clipById(sel)) sel = null; changed(); sizeScreen(); }
// mudanças contínuas (controle deslizante, arrastar no preview): guarda o "antes" uma vez e registra ao soltar
let liveBefore = null;
function live(fn){ if(liveBefore === null) liveBefore = snap(); fn(); layoutCache = null; dirty = true; }
function liveEnd(){ if(liveBefore !== null && liveBefore !== snap()) pushHist(liveBefore); liveBefore = null; changed(); }

function changed(){
  layoutCache = null;
  S.layers = Math.max(1, S.layers || 1, ...S.clips.filter(c => c.track === 'o').map(c => c.layer + 1));
  t = clamp(t, 0, L().total);
  renderTimeline(); renderProps(); updateUi();
  syncMedia(!playing); dirty = true;
  pruneEls();
}
function select(id){ sel = id; closeTrPop(); renderTimeline(); renderProps(); updateUi(); dirty = true; }

/* ---------- importar arquivos ---------- */
const ICON = {
  video: '<svg viewBox="0 0 16 16"><rect x="1.8" y="3" width="12.4" height="10" rx="1.8"/><path d="M6.8 6v4l3.2-2z"/></svg>',
  image: '<svg viewBox="0 0 16 16"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><circle cx="5.5" cy="6.3" r="1.1"/><path d="M2.5 12l3.4-3 2.6 2.1 1.8-1.4 3.2 2.6"/></svg>',
  audio: '<svg viewBox="0 0 16 16"><path d="M6 12V3.5l7-1.5v8.5"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10.5" r="1.8"/></svg>',
  layer: '<svg viewBox="0 0 16 16"><path d="M8 2 1.5 5.5 8 9l6.5-3.5z"/><path d="M1.5 8.5 8 12l6.5-3.5"/></svg>',
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

// camada livre no trecho (começa na preferida; se todas estiverem ocupadas, cria outra)
function freeLayer(start, end, pref = 0, except = null){
  const busy = l => S.clips.some(x => x.track === 'o' && x !== except && x.layer === l && x.start < end - 1e-3 && x.start + clipDur(x) > start + 1e-3);
  for(let l = pref; l < S.layers; l++) if(!busy(l)) return l;
  return S.layers++;
}
const defaultTf = m => ({x: .5, y: .5, s: m.sticker ? .22 : .42, r: 0, op: 1});
// coloca na timeline: vídeo/foto na trilha principal (ou numa camada, com track:'o'); áudio na trilha de áudio
function addToTimeline(m, opt = {}){
  const k = m.kind === 'audio' ? 'a' : opt.track === 'o' ? 'o' : 'v';
  const c = {id: uid(), mid: m.id, track: k, in: 0, out: m.sticker ? 4 : m.duration, speed: 1, volume: 1, muted: false, fit: 'contain'};
  const wasEmpty = !S.clips.length;
  edit(() => {
    if(k === 'v'){
      const vs = S.clips.filter(x => x.track === 'v'), i = opt.index ?? vs.length;
      if(i >= vs.length) S.clips.push(c); else S.clips.splice(S.clips.indexOf(vs[i]), 0, c);
      // formato do projeto segue o primeiro vídeo até a pessoa escolher outro
      if(S.ratioAuto && vs.length === 0) S.ratio = m.h > m.w * 1.15 ? (m.h / m.w < 1.5 ? '4:5' : '9:16') : m.w > m.h * 1.15 ? '16:9' : '1:1';
    } else if(k === 'a'){
      const ends = L().a.map(e => e.end);
      c.start = Math.max(0, opt.start ?? (ends.length ? Math.max(...ends) : 0));
      S.clips.push(c);
    } else {
      c.start = Math.max(0, opt.start ?? t);
      c.layer = freeLayer(c.start, c.start + clipDur(c), opt.layer ?? 0);
      c.tf = defaultTf(m);
      S.clips.push(c);
    }
  });
  sel = c.id;
  if(wasEmpty || autoFit) zoomFit();
  changed(); sizeScreen();
}

/* ---------- timeline ---------- */
const content = $('#tl-content'), scroller = $('#tl-scroll'), tracksEl = $('#tracks'), headsEl = $('#heads');
const TILE_W = 104;
const rows = () => { const r = []; for(let l = S.layers - 1; l >= 0; l--) r.push({k: 'o', l}); r.push({k: 'v'}, {k: 'a'}); return r; };
function clipHTML(e){
  const c = e.c, m = media.get(c.mid), x = e.start * pps, w = Math.max(3, (e.end - e.start) * pps);
  let inner = '';
  if(c.track !== 'a' && m?.thumbs.length){
    const tiles = [], tw = c.track === 'o' ? 60 : TILE_W;
    for(let px = 0; px < w; px += tw){
      const mt = c.in + (px + tw / 2) / pps * c.speed;
      let best = m.thumbs[0];
      for(const th of m.thumbs) if(Math.abs(th.t - mt) < Math.abs(best.t - mt)) best = th;
      tiles.push(`<span style="width:${Math.min(tw, w - px)}px;background-image:url(${best.url})"></span>`);
    }
    inner = `<div class="strip">${tiles.join('')}</div>`;
  } else if(c.track === 'a' && m?.wave){
    inner = `<div class="wave" style="background-image:url(${m.wave});background-size:${m.duration / c.speed * pps}px 100%;background-position:${-c.in / c.speed * pps}px 0"></div>`;
  }
  const tags = [c.speed !== 1 ? `${c.speed}×` : '', c.muted ? 'mudo' : ''].filter(Boolean).join(' · ');
  return `<div class="clip ${c.track}${c.id === sel ? ' sel' : ''}${w < 60 ? ' narrow' : ''}" data-id="${c.id}" style="left:${x}px;width:${w}px">${inner}
    <span class="clip-name">${esc(m?.name || 'arquivo removido')}</span>${tags ? `<span class="clip-tag">${tags}</span>` : ''}
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
function renderTimeline(){
  const l = L(), R = rows();
  const width = Math.max(scroller.clientWidth, (l.end + 8) * pps);
  content.style.width = width + 'px';
  renderRuler(width);
  const hasO = l.o.length > 0;
  headsEl.innerHTML = R.map(r => r.k === 'o'
    ? `<div class="th o">${ICON.layer}<span>Camada ${r.l + 1}</span>${r.l === S.layers - 1 && S.layers > 1 && !l.o.some(e => e.c.layer === r.l) ? `<button class="th-x" type="button" data-rmlayer title="Remover camada vazia" aria-label="Remover camada vazia"><svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6"/></svg></button>` : ''}</div>`
    : r.k === 'v' ? `<div class="th v" title="Trilha principal: os clipes ficam colados um no outro">${ICON.video}<span>Vídeo</span></div>`
    : `<div class="th a" title="Trilha de áudio: músicas e efeitos">${ICON.audio}<span>Áudio</span></div>`).join('');
  tracksEl.innerHTML = R.map(r => {
    if(r.k === 'o'){
      const cl = l.o.filter(e => e.c.layer === r.l);
      return `<div class="track o" data-track="o" data-layer="${r.l}">${cl.map(clipHTML).join('')}${!hasO && r.l === 0 ? '<span class="track-empty">Solte aqui fotos e elementos para ficarem por cima do vídeo</span>' : ''}</div>`;
    }
    if(r.k === 'v'){
      const marks = l.v.slice(1).map(e => {
        const on = e.td > 0, mid = e.start + e.td / 2;
        return `${on ? `<span class="tr-zone" style="left:${e.start * pps}px;width:${e.td * pps}px"></span>` : ''}<button class="tr-mark${on ? ' on' : ''}" type="button" data-tr="${e.c.id}" style="left:${mid * pps}px" title="${on ? 'Transição: ' + TR[e.c.tr.type].label : 'Adicionar transição'}" aria-label="${on ? 'Transição: ' + TR[e.c.tr.type].label : 'Adicionar transição'}">${on ? ICON.trans : ICON.plus}</button>`;
      }).join('');
      return `<div class="track v" data-track="v">${l.v.map(clipHTML).join('') || '<span class="track-empty">Arraste vídeos e fotos para cá</span>'}${marks}</div>`;
    }
    return `<div class="track a" data-track="a">${l.a.map(clipHTML).join('') || '<span class="track-empty">Arraste músicas para cá (ou use a aba Músicas)</span>'}</div>`;
  }).join('') + (l.total && l.end > l.total + .05 ? `<div class="tl-end" style="left:${l.total * pps}px" title="Depois daqui não entra no vídeo"><span>fim do vídeo</span></div>` : '');
  placePlayhead();
  renderHint();
}
function renderHint(){
  $('#tl-hint').textContent = !S.clips.length ? 'Arraste arquivos para a timeline ou use o + em cada arquivo'
    : sel ? (clipById(sel)?.track === 'o' ? 'Arraste a imagem no preview para mover · o canto muda o tamanho' : 'Arraste as bordas do clipe para cortar · S divide no cursor · Delete exclui')
    : 'Clique num clipe para editar · o losango entre dois clipes adiciona transição';
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
  const l = L(), pts = [0, t], vi = except?.track === 'v' ? l.v.findIndex(e => e.c === except) : -1;
  l.v.forEach((e, i) => { if(e.c !== except && (vi < 0 || i < vi)) pts.push(e.start, e.end); });
  for(const e of [...l.a, ...l.o]) if(e.c !== except) pts.push(e.start, e.end);
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
  const clipEl = e.target.closest('.clip');
  if(clipEl) return dragClip(e, clipEl);
  if(!e.target.closest('#ph-grip, #ruler') && sel) select(null);
  scrub(e);
});
content.addEventListener('click', e => { const m = e.target.closest('.tr-mark'); if(m) openTrPop(m); });
headsEl.addEventListener('click', e => { if(e.target.closest('[data-rmlayer]')) edit(() => { S.layers = Math.max(1, S.layers - 1); }); });
$('#add-layer').addEventListener('click', () => { edit(() => { S.layers++; }); toast(`Camada ${S.layers} criada`); });
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
function dragClip(e, el){
  const c = clipById(el.dataset.id); if(!c) return;
  if(sel !== c.id){ sel = c.id; closeTrPop(); $$('.clip.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); renderProps(); renderHint(); updateUi(); dirty = true; }
  const h = e.target.closest('.h'), mode = h ? (h.classList.contains('l') ? 'trimL' : 'trimR') : 'move';
  const m = media.get(c.mid), still = m?.kind === 'image', maxOut = still ? 3600 : (m?.duration || c.out), free = c.track !== 'v';
  const before = snap(), x0 = e.clientX, e0 = entryOf(c), o = {in: c.in, out: c.out, start: e0.start, end: e0.end};
  const pts = snapPoints(c);
  let moved = false, dropIdx = null;
  capture(content, e);
  const mv = ev => {
    const dx = ev.clientX - x0;
    if(!moved && Math.abs(dx) < 4){
      // parado na horizontal: só começa se for uma sobreposição mudando de camada
      if(c.track !== 'o' || mode !== 'move') return;
      const tr = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.track.o');
      if(!tr || +tr.dataset.layer === c.layer) return;
    }
    if(!moved && playing) pause();
    moved = true;
    const dt = dx / pps;
    if(mode === 'trimR'){
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
    } else if(free){
      const d = o.end - o.start;
      let ns = Math.max(0, o.start + dt);
      const a1 = snapTo(ns, pts);
      if(a1 !== ns) ns = a1; else { const b1 = snapTo(ns + d, pts); if(b1 !== ns + d) ns = b1 - d; }
      c.start = Math.max(0, ns);
      // camadas: subir ou descer o clipe muda de camada
      if(c.track === 'o'){ const tr = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.track.o'); if(tr) c.layer = +tr.dataset.layer; }
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
    layoutCache = null; dirty = true;
    renderTimeline(); renderProps(); updateUi();
  };
  const up = () => {
    content.removeEventListener('pointermove', mv); content.removeEventListener('pointerup', up); content.removeEventListener('pointercancel', up);
    $('#drop-mark').hidden = true; $('#snap-mark').hidden = true;
    if(mode === 'move' && c.track === 'v' && moved && dropIdx !== null){
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
const MT = {media: 'application/x-wk-media', audio: 'application/x-wk-lib-audio', el: 'application/x-wk-lib-el', tr: 'application/x-wk-tr'};
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
  if(![MT.media, MT.audio, MT.el, 'Files'].some(x => types.includes(x))) return;
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
  const dt = e.dataTransfer, tt = xToTime(e), k = tr.dataset.track;
  const at = snapTo(tt, snapPoints(null)); clearDrop();
  if(dt.types.includes(MT.tr)){ const cut = nearestCut(tt); if(cut) setTransition(cut.c, dt.getData(MT.tr)); else toast('Coloque pelo menos dois clipes na trilha de vídeo'); return; }
  const {v} = L(); let idx = v.findIndex(x => tt < (x.start + x.end) / 2); if(idx < 0) idx = v.length;
  const opt = k === 'v' ? {index: idx} : k === 'o' ? {track: 'o', start: at, layer: +tr.dataset.layer} : {start: at};
  const id = dt.getData(MT.media);
  if(id){ const m = media.get(id); if(m?.status === 'ready') addToTimeline(m, m.kind === 'audio' ? {start: at} : k === 'a' ? {} : opt); return; }
  const au = dt.getData(MT.audio); if(au){ importAudio(JSON.parse(au), {start: at}); return; }
  const el = dt.getData(MT.el); if(el){ importEl(JSON.parse(el), k === 'o' ? opt : {track: 'o', start: at}); return; }
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
      for(const o of els.values()) wire(o);
    }catch{ actx = null; }
  }
  if(actx && actx.state === 'suspended') actx.resume();
}
// o som de cada clipe passa pelo mixer: volume acima de 100%, cruzamento nas transições e gravação na exportação
function wire(o){
  if(!actx || o.node) return;
  try{ o.node = actx.createMediaElementSource(o.el); o.gain = actx.createGain(); o.node.connect(o.gain).connect(master); }catch{}
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
  if(o.gain){ o.gain.gain.value = v; o.el.volume = 1; o.el.muted = false; }
  else { o.el.volume = clamp(v, 0, 1); o.el.muted = c.muted; }
}
// libera elementos de clipes apagados e os menos usados (o navegador limita quantos vídeos abertos)
function pruneEls(){
  const alive = new Set(S.clips.map(c => c.id));
  const drop = [...els.entries()].filter(([id]) => !alive.has(id));
  const rest = [...els.entries()].filter(([id]) => alive.has(id)).sort((a, b) => b[1].used - a[1].used);
  drop.push(...rest.slice(14));
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
    applyVol(o, c, f);
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
}

/* ---------- desenho (preview e exportação) ---------- */
const screen = $('#screen'), sctx = screen.getContext('2d');
function sizeScreen(){
  const wrap = $('#stage-wrap'), r = RATIOS[S.ratio];
  const W = Math.max(40, wrap.clientWidth - 24), H = Math.max(40, wrap.clientHeight - 24);
  let w = W, h = w / r; if(h > H){ h = H; w = h * r; }
  screen.style.width = Math.floor(w) + 'px'; screen.style.height = Math.floor(h) + 'px';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  screen.width = Math.round(w * dpr); screen.height = Math.round(h * dpr);
  dirty = true;
}
new ResizeObserver(() => sizeScreen()).observe($('#stage-wrap'));
// quadro de um clipe: imagem pronta, null (sem imagem) ou false (vídeo ainda carregando)
function frameOf(c){
  const m = media.get(c.mid); if(!m) return null;
  if(m.kind === 'image') return m.img ? {src: m.img, w: m.w, h: m.h} : null;
  const o = els.get(c.id);
  return o && o.el.readyState >= 2 && o.el.videoWidth ? {src: o.el, w: o.el.videoWidth, h: o.el.videoHeight} : false;
}
function drawFull(ctx, c, f, W, H){
  ctx.fillStyle = S.bg; ctx.fillRect(0, 0, W, H);
  if(!f) return;
  const k = c.fit === 'cover' ? Math.max(W / f.w, H / f.h) : Math.min(W / f.w, H / f.h);
  ctx.drawImage(f.src, (W - f.w * k) / 2, (H - f.h * k) / 2, f.w * k, f.h * k);
}
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
// caixa de uma sobreposição no quadro: centro, tamanho e rotação
function oBox(c, W, H){
  const m = media.get(c.mid), ar = (m?.h || 1) / (m?.w || 1), w = c.tf.s * W;
  return {cx: c.tf.x * W, cy: c.tf.y * H, w, h: w * ar, r: c.tf.r * Math.PI / 180};
}
function drawOverlay(ctx, c, f, W, H){
  if(!f) return;
  const b = oBox(c, W, H);
  ctx.save(); ctx.globalAlpha = c.tf.op; ctx.translate(b.cx, b.cy); ctx.rotate(b.r);
  ctx.drawImage(f.src, -b.w / 2, -b.h / 2, b.w, b.h);
  ctx.restore();
}
function render(ctx, W, H){
  const av = activeV(), fr = av.map(e => frameOf(e.c));
  const ov = activeO().sort((x, y) => x.c.layer - y.c.layer || S.clips.indexOf(x.c) - S.clips.indexOf(y.c)), ofr = ov.map(e => frameOf(e.c));
  if(fr.includes(false) || ofr.includes(false)) return false;   // mantém o quadro anterior até carregar
  ctx.save(); ctx.imageSmoothingQuality = 'high';
  if(!av.length){ ctx.fillStyle = S.bg; ctx.fillRect(0, 0, W, H); }
  else if(av.length === 1) drawFull(ctx, av[0].c, fr[0], W, H);
  else drawTransition(ctx, av[0], fr[0], av[1], fr[1], W, H);
  ov.forEach((e, i) => drawOverlay(ctx, e.c, ofr[i], W, H));
  ctx.restore();
  return true;
}
// moldura da sobreposição selecionada (só no preview, não vai para o vídeo)
const guides = {x: false, y: false};
function drawSelUi(){
  const c = sel && clipById(sel);
  if(!c || c.track !== 'o' || !activeO().some(e => e.c === c)) return;
  const W = screen.width, H = screen.height, b = oBox(c, W, H), dpr = W / screen.getBoundingClientRect().width || 1;
  sctx.save();
  if(guides.x || guides.y){
    sctx.strokeStyle = '#ff3bd4'; sctx.lineWidth = 1 * dpr; sctx.setLineDash([6 * dpr, 4 * dpr]);
    if(guides.x){ sctx.beginPath(); sctx.moveTo(W / 2, 0); sctx.lineTo(W / 2, H); sctx.stroke(); }
    if(guides.y){ sctx.beginPath(); sctx.moveTo(0, H / 2); sctx.lineTo(W, H / 2); sctx.stroke(); }
    sctx.setLineDash([]);
  }
  sctx.translate(b.cx, b.cy); sctx.rotate(b.r);
  sctx.strokeStyle = '#fff'; sctx.lineWidth = 3 * dpr; sctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
  sctx.strokeStyle = '#1a8a92'; sctx.lineWidth = 1.5 * dpr; sctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
  const hs = 9 * dpr;
  sctx.fillStyle = '#fff'; sctx.fillRect(b.w / 2 - hs, b.h / 2 - hs, hs * 2, hs * 2);
  sctx.strokeRect(b.w / 2 - hs, b.h / 2 - hs, hs * 2, hs * 2);
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
  if(dirty){
    if(render(sctx, screen.width, screen.height)){ dirty = false; if(!EXP.on) drawSelUi(); }
    if(EXP.on) render(EXP.cx, EXP.cv.width, EXP.cv.height);
  }
}
requestAnimationFrame(frame);

/* ---------- mover e redimensionar sobreposições direto no preview ---------- */
function canvasPt(e){ const r = screen.getBoundingClientRect(); return {x: (e.clientX - r.left) * screen.width / r.width, y: (e.clientY - r.top) * screen.height / r.height, k: screen.width / r.width}; }
function toLocal(b, p){ const dx = p.x - b.cx, dy = p.y - b.cy, co = Math.cos(-b.r), si = Math.sin(-b.r); return {x: dx * co - dy * si, y: dx * si + dy * co}; }
function hitTest(p){
  const W = screen.width, H = screen.height, sc = sel && clipById(sel);
  if(sc?.track === 'o' && activeO().some(e => e.c === sc)){
    const b = oBox(sc, W, H), lp = toLocal(b, p);
    if(Math.hypot(lp.x - b.w / 2, lp.y - b.h / 2) < 16 * p.k) return {c: sc, mode: 'scale'};
  }
  const list = activeO().sort((x, y) => y.c.layer - x.c.layer || S.clips.indexOf(y.c) - S.clips.indexOf(x.c));
  for(const e of list){ const b = oBox(e.c, W, H), lp = toLocal(b, p); if(Math.abs(lp.x) <= b.w / 2 && Math.abs(lp.y) <= b.h / 2) return {c: e.c, mode: 'move'}; }
  return null;
}
screen.addEventListener('pointermove', e => {
  if(e.buttons) return;
  const h = hitTest(canvasPt(e));
  screen.classList.toggle('can-move', h?.mode === 'move'); screen.classList.toggle('can-scale', h?.mode === 'scale');
});
screen.addEventListener('pointerdown', e => {
  if(e.button !== 0) return;
  const p = canvasPt(e), hit = hitTest(p);
  if(!hit){
    // clique fora das sobreposições: toca/pausa (e tira a seleção da sobreposição)
    const up = () => { screen.removeEventListener('pointerup', up); if(sel && clipById(sel)?.track === 'o') select(null); toggle(); };
    screen.addEventListener('pointerup', up);
    return;
  }
  e.preventDefault();
  if(playing) pause();
  if(sel !== hit.c.id) select(hit.c.id);
  const c = hit.c, W = screen.width, H = screen.height, tf0 = {...c.tf}, b0 = oBox(c, W, H), d0 = Math.max(1, Math.hypot(p.x - b0.cx, p.y - b0.cy));
  capture(screen, e);
  const mv = ev => {
    const q = canvasPt(ev);
    live(() => {
      if(hit.mode === 'scale') c.tf.s = clamp(tf0.s * Math.hypot(q.x - b0.cx, q.y - b0.cy) / d0, .03, 4);
      else {
        let nx = tf0.x + (q.x - p.x) / W, ny = tf0.y + (q.y - p.y) / H;
        guides.x = Math.abs(nx - .5) < 10 * q.k / W; guides.y = Math.abs(ny - .5) < 10 * q.k / H;
        if(guides.x) nx = .5; if(guides.y) ny = .5;
        c.tf.x = clamp(nx, -.5, 1.5); c.tf.y = clamp(ny, -.5, 1.5);
      }
    });
  };
  const up = () => { screen.removeEventListener('pointermove', mv); screen.removeEventListener('pointerup', up); screen.removeEventListener('pointercancel', up); guides.x = guides.y = false; liveEnd(); };
  screen.addEventListener('pointermove', mv); screen.addEventListener('pointerup', up); screen.addEventListener('pointercancel', up);
});

function updateTime(){ $('#tc-now').textContent = fmtTime(t); $('#tc-total').textContent = fmtTime(L().total); }
function updateUi(){
  updateTime();
  const l = L();
  $('#stage-empty').hidden = l.v.length > 0 || l.o.length > 0;
  $('#export-btn').disabled = !l.total;
  $('#undo').disabled = !hist.past.length; $('#redo').disabled = !hist.future.length;
  $('#t-del').disabled = $('#t-dup').disabled = !sel;
  $('#t-split').disabled = !S.clips.length;
  $('#ratio-badge').textContent = S.ratio;
}

/* ---------- editar clipes ---------- */
const copyClip = c => ({...c, id: uid(), tf: c.tf ? {...c.tf} : undefined, tr: null});
function split(){
  const s = sel && clipById(sel), l = L();
  const inside = e => t > e.start + .04 && t < e.end - .04;
  const targets = s ? [entryOf(s)].filter(inside) : [...l.v, ...l.a, ...l.o].filter(inside);
  if(!targets.length){ toast(s ? 'Coloque o cursor em cima do clipe selecionado para dividir' : 'Coloque o cursor em cima de um clipe para dividir'); return; }
  edit(() => {
    for(const e of targets){
      const c = e.c, cut = c.in + (t - e.start) * c.speed;
      const b = {...copyClip(c), in: cut};
      if(c.track !== 'v') b.start = t;
      c.out = cut;
      S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
      if(s) sel = b.id;
    }
  });
}
function del(){ const c = sel && clipById(sel); if(!c) return; edit(() => { S.clips.splice(S.clips.indexOf(c), 1); sel = null; }); }
function duplicate(){
  const c = sel && clipById(sel); if(!c) return;
  const e = entryOf(c), b = copyClip(c);
  edit(() => {
    if(c.track !== 'v') b.start = e.end;
    if(c.track === 'o') b.layer = freeLayer(b.start, b.start + clipDur(b), c.layer);
    S.clips.splice(S.clips.indexOf(c) + 1, 0, b); sel = b.id;
  });
}
// levar um clipe da trilha principal para uma camada (e voltar)
function toLayer(c){
  const e = entryOf(c), m = media.get(c.mid);
  edit(() => { c.track = 'o'; c.start = e.start; c.tr = null; c.tf = defaultTf(m || {}); c.layer = freeLayer(c.start, c.start + clipDur(c), 0, c); });
  toast('Agora está por cima do vídeo: arraste no preview para posicionar');
}
function toMain(c){
  const {v} = L(), i = v.findIndex(x => c.start < (x.start + x.end) / 2);
  edit(() => {
    S.clips.splice(S.clips.indexOf(c), 1);
    c.track = 'v'; delete c.start; delete c.layer; delete c.tf; c.fit = 'contain';
    const vs = S.clips.filter(x => x.track === 'v');
    if(i < 0 || i >= vs.length) S.clips.push(c); else S.clips.splice(S.clips.indexOf(vs[i]), 0, c);
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
  $('#trpop-dur').value = d; $('#trpop-dur-out').textContent = d.toFixed(1).replace('.', ',') + ' s';
  $('#trpop-dur').disabled = cur === 'none';
}
function closeTrPop(){ const pop = $('#trpop'); trFor = null; if(isOpen(pop)) gelHide(pop, () => { pop.hidden = true; }); }
$('#trpop-grid').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if(!b) return; setTransition(clipById(trFor), b.dataset.v); renderTrPop(); });
$('#trpop-dur').addEventListener('input', e => {
  const c = clipById(trFor); if(!c?.tr) return;
  live(() => { c.tr.d = +e.target.value; }); TRD.d = +e.target.value;
  $('#trpop-dur-out').textContent = (+e.target.value).toFixed(1).replace('.', ',') + ' s';
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
function renderProps(){
  const c = sel && clipById(sel), p = $('#props');
  if(!c){
    const {v, a, o, total} = L();
    p.innerHTML = `<div class="pane-h"><b>Projeto</b></div><div class="props-body">
      <div class="pr"><div class="pr-h">Formato</div>
        <div class="ratios" id="p-ratio">${Object.keys(RATIOS).map(r => `<button type="button" data-v="${r}" aria-pressed="${S.ratio === r}"><i style="width:${RATIO_ICON[r][0]}px;height:${RATIO_ICON[r][1]}px"></i>${r}</button>`).join('')}</div>
        <p class="hint">${S.ratio === '9:16' ? 'Reels, TikTok e Shorts.' : S.ratio === '16:9' ? 'YouTube, sites e apresentações.' : S.ratio === '1:1' ? 'Feed quadrado.' : 'Feed do Instagram (retrato).'}</p></div>
      <div class="pr"><div class="pr-h">Cor do fundo</div>
        <div class="pr-row"><input type="color" id="p-bg" value="${esc(S.bg)}" aria-label="Cor do fundo"><span class="hint">Aparece nas bordas quando o vídeo não preenche a tela.</span></div></div>
      <div class="pr-stats"><span>Duração</span><b>${fmtTime(total)}</b><span>Clipes de vídeo</span><b>${v.length}</b><span>Sobreposições</span><b>${o.length}</b><span>Clipes de áudio</span><b>${a.length}</b></div>
      <div class="pr-tip"><b>Como usar</b>
        <span>1. Importe seus arquivos ou pegue músicas e elementos nas abas.</span>
        <span>2. Arraste para a timeline. Nas <b>Camadas</b>, a imagem fica por cima do vídeo.</span>
        <span>3. Corte arrastando a borda, ou pare o cursor e aperte <kbd>S</kbd>.</span>
        <span>4. O losango entre dois clipes adiciona transição.</span></div>
    </div>`;
    return;
  }
  const m = media.get(c.mid), e = entryOf(c), still = m?.kind === 'image', sound = m && m.kind !== 'image';
  const vi = c.track === 'v' ? L().v.findIndex(x => x.c === c) : -1;
  const title = c.track === 'a' ? 'Áudio' : c.track === 'o' ? 'Sobreposição' : still ? 'Foto' : 'Vídeo';
  p.innerHTML = `<div class="pane-h"><b>${title}</b><button class="ib" id="p-close" type="button" title="Voltar ao projeto (Esc)" aria-label="Fechar"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
    <div class="props-body">
      <div class="pr-name">${m?.thumb ? `<img src="${m.thumb}" alt="">` : `<span class="ph"></span>`}<div><b title="${esc(m?.name)}">${esc(m?.name || 'arquivo removido')}</b><span>${fmtTime(e.end - e.start)} na timeline${c.track === 'o' ? ` · camada ${c.layer + 1}` : ''}</span></div></div>
      ${c.track === 'o' ? `
        ${range('p-size', 'Tamanho', 3, 300, 1, Math.round(c.tf.s * 100), Math.round(c.tf.s * 100) + '%')}
        ${range('p-rot', 'Rotação', -180, 180, 1, Math.round(c.tf.r), Math.round(c.tf.r) + '°')}
        ${range('p-op', 'Opacidade', 0, 100, 1, Math.round(c.tf.op * 100), Math.round(c.tf.op * 100) + '%')}
        <div class="pr"><div class="pr-h">Posição</div><div class="pr-2"><div class="pos9" id="p-pos">${['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].map(v => `<button type="button" data-v="${v}" aria-label="Posição ${v}"></button>`).join('')}</div><span class="hint">Ou arraste a imagem direto no preview. O quadradinho do canto muda o tamanho.</span></div></div>` : ''}
      ${sound ? `<div class="pr"><div class="pr-h"><label for="p-vol">Volume</label><output id="p-vol-out">${Math.round(c.volume * 100)}%</output></div>
        <input type="range" id="p-vol" min="0" max="200" step="5" value="${Math.round(c.volume * 100)}">
        <label class="chk"><input type="checkbox" id="p-mute"${c.muted ? ' checked' : ''}> Sem som</label></div>` : ''}
      ${!still ? `<div class="pr"><div class="pr-h">Velocidade</div><div class="seg" id="p-speed">${SPEEDS.map(s => `<button type="button" data-v="${s}" aria-pressed="${c.speed === s}">${String(s).replace('.', ',')}×</button>`).join('')}</div></div>` : ''}
      ${c.track === 'v' ? `<div class="pr"><div class="pr-h">Enquadramento</div><div class="seg" id="p-fit"><button type="button" data-v="contain" aria-pressed="${c.fit !== 'cover'}">Mostrar inteiro</button><button type="button" data-v="cover" aria-pressed="${c.fit === 'cover'}">Preencher a tela</button></div></div>` : ''}
      ${vi > 0 ? `<div class="pr"><div class="pr-h"><label for="p-tr">Transição de entrada</label></div><select class="inp" id="p-tr"><option value="none">Nenhuma</option>${TRS.map(x => `<option value="${x.id}"${c.tr?.type === x.id ? ' selected' : ''}>${x.label}</option>`).join('')}</select></div>` : ''}
      ${still ? `<div class="pr"><div class="pr-h"><label for="p-dur">Duração na tela</label></div><div class="pr-row"><input class="inp" id="p-dur" type="number" min="0.1" max="3600" step="0.5" value="${+(c.out - c.in).toFixed(2)}"><span class="hint">segundos</span></div></div>` : ''}
      <div class="pr-stats"><span>Começa em</span><b>${fmtTime(e.start)}</b><span>Termina em</span><b>${fmtTime(e.end)}</b>${!still ? `<span>Trecho do arquivo</span><b>${fmtTime(c.in)} → ${fmtTime(c.out)}</b>` : ''}</div>
      ${c.track === 'o' ? `<div class="pr-acts"><button class="ghost" id="p-front" type="button">Para frente</button><button class="ghost" id="p-back" type="button"${c.layer === 0 ? ' disabled' : ''}>Para trás</button><button class="ghost" id="p-tomain" type="button" style="grid-column:1/-1">Pôr na trilha principal</button></div>`
        : c.track === 'v' ? `<div class="pr-acts"><button class="ghost" id="p-tolayer" type="button" style="grid-column:1/-1">Pôr por cima do vídeo</button></div>` : ''}
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
  else if(b.id === 'p-tolayer' && c) toLayer(c);
  else if(b.id === 'p-tomain' && c) toMain(c);
  else if(b.id === 'p-front' && c) edit(() => { c.layer++; });
  else if(b.id === 'p-back' && c) edit(() => { c.layer = Math.max(0, c.layer - 1); });
  else if(b.closest('#p-ratio')){ edit(() => { S.ratio = b.dataset.v; S.ratioAuto = false; }); sizeScreen(); }
  else if(b.closest('#p-speed') && c) edit(() => { c.speed = +b.dataset.v; });
  else if(b.closest('#p-fit') && c) edit(() => { c.fit = b.dataset.v; });
  else if(b.closest('#p-pos') && c){
    const W = screen.width, H = screen.height, bx = oBox({...c, tf: {...c.tf, r: 0}}, W, H), mx = bx.w / 2 / W + .04, my = bx.h / 2 / H + .04, v = b.dataset.v;
    edit(() => { c.tf.x = v[1] === 'l' ? mx : v[1] === 'r' ? 1 - mx : .5; c.tf.y = v[0] === 't' ? my : v[0] === 'b' ? 1 - my : .5; });
  }
});
$('#props').addEventListener('input', e => {
  const c = sel && clipById(sel), v = +e.target.value, id = e.target.id;
  const out = txt => { const o = $('#' + id + '-out'); if(o) o.textContent = txt; };
  if(id === 'p-vol' && c){ live(() => { c.volume = v / 100; }); out(v + '%'); syncMedia(!playing); }
  else if(id === 'p-bg') live(() => { S.bg = e.target.value; });
  else if(id === 'p-size' && c){ live(() => { c.tf.s = v / 100; }); out(v + '%'); }
  else if(id === 'p-rot' && c){ live(() => { c.tf.r = v; }); out(v + '°'); }
  else if(id === 'p-op' && c){ live(() => { c.tf.op = v / 100; }); out(v + '%'); }
});
$('#props').addEventListener('change', e => {
  const c = sel && clipById(sel), id = e.target.id;
  if(['p-vol', 'p-bg', 'p-size', 'p-rot', 'p-op'].includes(id)) liveEnd();
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
const PT = Object.fromEntries(Object.entries({
  calma: 'calm', calmo: 'calm', relaxante: 'relaxing', animada: 'upbeat', animado: 'upbeat', feliz: 'happy', alegre: 'happy', triste: 'sad', piano: 'piano', violao: 'acoustic guitar',
  guitarra: 'guitar', corporativa: 'corporate', corporativo: 'corporate', cinematica: 'cinematic', epica: 'epic', epico: 'epic', suspense: 'suspense', festa: 'party', natal: 'christmas',
  romantica: 'romantic', romantico: 'romantic', infantil: 'kids', eletronica: 'electronic', acustica: 'acoustic', inspiradora: 'inspiring', motivacional: 'motivational',
  aplausos: 'applause', clique: 'click', risada: 'laugh', explosao: 'explosion', chuva: 'rain', vento: 'wind', passos: 'footsteps', porta: 'door', sino: 'bell', transicao: 'whoosh',
  notificacao: 'notification', impacto: 'impact', tambor: 'drum', agua: 'water', carro: 'car', buzina: 'horn', dinheiro: 'money', caixa: 'cash register',
  estrela: 'star', estrelas: 'star', seta: 'arrow', setas: 'arrow', coracao: 'heart', coracoes: 'heart', fogo: 'fire', casa: 'house', telefone: 'phone', celular: 'phone', email: 'mail',
  localizacao: 'location', mapa: 'map', relogio: 'clock', calendario: 'calendar', check: 'check', certo: 'check', errado: 'cross', like: 'thumbs up', joinha: 'thumbs up',
  sol: 'sun', lua: 'moon', flor: 'flower', ferramenta: 'tool', pincel: 'brush', tinta: 'paint', presente: 'gift', trofeu: 'trophy', foguete: 'rocket', raio: 'lightning',
  balao: 'speech bubble', carinha: 'face', rosto: 'face', sorriso: 'smile', olho: 'eye', mao: 'hand', compras: 'shopping', carrinho: 'cart', cadeado: 'lock',
}).map(([k, v]) => [k, v]));
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
  const list = $('#mu-list');
  const rowsHtml = MU.items.map((a, i) => `<li class="lib-it" draggable="true" data-i="${i}">
      <button class="lib-play${pvIdx === i ? ' on' : ''}" type="button" data-act="play" aria-label="Ouvir ${esc(a.title)}">${pvIdx === i ? ICON.pause : ICON.play}</button>
      <div><b title="${esc(a.title)}">${esc(a.title || 'Sem título')}</b><span>${esc(a.creator || 'autor desconhecido')} · ${fmtTime((a.duration || 0) / 1000, false)} · ${licLabel(a)}</span></div>
      <button class="lib-add" type="button" data-act="add" title="Colocar na timeline" aria-label="Colocar ${esc(a.title)} na timeline">${ICON.plus}</button></li>`).join('');
  list.innerHTML = rowsHtml
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
// baixa a música para o navegador e coloca na trilha de áudio, guardando os créditos
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
    toast('Adicionada na trilha de áudio');
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
$('#el-grid').addEventListener('click', e => { const b = e.target.closest('[data-id]'); if(b) importEl({id: b.dataset.id, color: EL.kind === 'mono' ? EL.color : null}, {track: 'o', start: t}, b); });
$('#el-grid').addEventListener('dragstart', e => {
  const b = e.target.closest('[data-id]'); if(!b) return;
  e.dataTransfer.setData(MT.el, JSON.stringify({id: b.dataset.id, color: EL.kind === 'mono' ? EL.color : null})); e.dataTransfer.effectAllowed = 'copy';
});
// monta o SVG em alta e coloca numa camada, por cima do vídeo
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
$('#tr-dur').addEventListener('input', e => { TRD.d = +e.target.value; $('#tr-dur-out').textContent = TRD.d.toFixed(1).replace('.', ',') + ' s'; });
$('#tr-all').addEventListener('click', () => {
  const l = L(); if(l.v.length < 2){ toast('Coloque pelo menos dois clipes na trilha de vídeo'); return; }
  edit(() => { l.v.slice(1).forEach(e => { e.c.tr = {type: TRD.type, d: TRD.d}; }); });
  toast(`"${TR[TRD.type].label}" em todos os cortes`);
});
$('#tr-none').addEventListener('click', () => { edit(() => { S.clips.forEach(c => { if(c.tr) c.tr = null; }); }); toast('Transições removidas'); });

/* ---------- arquivos: botões e arrastar ---------- */
const fileIn = $('#file');
$('#import').addEventListener('click', () => fileIn.click());
$('#import2').addEventListener('click', () => fileIn.click());
fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; });
$('#media-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const m = media.get(b.closest('.mi').dataset.mid); if(!m) return;
  if(b.dataset.act === 'add') addToTimeline(m, m.sticker ? {track: 'o', start: t} : {});
  else {
    const used = S.clips.filter(c => c.mid === m.id).length;
    if(used && !confirm(`"${m.name}" está em ${used === 1 ? '1 clipe' : used + ' clipes'} da timeline. Remover mesmo assim?`)) return;
    if(used) edit(() => { S.clips = S.clips.filter(c => c.mid !== m.id); if(sel && !clipById(sel)) sel = null; });
    URL.revokeObjectURL(m.url); m.thumbs.forEach(x => URL.revokeObjectURL(x.url)); if(m.wave) URL.revokeObjectURL(m.wave);
    media.delete(m.id); renderMedia(); changed();
  }
});
$('#media-grid').addEventListener('dblclick', e => { const li = e.target.closest('.mi'); const m = li && media.get(li.dataset.mid); if(m?.status === 'ready' && !e.target.closest('button')) addToTimeline(m, m.sticker ? {track: 'o', start: t} : {}); });
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
  else if(k === 'Escape'){ if(trFor) closeTrPop(); else if(sel) select(null); }
});

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
  const mime = pickMime(); if(!mime) return;
  pause(); ensureAudio();
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
  const r = EXP.rec; if(!r) return;
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
document.addEventListener('visibilitychange', () => { if(EXP.on) updateExp(); });

/* ---------- tema e saída ---------- */
const themeBtn = $('#theme');
function syncThemeBtn(){ const dark = document.documentElement.dataset.theme === 'dark'; const l = dark ? 'Ativar modo claro' : 'Ativar modo escuro'; themeBtn.setAttribute('aria-label', l); themeBtn.title = l; }
themeBtn.addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try{ localStorage.setItem('rx-theme', next); }catch{} syncThemeBtn(); });
syncThemeBtn();
window.addEventListener('beforeunload', e => { if(S.clips.length || EXP.on){ e.preventDefault(); e.returnValue = ''; } });

/* ---------- início ---------- */
renderMedia(); renderProps(); sizeScreen(); setPps(60); updateUi();
