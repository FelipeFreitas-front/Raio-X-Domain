// Codificação pesada em segundo plano (AVIF e PNG otimizado), para a página não travar.
// Recebe {id, kind, data, opts} e devolve {id, buf} ou {id, error}.
const LIB = {
  avif: 'https://cdn.jsdelivr.net/npm/@jsquash/avif@2.1.1/encode.js/+esm',
  oxipng: 'https://cdn.jsdelivr.net/npm/@jsquash/oxipng@2.3.0/optimise.js/+esm',
};
const mods = {};
const load = k => mods[k] ||= import(LIB[k]).then(m => m.default);

self.onmessage = async e => {
  const {id, kind, data, opts} = e.data;
  try{
    let buf;
    if(kind === 'avif'){
      const encode = await load('avif');
      buf = await encode(new ImageData(new Uint8ClampedArray(data.buf), data.w, data.h), opts);
    } else if(kind === 'oxipng'){
      const optimise = await load('oxipng');
      buf = await optimise(data.buf, opts);
    } else if(kind === 'ping'){
      buf = new ArrayBuffer(0);
    } else throw new Error('tarefa desconhecida');
    self.postMessage({id, buf}, [buf]);
  } catch(err){
    self.postMessage({id, error: String(err?.message || err)});
  }
};
