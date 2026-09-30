# webkit

Hub de ferramentas gratuitas para quem faz sites. Tudo roda no navegador: sem cadastro, sem servidor e sem enviar arquivos.

| Página | Ferramenta |
|---|---|
| `index.html` | Home do hub |
| `raio-x.html` | Raio-X de domínio |
| `disponibilidade.html` | Disponibilidade de domínio (livre? quanto custa?) |
| `conversor.html` | Conversor de imagens |
| `editor.html` | Editor de vídeo |

## Disponibilidade de domínio

- Aceita uma lista de domínios colada (um por linha, ou separados por vírgula/espaço) e checa todos de uma vez, na ordem colada, com botão para copiar só os livres
- Checa um nome em até 18 extensões ao mesmo tempo (.com.br, .com, .net.br, .dev, .io, .app…) e aceita extensões extras
- Disponibilidade pelo RDAP oficial de cada extensão; sem RDAP, cai para o DNS e marca como "provavelmente livre"
- Preço de registro e de renovação em reais: tabela pública da Porkbun (910 extensões, guardada 24 h) convertida pela cotação do dia (AwesomeAPI); `.br` pelo valor do Registro.br (constante `BR_PRICE` no arquivo)
- Ordena pelo custo de manter (renovação) e avisa quando a renovação é bem mais cara que o primeiro ano
- Sugere variações livres do nome; o botão Registrar leva para a busca de domínio da Hostinger (constante `HOSTINGER_EXTRA` para link de afiliado)
- Link direto: `disponibilidade.html#meusite`

## Raio-X de domínio

Consulta completa de domínio: WHOIS (RDAP), DNS, hospedagem provável, provedor de e-mail, SPF/DMARC/DKIM.

- Onde o domínio está registrado, idade e data de expiração
- Pontos de atenção em português claro (vencimento, www quebrado, falta de DMARC etc.)
- Registros DNS agrupados por finalidade, com exportação (zona BIND, lista legível, CSV, JSON)
- Propagação global (estilo whatsmydns): 11 servidores DNS públicos e 9 cidades, com valor esperado e verificação automática a cada 30 s
- Consultas salvas no navegador por 24 h

Abrir direto um domínio: `raio-x.html#exemplo.com.br` (links antigos `index.html#dominio` redirecionam).

## Conversor de imagens

Modo simples: um botão para escolher as imagens, e cada linha da lista tem o formato de saída (WebP, AVIF, JPG ou PNG, por imagem ou para todas), o botão Converter e depois Baixar. Na primeira conversão um popup pergunta se os nomes ficam como estão ou são padronizados (`fachada-casa-1.webp`…).

Modo avançado (recolhido):

- **Converter:** qualidade, tamanho (site, Instagram, Stories, link compartilhado ou personalizado, com recorte ou encaixe), peso máximo por imagem e marca d'água (texto ou logo)
- **Kit responsivo:** cada imagem em várias larguras e formatos (AVIF, WebP, JPG) com o código `<picture>` pronto
- **Favicon:** de um logo, gera `favicon.ico` (16/32/48), PNGs, ícone do iPhone, ícones Android, `site.webmanifest` e o código do `<head>`
- Menu ⋯ em cada imagem: comparar antes e depois, escolher o recorte, girar, espelhar, copiar como data URI

Também aceita HEIC do iPhone, remove a localização GPS das fotos e baixa tudo em .zip. AVIF e PNG otimizado rodam em segundo plano (Web Worker).

## Editor de vídeo

