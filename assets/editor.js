// Editor de vídeo no navegador, organizado como o OpenCut: arquivos, preview, propriedades e timeline.
// Trilha de vídeo magnética (clipes colados, em ordem) + trilha de áudio livre. Exporta em tempo real com MediaRecorder.
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const FPS = 30, MIN = 0.1;
function fmtTime(t, cs = true){
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return cs ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}
function toast(msg){ const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(el._h); el._h = setTimeout(() => el.classList.remove('show'), 2800); }
const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* ---------- popups com efeito gelatinoso (animações em motion.css) ---------- */
function gelOpen(d){ d._gel = null; d.classList.remove('gel-out'); if(!d.open) d.showModal(); }
function gelClose(d){
  if(!d.open || d._gel) return;
  const tk = d._gel = {};
  d.classList.add('gel-out');
  const end = e => { if(e && e.target !== d) return; if(d._gel !== tk) return; d._gel = null; d.classList.remove('gel-out'); d.close(); };
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return end();
  d.addEventListener('animationend', end); setTimeout(end, 400);
}

/* ---------- estado ---------- */
const media = new Map();            // arquivos importados (não entram no desfazer)
let S = {clips: [], ratio: '16:9', ratioAuto: true, bg: '#000000'};   // o que o desfazer guarda
let sel = null, t = 0, playing = false, pps = 60, snapOn = true, dirty = true, layoutCache = null;
const hist = {past: [], future: []};
const RATIOS = {'16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5};

const clipDur = c => (c.out - c.in) / c.speed;
const clipById = id => S.clips.find(c => c.id === id);
// posições na timeline: vídeo em sequência, áudio onde foi colocado
function layout(){
  let x = 0; const v = [];
  for(const c of S.clips) if(c.track === 'v'){ const d = clipDur(c); v.push({c, start: x, end: x + d}); x += d; }
  const a = S.clips.filter(c => c.track === 'a').map(c => ({c, start: c.start, end: c.start + clipDur(c)}));
  return {v, a, vEnd: x, total: Math.max(x, ...a.map(e => e.end), 0)};
}
const L = () => layoutCache || (layoutCache = layout());
const entryOf = c => L().v.find(e => e.c === c) || L().a.find(e => e.c === c);

/* ---------- desfazer / refazer ---------- */
const snap = () => JSON.stringify(S);
function pushHist(before){ hist.past.push(before); if(hist.past.length > 120) hist.past.shift(); hist.future = []; }
function edit(fn){ const before = snap(); fn(); if(snap() !== before) pushHist(before); changed(); }
function undo(){ if(!hist.past.length) return; hist.future.push(snap()); S = JSON.parse(hist.past.pop()); afterRestore(); }
function redo(){ if(!hist.future.length) return; hist.past.push(snap()); S = JSON.parse(hist.future.pop()); afterRestore(); }
function afterRestore(){ if(sel && !clipById(sel)) sel = null; changed(); }
// mudanças contínuas (arrastar um controle): guarda o "antes" uma vez e registra ao soltar
let liveBefore = null;
function live(fn){ if(liveBefore === null) liveBefore = snap(); fn(); layoutCache = null; dirty = true; renderTimeline(); updateUi(); }
function liveEnd(){ if(liveBefore !== null && liveBefore !== snap()) pushHist(liveBefore); liveBefore = null; changed(); }

function changed(){
  layoutCache = null;
  t = clamp(t, 0, L().total);
  renderTimeline(); renderProps(); updateUi();
  syncMedia(!playing); dirty = true;
  pruneEls();
}

/* ---------- importar arquivos ---------- */
const KIND_ICON = {
  video: '<svg viewBox="0 0 16 16"><rect x="1.8" y="3" width="12.4" height="10" rx="1.8"/><path d="M6.8 6v4l3.2-2z"/></svg>',
  image: '<svg viewBox="0 0 16 16"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><circle cx="5.5" cy="6.3" r="1.1"/><path d="M2.5 12l3.4-3 2.6 2.1 1.8-1.4 3.2 2.6"/></svg>',
  audio: '<svg viewBox="0 0 16 16"><path d="M6 12V3.5l7-1.5v8.5"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10.5" r="1.8"/></svg>',
};
function kindOf(f){
  const ty = f.type || '';
  if(ty.startsWith('video/')) return 'video';
  if(ty.startsWith('image/')) return /svg/.test(ty) ? 'image' : 'image';
  if(ty.startsWith('audio/')) return 'audio';
  if(/\.(mp4|mov|webm|mkv|m4v|ogv)$/i.test(f.name)) return 'video';
  if(/\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name)) return 'image';
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
// miniatura 16:9 recortada, guardada como arquivo (mais leve que data URL)
function thumbOf(src, sw, sh){
  const c = document.createElement('canvas'); c.width = 192; c.height = 108;
  const x = c.getContext('2d'), k = Math.max(192 / sw, 108 / sh);
  x.fillStyle = '#111'; x.fillRect(0, 0, 192, 108);
  x.drawImage(src, (192 - sw * k) / 2, (108 - sh * k) / 2, sw * k, sh * k);
  return new Promise(r => c.toBlob(b => r(b ? URL.createObjectURL(b) : ''), 'image/jpeg', .72));
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

function addFiles(files, autoAdd = null){
  let skipped = 0;
  for(const f of files){
    const kind = kindOf(f);
    if(!kind){ skipped++; continue; }
    const m = {id: uid(), file: f, name: f.name, kind, url: URL.createObjectURL(f), duration: 0, w: 0, h: 0, thumbs: [], status: 'loading'};
    media.set(m.id, m);
    probe(m).then(() => { if(autoAdd && m.status === 'ready') addToTimeline(m, autoAdd); });
  }
  if(skipped) toast(skipped === 1 ? '1 arquivo ignorado: não é vídeo, foto nem áudio' : `${skipped} arquivos ignorados: não são vídeo, foto nem áudio`);
  renderMedia();
}
async function probe(m){
  try{
    if(m.kind === 'image'){
      m.img = await loadImg(m.url);
      m.w = m.img.naturalWidth || 1280; m.h = m.img.naturalHeight || 720; m.duration = 5;
      m.thumb = await thumbOf(m.img, m.w, m.h); m.thumbs = [{t: 0, url: m.thumb}];
      m.status = 'ready';
    } else if(m.kind === 'video'){
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = m.url;
      await once(v, 'loadedmetadata', 'error');
      if(!isFinite(v.duration)){ v.currentTime = 1e7; await once(v, 'durationchange', null, 8000).catch(() => {}); }
      m.duration = v.duration; m.w = v.videoWidth; m.h = v.videoHeight;
      if(!m.w){ m.kind = 'audio'; return probeAudio(m); }   // arquivo de vídeo só com som
      if(!isFinite(m.duration) || !m.duration) throw new Error('não deu para saber a duração');
      m.status = 'ready'; renderMedia();
      // tira miniaturas ao longo do vídeo para a tira da timeline
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
  }catch(e){
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
      <div class="mi-thumb${m.kind === 'audio' ? ' wave' : ''}">${img ? `<img src="${img}" alt="">` : KIND_ICON[m.kind].replace('<svg', '<svg class="ph"')}
        ${m.duration && m.kind !== 'image' ? `<span class="mi-dur">${fmtTime(m.duration, false)}</span>` : ''}
        <span class="mi-kind">${KIND_ICON[m.kind]}</span></div>
      <span class="mi-name">${esc(m.name)}</span>
      ${m.status === 'bad' ? `<span class="mi-err">${esc(m.err)}</span>` : ''}
      ${m.status === 'ready' ? `<button class="mi-add" type="button" data-act="add" title="Colocar na timeline" aria-label="Colocar ${esc(m.name)} na timeline"><svg viewBox="0 0 12 12"><path d="M6 2v8M2 6h8"/></svg></button>` : ''}
      <button class="mi-rm" type="button" data-act="rm" title="Remover arquivo" aria-label="Remover ${esc(m.name)}"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>
    </li>`;
  }).join('');
}

// coloca na timeline: vídeo e foto no fim da trilha de vídeo (ou na posição indicada); áudio no fim da trilha de áudio
function addToTimeline(m, opt = {}){
  const c = {id: uid(), mid: m.id, track: m.kind === 'audio' ? 'a' : 'v', in: 0, out: m.duration, speed: 1, volume: 1, muted: false, fit: 'contain'};
  const wasEmpty = !S.clips.length;
  edit(() => {
    if(c.track === 'v'){
      const vs = S.clips.filter(x => x.track === 'v'), i = opt.index ?? vs.length;
      if(i >= vs.length) S.clips.push(c); else S.clips.splice(S.clips.indexOf(vs[i]), 0, c);
      // formato do projeto segue o primeiro vídeo até a pessoa escolher outro
      if(S.ratioAuto && vs.length === 0) S.ratio = m.h > m.w * 1.15 ? (m.h / m.w < 1.5 ? '4:5' : '9:16') : m.w > m.h * 1.15 ? '16:9' : '1:1';
    } else {
      const ends = L().a.map(e => e.end);
      c.start = opt.start ?? (ends.length ? Math.max(...ends) : 0);
      S.clips.push(c);
    }
  });
  sel = c.id;
  // enquanto a pessoa não mexer no zoom, a timeline sempre mostra o vídeo inteiro
  if(wasEmpty || autoFit) zoomFit();
  changed(); sizeScreen();
}

/* ---------- timeline ---------- */
const content = $('#tl-content'), scroller = $('#tl-scroll'), trackV = $('#track-v'), trackA = $('#track-a');
const TILE_W = 104;
function clipHTML(e){
  const c = e.c, m = media.get(c.mid), x = e.start * pps, w = Math.max(3, (e.end - e.start) * pps);
  let inner = '';
  if(c.track === 'v' && m?.thumbs.length){
    const tiles = [];
    for(let px = 0; px < w; px += TILE_W){
      const mt = c.in + (px + TILE_W / 2) / pps * c.speed;
      let best = m.thumbs[0];
      for(const th of m.thumbs) if(Math.abs(th.t - mt) < Math.abs(best.t - mt)) best = th;
      tiles.push(`<span style="width:${Math.min(TILE_W, w - px)}px;background-image:url(${best.url})"></span>`);
    }
    inner = `<div class="strip">${tiles.join('')}</div>`;
  } else if(c.track === 'a' && m?.wave){
    const full = m.duration / c.speed * pps;
    inner = `<div class="wave" style="background-image:url(${m.wave});background-size:${full}px 100%;background-position:${-c.in / c.speed * pps}px 0"></div>`;
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
  const {v, a, total} = L();
  const width = Math.max(scroller.clientWidth, (total + 8) * pps);
  content.style.width = width + 'px';
  renderRuler(width);
  trackV.innerHTML = v.map(clipHTML).join('') || '<span class="track-empty">Arraste vídeos e fotos para cá</span>';
  trackA.innerHTML = a.map(clipHTML).join('') || '<span class="track-empty">Arraste músicas para cá</span>';
  placePlayhead();
  $('#tl-hint').textContent = !S.clips.length ? 'Arraste arquivos para a timeline ou use o + em cada arquivo'
    : sel ? 'Arraste as bordas do clipe para cortar · S divide no cursor · Delete exclui'
    : 'Clique num clipe para editar · arraste para mudar a ordem';
}
function placePlayhead(follow = false){
  const x = t * pps;
  $('#playhead').style.transform = `translateX(${x}px)`;
  if(follow){
    const vw = scroller.clientWidth;
    if(x > scroller.scrollLeft + vw - 40 || x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - 40);
  }
}
const capture = (el, e) => { try{ el.setPointerCapture(e.pointerId); }catch{} };
const xToTime = ev => Math.max(0, (ev.clientX - content.getBoundingClientRect().left) / pps);

// ímã: gruda no cursor, no começo e nas bordas dos outros clipes
function snapPoints(except, track){
  const pts = [0, t], {v, a} = L();
  for(const e of a) if(e.c !== except){ pts.push(e.start, e.end); }
  if(track === 'a') for(const e of v){ pts.push(e.start, e.end); }
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
  if(e.button !== 0) return;
  const clipEl = e.target.closest('.clip');
  if(e.target.closest('#ph-grip, #ruler') || !clipEl){
    if(!clipEl && !e.target.closest('#ph-grip, #ruler') && sel){ sel = null; renderTimeline(); renderProps(); }
    return scrub(e);
  }
  dragClip(e, clipEl);
});
function scrub(e){
  const wasPlaying = playing; if(playing) pause();
  capture(content, e);
  // o cursor gruda nas bordas dos clipes
  const pts = [0, ...L().v.flatMap(x => [x.start, x.end]), ...L().a.flatMap(x => [x.start, x.end])];
  const go = ev => seek(snapOn ? snapTo(xToTime(ev), pts) : xToTime(ev));
  go(e);
  const mv = ev => go(ev);
  const up = () => { content.removeEventListener('pointermove', mv); content.removeEventListener('pointerup', up); content.removeEventListener('pointercancel', up); $('#snap-mark').hidden = true; if(wasPlaying) play(); };
  content.addEventListener('pointermove', mv); content.addEventListener('pointerup', up); content.addEventListener('pointercancel', up);
}
function dragClip(e, el){
  const c = clipById(el.dataset.id); if(!c) return;
  if(sel !== c.id){ sel = c.id; $$('.clip.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); renderProps(); renderTimelineHint(); }
  const h = e.target.closest('.h'), mode = h ? (h.classList.contains('l') ? 'trimL' : 'trimR') : 'move';
  const m = media.get(c.mid), still = m?.kind === 'image', maxOut = still ? 3600 : (m?.duration || c.out);
  const before = snap(), x0 = e.clientX, e0 = entryOf(c), o = {in: c.in, out: c.out, start: e0.start, end: e0.end};
  const pts = snapPoints(c, c.track);
  let moved = false, dropIdx = null;
  capture(content, e);
  const mv = ev => {
    const dx = ev.clientX - x0;
    if(!moved && Math.abs(dx) < 4) return;
    if(!moved && playing) pause();
    moved = true;
    const dt = dx / pps;
    if(mode === 'trimR'){
      const end = snapTo(o.end + dt, pts);
      c.out = clamp(o.in + (end - o.start) * c.speed, o.in + MIN * c.speed, maxOut);
    } else if(mode === 'trimL'){
      if(still){ c.out = clamp(o.out - dt, c.in + MIN, 3600); }
      else if(c.track === 'a'){
        const ns = snapTo(o.start + dt, pts);
        let nin = clamp(o.in + (ns - o.start) * c.speed, 0, o.out - MIN * c.speed);
        if(o.start + (nin - o.in) / c.speed < 0) nin = o.in - o.start * c.speed;
        c.in = nin; c.start = o.start + (nin - o.in) / c.speed;
      } else c.in = clamp(o.in + dt * c.speed, 0, o.out - MIN * c.speed);
    } else if(c.track === 'a'){
      const d = o.end - o.start;
      let ns = Math.max(0, o.start + dt);
      const a1 = snapTo(ns, pts);
      if(a1 !== ns) ns = a1; else { const b1 = snapTo(ns + d, pts); if(b1 !== ns + d) ns = b1 - d; }
      c.start = Math.max(0, ns);
    } else {
      // trilha de vídeo: o clipe acompanha o ponteiro e a marca mostra onde vai entrar
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
function renderTimelineHint(){ $('#tl-hint').textContent = sel ? 'Arraste as bordas do clipe para cortar · S divide no cursor · Delete exclui' : 'Clique num clipe para editar · arraste para mudar a ordem'; }

// soltar arquivos da lista (ou do computador) direto na trilha
const MT = 'application/x-wk-media';
for(const tr of [trackV, trackA]){
  tr.addEventListener('dragover', e => {
    const types = [...e.dataTransfer.types];
    if(!types.includes(MT) && !types.includes('Files')) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    tr.classList.add('over');
    const tt = xToTime(e), mark = $('#drop-mark'); mark.hidden = false;
    if(tr === trackV){
      const {v} = L(), i = v.findIndex(x => tt < (x.start + x.end) / 2);
      mark.style.left = (i < 0 ? L().vEnd : v[i].start) * pps + 'px';
    } else mark.style.left = snapTo(tt, snapPoints(null, 'a')) * pps + 'px';
  });
  tr.addEventListener('dragleave', e => { if(!tr.contains(e.relatedTarget)){ tr.classList.remove('over'); $('#drop-mark').hidden = true; $('#snap-mark').hidden = true; } });
  tr.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    tr.classList.remove('over'); $('#drop-mark').hidden = true; $('#snap-mark').hidden = true;
    const tt = xToTime(e), {v} = L();
    let i = v.findIndex(x => tt < (x.start + x.end) / 2); if(i < 0) i = v.length;
    const opt = tr === trackV ? {index: i} : {start: snapTo(tt, snapPoints(null, 'a'))};
    $('#snap-mark').hidden = true;
    const id = e.dataTransfer.getData(MT);
    if(id){ const m = media.get(id); if(m?.status === 'ready') addToTimeline(m, (m.kind === 'audio') === (tr === trackA) ? opt : {}); }
    else if(e.dataTransfer.files.length) addFiles(e.dataTransfer.files, opt);
  });
}

/* ---------- zoom ---------- */
const PPS_MIN = 4, PPS_MAX = 400;
const ppsToSlider = p => Math.log(p / PPS_MIN) / Math.log(PPS_MAX / PPS_MIN) * 100;
function setPps(p, anchorX = null){
  const old = pps; pps = clamp(p, PPS_MIN, PPS_MAX);
  const ax = anchorX ?? (t * old - scroller.scrollLeft);   // mantém parado o ponto sob o mouse (ou o cursor)
  const at = (scroller.scrollLeft + ax) / old;
  $('#zoom').value = ppsToSlider(pps);
  renderTimeline();
  scroller.scrollLeft = Math.max(0, at * pps - ax);
}
let autoFit = true;
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
const els = new Map();   // um elemento <video>/<audio> por clipe, criado quando precisa
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
// o som de cada clipe passa pelo mixer: controla volume acima de 100% e permite gravar na exportação
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
function applyVol(o, c){
  const v = c.muted ? 0 : c.volume;
  if(o.gain){ o.gain.gain.value = v; o.el.volume = 1; o.el.muted = false; }
  else { o.el.volume = clamp(v, 0, 1); o.el.muted = c.muted; }
}
// libera elementos de clipes apagados e os menos usados (o navegador limita quantos vídeos abertos)
function pruneEls(){
  const alive = new Set(S.clips.map(c => c.id));
  const drop = [...els.entries()].filter(([id]) => !alive.has(id));
  const rest = [...els.entries()].filter(([id]) => alive.has(id)).sort((a, b) => b[1].used - a[1].used);
  drop.push(...rest.slice(10));
  for(const [id, o] of drop){ o.el.pause(); o.el.removeAttribute('src'); o.el.load(); try{ o.node?.disconnect(); }catch{} els.delete(id); }
}
const curEntry = () => { const {v} = L(); return v.find(e => t >= e.start && t < e.end) || (v.length && t >= L().vEnd - 1e-6 && t - L().vEnd < .05 ? v[v.length - 1] : null); };
function syncMedia(paused){
  const {v, a} = L(), keep = new Set(), cur = curEntry();
  let buf = false;
  const handle = (e, isVideo) => {
    const c = e.c, o = getEl(c); if(!o) return;
    keep.add(c.id);
    const el = o.el, want = clamp(c.in + (t - e.start) * c.speed, 0, Math.max(0, (media.get(c.mid)?.duration || 0) - .01));
    applyVol(o, c);
    if(paused || !playing){ if(!el.paused) el.pause(); if(Math.abs(el.currentTime - want) > .02 && !el.seeking) el.currentTime = want; return; }
    el.playbackRate = c.speed;
    if(el.paused){ if(Math.abs(el.currentTime - want) > .06) el.currentTime = want; el.play().catch(() => {}); }
    else if(Math.abs(el.currentTime - want) > .3) el.currentTime = want;
    if(isVideo && (el.readyState < 3 || el.seeking)) buf = true;
  };
  if(cur) handle(cur, true);
  for(const e of a) if(t >= e.start && t < e.end) handle(e, false);
  // deixa o próximo vídeo pronto no ponto de entrada, para a troca não engasgar
  if(cur){
    const nx = v[v.indexOf(cur) + 1], o = nx && getEl(nx.c);
    if(o){ keep.add(nx.c.id); if(!o.el.paused) o.el.pause(); if(Math.abs(o.el.currentTime - nx.c.in) > .05 && !o.el.seeking) o.el.currentTime = nx.c.in; }
  }
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

/* ---------- tela de preview ---------- */
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
// desenha o quadro do instante atual; se o vídeo ainda não carregou, mantém o quadro anterior
function render(ctx, W, H){
  const e = curEntry();
  let src = null, sw = 0, sh = 0;
  if(e){
    const c = e.c, m = media.get(c.mid);
    if(m?.kind === 'image' && m.img){ src = m.img; sw = m.w; sh = m.h; }
    else { const o = els.get(c.id); if(o && o.el.readyState >= 2 && o.el.videoWidth){ src = o.el; sw = o.el.videoWidth; sh = o.el.videoHeight; } else if(m) return false; }
  }
  ctx.fillStyle = S.bg; ctx.fillRect(0, 0, W, H);
  if(src){
    const k = e.c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
  }
  return true;
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
    if(render(sctx, screen.width, screen.height)) dirty = false;
    if(EXP.on) render(EXP.cx, EXP.cv.width, EXP.cv.height);
  }
}
requestAnimationFrame(frame);

function updateTime(){
  $('#tc-now').textContent = fmtTime(t);
  $('#tc-total').textContent = fmtTime(L().total);
}
function updateUi(){
  updateTime();
  const has = S.clips.length > 0, hasV = L().v.length > 0;
  $('#stage-empty').hidden = hasV;
  $('#export-btn').disabled = !L().total;
  $('#undo').disabled = !hist.past.length; $('#redo').disabled = !hist.future.length;
  $('#t-del').disabled = $('#t-dup').disabled = !sel;
  $('#t-split').disabled = !has;
  $('#ratio-badge').textContent = S.ratio;
}

/* ---------- editar clipes ---------- */
function split(){
  const s = sel && clipById(sel), {v, a} = L();
  const inside = e => t > e.start + .04 && t < e.end - .04;
  const targets = s ? [entryOf(s)].filter(inside) : [...v, ...a].filter(inside);
  if(!targets.length){ toast(s ? 'Coloque o cursor em cima do clipe selecionado para dividir' : 'Coloque o cursor em cima de um clipe para dividir'); return; }
  edit(() => {
    for(const e of targets){
      const c = e.c, cut = c.in + (t - e.start) * c.speed;
      const b = {...c, id: uid(), in: cut};
      if(c.track === 'a') b.start = t;
      c.out = cut;
      S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
      if(s) sel = b.id;
    }
  });
}
function del(){
  const c = sel && clipById(sel); if(!c) return;
  edit(() => { S.clips.splice(S.clips.indexOf(c), 1); sel = null; });
}
function duplicate(){
  const c = sel && clipById(sel); if(!c) return;
  const e = entryOf(c), b = {...c, id: uid()};
  if(c.track === 'a') b.start = e.end;
  edit(() => { S.clips.splice(S.clips.indexOf(c) + 1, 0, b); sel = b.id; });
}
$('#t-split').addEventListener('click', split);
$('#t-del').addEventListener('click', del);
$('#t-dup').addEventListener('click', duplicate);
const setSnap = on => { snapOn = on; $('#t-snap').setAttribute('aria-pressed', String(on)); };
$('#t-snap').addEventListener('click', () => { setSnap(!snapOn); toast(snapOn ? 'Ímã ligado' : 'Ímã desligado'); });

/* ---------- propriedades ---------- */
const SPEEDS = [.5, 1, 1.5, 2];
const RATIO_ICON = {'16:9': [26, 15], '9:16': [13, 22], '1:1': [18, 18], '4:5': [16, 20]};
function renderProps(){
  const c = sel && clipById(sel), p = $('#props');
  if(!c){
    const {v, a, total} = L();
    p.innerHTML = `<div class="pane-h"><b>Projeto</b></div><div class="props-body">
      <div class="pr"><div class="pr-h">Formato</div>
        <div class="ratios" id="p-ratio">${Object.keys(RATIOS).map(r => `<button type="button" data-v="${r}" aria-pressed="${S.ratio === r}"><i style="width:${RATIO_ICON[r][0]}px;height:${RATIO_ICON[r][1]}px"></i>${r}</button>`).join('')}</div>
        <p class="hint">${S.ratio === '9:16' ? 'Reels, TikTok e Shorts.' : S.ratio === '16:9' ? 'YouTube, sites e apresentações.' : S.ratio === '1:1' ? 'Feed quadrado.' : 'Feed do Instagram (retrato).'}</p></div>
      <div class="pr"><div class="pr-h">Cor do fundo</div>
        <div class="pr-row"><input type="color" id="p-bg" value="${esc(S.bg)}" aria-label="Cor do fundo"><span class="hint">Aparece nas bordas quando o vídeo não preenche a tela.</span></div></div>
      <div class="pr-stats"><span>Duração</span><b>${fmtTime(total)}</b><span>Clipes de vídeo</span><b>${v.length}</b><span>Clipes de áudio</span><b>${a.length}</b></div>
      <div class="pr-tip"><b>Como usar</b>
        <span>1. Importe vídeos, fotos ou músicas.</span>
        <span>2. Arraste para a timeline (ou clique no +).</span>
        <span>3. Para cortar, arraste a borda do clipe ou pare o cursor no ponto e aperte <kbd>S</kbd>.</span>
        <span>4. Clique em Exportar.</span></div>
    </div>`;
    return;
  }
  const m = media.get(c.mid), e = entryOf(c), still = m?.kind === 'image', sound = m && m.kind !== 'image';
  p.innerHTML = `<div class="pane-h"><b>${c.track === 'a' ? 'Áudio' : still ? 'Foto' : 'Vídeo'}</b><button class="ib" id="p-close" type="button" title="Voltar ao projeto (Esc)" aria-label="Fechar"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
    <div class="props-body">
      <div class="pr-name">${m?.thumb ? `<img src="${m.thumb}" alt="">` : `<span class="ph"></span>`}<div><b title="${esc(m?.name)}">${esc(m?.name || 'arquivo removido')}</b><span>${fmtTime(e.end - e.start)} na timeline</span></div></div>
      ${sound ? `<div class="pr"><div class="pr-h"><label for="p-vol">Volume</label><output id="p-vol-out">${Math.round(c.volume * 100)}%</output></div>
        <input type="range" id="p-vol" min="0" max="200" step="5" value="${Math.round(c.volume * 100)}">
        <label class="chk"><input type="checkbox" id="p-mute"${c.muted ? ' checked' : ''}> Sem som</label></div>` : ''}
      ${!still ? `<div class="pr"><div class="pr-h">Velocidade</div><div class="seg" id="p-speed">${SPEEDS.map(s => `<button type="button" data-v="${s}" aria-pressed="${c.speed === s}">${String(s).replace('.', ',')}×</button>`).join('')}</div></div>` : ''}
      ${c.track === 'v' ? `<div class="pr"><div class="pr-h">Enquadramento</div><div class="seg" id="p-fit"><button type="button" data-v="contain" aria-pressed="${c.fit !== 'cover'}">Mostrar inteiro</button><button type="button" data-v="cover" aria-pressed="${c.fit === 'cover'}">Preencher a tela</button></div></div>` : ''}
      ${still ? `<div class="pr"><div class="pr-h"><label for="p-dur">Duração da foto</label></div><div class="pr-row"><input class="inp" id="p-dur" type="number" min="0.1" max="3600" step="0.5" value="${+(c.out - c.in).toFixed(2)}"><span class="hint">segundos</span></div></div>` : ''}
      <div class="pr-stats"><span>Começa em</span><b>${fmtTime(e.start)}</b><span>Termina em</span><b>${fmtTime(e.end)}</b>${!still ? `<span>Trecho do arquivo</span><b>${fmtTime(c.in)} → ${fmtTime(c.out)}</b>` : ''}</div>
      <div class="pr-acts"><button class="ghost" id="p-split" type="button">Dividir <kbd>S</kbd></button><button class="ghost" id="p-dup" type="button">Duplicar</button><button class="ghost danger" id="p-del" type="button" style="grid-column:1/-1">Excluir clipe</button></div>
    </div>`;
}
$('#props').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  const c = sel && clipById(sel);
  if(b.id === 'p-close'){ sel = null; renderTimeline(); renderProps(); updateUi(); }
  else if(b.id === 'p-split') split();
  else if(b.id === 'p-dup') duplicate();
  else if(b.id === 'p-del') del();
  else if(b.closest('#p-ratio')) edit(() => { S.ratio = b.dataset.v; S.ratioAuto = false; }), sizeScreen();
  else if(b.closest('#p-speed') && c) edit(() => { c.speed = +b.dataset.v; });
  else if(b.closest('#p-fit') && c) edit(() => { c.fit = b.dataset.v; });
});
$('#props').addEventListener('input', e => {
  const c = sel && clipById(sel);
  if(e.target.id === 'p-vol' && c){ live(() => { c.volume = e.target.value / 100; }); $('#p-vol-out').textContent = e.target.value + '%'; syncMedia(!playing); }
  if(e.target.id === 'p-bg') live(() => { S.bg = e.target.value; });
});
$('#props').addEventListener('change', e => {
  const c = sel && clipById(sel);
  if(e.target.id === 'p-vol' || e.target.id === 'p-bg') liveEnd();
  else if(e.target.id === 'p-mute' && c) edit(() => { c.muted = e.target.checked; });
  else if(e.target.id === 'p-dur' && c){ const d = clamp(parseFloat(e.target.value) || 5, MIN, 3600); edit(() => { c.out = c.in + d; }); }
});

/* ---------- arquivos: botões e arrastar ---------- */
const fileIn = $('#file');
$('#import').addEventListener('click', () => fileIn.click());
$('#import2').addEventListener('click', () => fileIn.click());
fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; });
$('#media-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const m = media.get(b.closest('.mi').dataset.mid); if(!m) return;
  if(b.dataset.act === 'add') addToTimeline(m);
  else {
    const used = S.clips.filter(c => c.mid === m.id).length;
    if(used && !confirm(`"${m.name}" está em ${used === 1 ? '1 clipe' : used + ' clipes'} da timeline. Remover mesmo assim?`)) return;
    if(used) edit(() => { S.clips = S.clips.filter(c => c.mid !== m.id); if(sel && !clipById(sel)) sel = null; });
    URL.revokeObjectURL(m.url); m.thumbs.forEach(x => URL.revokeObjectURL(x.url)); if(m.wave) URL.revokeObjectURL(m.wave);
    media.delete(m.id); renderMedia(); changed();
  }
});
$('#media-grid').addEventListener('dblclick', e => { const li = e.target.closest('.mi'); const m = li && media.get(li.dataset.mid); if(m?.status === 'ready' && !e.target.closest('button')) addToTimeline(m); });
$('#media-grid').addEventListener('dragstart', e => {
  const li = e.target.closest('.mi'); if(!li) return;
  e.dataTransfer.setData(MT, li.dataset.mid); e.dataTransfer.effectAllowed = 'copy';
});
// arquivos do computador soltos em qualquer lugar (fora da timeline) entram na lista
const mediaBody = $('#media-drop');
let depth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if(hasFiles(e)){ depth++; mediaBody.classList.add('over'); } });
window.addEventListener('dragleave', e => { if(hasFiles(e) && --depth <= 0){ depth = 0; mediaBody.classList.remove('over'); } });
window.addEventListener('dragover', e => { if(hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => { depth = 0; mediaBody.classList.remove('over'); if(hasFiles(e)){ e.preventDefault(); addFiles(e.dataTransfer.files); } });

/* ---------- transporte ---------- */
$('#play').addEventListener('click', toggle);
$('#to-start').addEventListener('click', () => seek(0));
$('#to-end').addEventListener('click', () => { pause(); seek(L().total); });
$('#frame-back').addEventListener('click', () => { pause(); seek(t - 1 / FPS); });
$('#frame-fwd').addEventListener('click', () => { pause(); seek(t + 1 / FPS); });
$('#fullscreen').addEventListener('click', () => { const w = $('#stage-wrap'); document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen?.(); });
document.addEventListener('fullscreenchange', () => setTimeout(sizeScreen, 50));
screen.addEventListener('click', toggle);

/* ---------- barra do projeto ---------- */
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
  rz.setPointerCapture(e.pointerId); rz.classList.add('drag');
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
  else if(k === 'Escape' && sel){ sel = null; renderTimeline(); renderProps(); updateUi(); }
});

/* ---------- exportar ---------- */
const EXP = {on: false, res: 1080};
function pickMime(){
  if(!window.MediaRecorder) return null;
  return ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || null;
}
function expSize(short){
  const r = RATIOS[S.ratio];
  return r >= 1 ? {w: Math.round(short * r / 2) * 2, h: short} : {w: short, h: Math.round(short / r / 2) * 2};
}
function renderExpSetup(){
  $$('#exp-res button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.v === EXP.res)));
  const mime = pickMime(), {w, h} = expSize(EXP.res);
  $('#exp-info').innerHTML = `<span>Tamanho</span><b>${w} × ${h}</b><span>Duração</span><b>${fmtTime(L().total)}</b><span>Arquivo</span><b>${mime ? (mime.startsWith('video/mp4') ? 'MP4' : 'WebM') : 'não suportado'}</b>`;
  $('#exp-go').disabled = !mime;
}
function showExp(step){ ['setup', 'run', 'done'].forEach(s => { $('#exp-' + s).hidden = s !== step; }); }
$('#export-btn').addEventListener('click', () => { pause(); showExp('setup'); renderExpSetup(); gelOpen($('#exp-dlg')); });
$('#exp-res').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if(b){ EXP.res = +b.dataset.v; renderExpSetup(); } });
$('#exp-cancel').addEventListener('click', () => gelClose($('#exp-dlg')));
$('#exp-x').addEventListener('click', () => { if(EXP.on) stopExport(true); gelClose($('#exp-dlg')); });
$('#exp-close').addEventListener('click', () => gelClose($('#exp-dlg')));
$('#exp-stop').addEventListener('click', () => { stopExport(true); showExp('setup'); renderExpSetup(); });
$('#exp-dl').addEventListener('click', () => { if(EXP.blob) save(EXP.blob, EXP.file); });
$('#exp-go').addEventListener('click', startExport);

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
  const first = L().v[0], o = first && getEl(first.c);
  for(let i = 0; o && i < 50 && (o.el.readyState < 3 || o.el.seeking); i++) await new Promise(r => setTimeout(r, 100));
  if(!EXP.on) return;
  render(EXP.cx, w, h);
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
function finishExport(){ if(!EXP.on) return; EXP.on = false; updateExp(); setTimeout(() => { if(EXP.rec.state !== 'inactive') EXP.rec.stop(); }, 150); }
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
  showExp('done');
  r.saved = true;
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
