// Movimento compartilhado do hub: tira a tela de carregamento, mostra ela de novo ao trocar de página
// e faz os blocos entrarem suavemente quando aparecem na tela.
(function(){
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MIN_SHOW = 350; // a tela de carregamento fica pelo menos isso, para não piscar
  const shownAt = performance.now();

  function hideLoader(){
    const wait = Math.max(0, MIN_SHOW - (performance.now() - shownAt));
    setTimeout(() => { root.classList.remove('pl-on'); startReveal(); }, reduced ? 0 : wait);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideLoader);
  else hideLoader();

  // voltar pelo navegador reabre a página do cache: garante que a tela não fique presa
  addEventListener('pageshow', e => { if(e.persisted) root.classList.remove('pl-on'); });

  // ao clicar num link para outra página do site, mostra a tela antes de ir
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if(!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if(a.target && a.target !== '_self' || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if(url.origin !== location.origin) return;
    if(url.pathname === location.pathname && url.search === location.search) return; // só âncora na mesma página
    e.preventDefault();
    root.classList.add('pl-on');
    setTimeout(() => { location.href = url.href; }, reduced ? 0 : 260);
  });

  // entrada suave
  const SELECTOR = [
    '[data-reveal]', '.sec-head', '.tool', '.case', '.privacy', '.faq details', '.cta', '.ticker', 'footer.site',
    '.cv-head', '.drop', '.privacy-note', '.side', '.hero .wordmark', '.hero .tag', '.hero .search', '.examples',
  ].join(',');
  let started = false;
  function startReveal(){
    if(started || reduced || !('IntersectionObserver' in window)) return;
    started = true;
    const els = [...document.querySelectorAll(SELECTOR)].filter(el => !el.closest('[hidden]') && !el.closest('.rv'));
    els.forEach(el => el.classList.add('rv'));
    const io = new IntersectionObserver(entries => {
      // quem entra junto aparece em sequência, com um pequeno intervalo
      entries.filter(en => en.isIntersecting).forEach((en, i) => {
        const el = en.target;
        el.style.transitionDelay = (i * 80) + 'ms';
        el.classList.add('rv-in');
        io.unobserve(el);
        el.addEventListener('transitionend', function done(ev){
          if(ev.propertyName !== 'transform') return;
          el.classList.remove('rv', 'rv-in'); el.style.transitionDelay = '';
          el.removeEventListener('transitionend', done);
        });
      });
    }, {threshold: .12, rootMargin: '0px 0px -40px 0px'});
    els.forEach(el => io.observe(el));
    // garantia: o que já está na tela nunca fica invisível, mesmo que o observador falhe
    setTimeout(() => els.forEach(el => {
      if(el.classList.contains('rv') && !el.classList.contains('rv-in') && el.getBoundingClientRect().top < innerHeight){
        el.classList.remove('rv'); el.style.transitionDelay = '';
      }
    }), 2500);
  }
})();