Editor simples no estilo do [OpenCut](https://github.com/OpenCut-app/OpenCut): arquivos à esquerda, preview no centro, propriedades à direita e timeline embaixo.

- Importa vídeos, fotos e músicas (arrastar ou escolher), com miniatura, duração e forma de onda
- Biblioteca em abas:
  - **Músicas e efeitos sonoros** do [Openverse](https://openverse.org) (músicas do Jamendo, efeitos do Freesound), só com licenças que permitem uso comercial e edição; prévia antes de usar e créditos prontos para copiar na exportação
  - **Elementos**: emojis, figurinhas, ícones e logos de redes sociais do [Iconify](https://iconify.design) (coleções MIT, Apache ou CC0), coloridos ou em uma cor
  - **Texto**: 8 estilos prontos (Título, Subtítulo, Legenda, Destaque, Neon, Elegante, Manuscrito, Etiqueta) com fonte, peso, cor, alinhamento, contorno, caixa de fundo, sombra/neon e animação de entrada e saída (aparecer, subir, pop, máquina de escrever); dois cliques no texto do preview vão direto para a edição
  - **Legendas**: cole o texto (uma legenda por linha) e elas são espalhadas no vídeo ou no clipe selecionado, numa trilha "Legendas"; importa e baixa `.srt`
  - **Transições**: Dissolver, Preto, Flash, Deslizar, Subir, Zoom, Cortina e Círculo, com duração ajustável
- Tela cheia, sem o topo do site: só uma seta ao lado do nome do projeto para voltar à home
- Trilhas: começa com a de vídeo principal (magnética, os clipes ficam colados) e uma de áudio. "+ Trilha" cria quantas quiser: a trilha nasce genérica e vira de vídeo (por cima da principal) ou de áudio conforme o primeiro arquivo solto nela
- Timeline estilo CapCut: qualquer clipe sobe ou desce de trilha (da principal para cima e de volta, entre trilhas de áudio); soltar na faixa fina do topo ou do fim cria uma trilha nova
- Cada trilha tem cadeado (trava os clipes), olho (esconde do vídeo), alto-falante (muta a trilha toda) e menu ⋯ (renomear, volume e efeitos, subir, descer, excluir); dois cliques no nome renomeiam
- Mixer estilo FL Studio: um canal por trilha + Master, com medidor, fader, pan, mudo (M) e solo (S); rack com até 8 efeitos por canal (EQ 3 bandas com curva, Filtro, Compressor, Reverb, Delay, Distorção e Limitador), ligar/desligar, ordem e parâmetros. Tudo entra na exportação
- Seleção múltipla: arrastar num espaço vazio da timeline desenha um retângulo; Shift/Ctrl + clique soma; Ctrl+A seleciona tudo. Com vários selecionados, arrastar move todos juntos, Delete exclui e S divide
- No preview: clique no vídeo (principal ou das trilhas de cima) e arraste para mover; os 4 cantos aumentam ou diminuem. Guias de centro, rotação, opacidade, 9 posições prontas e "Resetar"
- Transição de áudio: entrada e saída suave do som em cada clipe (bolinhas no topo do clipe ou controles no painel), e um botão para suavizar todas as músicas
- Transição no losango entre dois clipes (ou arrastando da aba); o som cruza junto
- Cortar pelas bordas do clipe, dividir no cursor (`S`), duplicar, excluir, reordenar arrastando, ímã nas bordas e no cursor
- O vídeo termina onde acaba a imagem: música mais longa é cortada no fim
- Volume até 200%, sem som, velocidade (0,5× a 2×), "mostrar inteiro" ou "preencher a tela", duração de cada foto
- Formatos 16:9, 9:16 (Reels/TikTok), 1:1 e 4:5, com cor de fundo
- Desfazer e refazer, zoom da timeline (Ctrl + rodinha), altura da timeline ajustável, atalhos de teclado
- Exporta em HD ou Full HD: MP4 no Chrome/Edge, WebM onde não houver MP4. A gravação é em tempo real (MediaRecorder), então a aba precisa ficar aberta e visível até terminar

## Estrutura

- `assets/base.css`: cores, tema claro/escuro e componentes compartilhados
- `assets/motion.css`: tela de carregamento, entrada suave e efeito gelatinoso de popups e avisos
- `assets/conversor.js`: lógica do conversor
- `assets/encoder-worker.js`: AVIF e PNG otimizado em segundo plano
- `assets/editor.js` e `assets/editor.css`: editor de vídeo
- Bibliotecas carregadas sob demanda de CDN: `@jsquash/avif`, `@jsquash/oxipng`, `heic2any` (jsDelivr) e JSZip (cdnjs)
- O processamento em segundo plano precisa da página servida por http(s) (GitHub Pages, Vercel etc.). Aberto como arquivo local, o conversor funciona igual, só que na própria página.
