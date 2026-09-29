# Ferramentas Web

Hub de ferramentas gratuitas para quem faz sites. Tudo roda no navegador: sem cadastro, sem servidor e sem enviar arquivos.

| Página | Ferramenta |
|---|---|
| `index.html` | Home do hub |
| `raio-x.html` | Raio-X de domínio |
| `conversor.html` | Conversor de imagens |

## Raio-X de domínio

Consulta completa de domínio: WHOIS (RDAP), DNS, hospedagem provável, provedor de e-mail, SPF/DMARC/DKIM.

- Onde o domínio está registrado, idade e data de expiração
- Pontos de atenção em português claro (vencimento, www quebrado, falta de DMARC etc.)
- Registros DNS agrupados por finalidade, com exportação (zona BIND, lista legível, CSV, JSON)
- Propagação global (estilo whatsmydns): 11 servidores DNS públicos e 9 cidades, com valor esperado e verificação automática a cada 30 s
- Consultas salvas no navegador por 24 h

Abrir direto um domínio: `raio-x.html#exemplo.com.br` (links antigos `index.html#dominio` redirecionam).

## Conversor de imagens

Três modos:

- **Converter:** WebP, AVIF (codificador de verdade, via WebAssembly), JPG e PNG otimizado. Qualidade ajustável, peso máximo por imagem, tamanhos prontos (site, Instagram, Stories, link compartilhado ou personalizado), recortar com ponto de enquadramento ou encaixar com cor de fundo.
- **Kit responsivo:** cada imagem em várias larguras e formatos (AVIF, WebP, JPG) com o código `<picture>` pronto (srcset, sizes, width/height, lazy).
- **Favicon:** de um logo, gera `favicon.ico` (16/32/48), PNGs, ícone do iPhone, ícones Android, `site.webmanifest` e o código do `<head>`.

Também:

- Aceita HEIC do iPhone (decodificado no navegador), além de JPG, PNG, WebP, AVIF, GIF, BMP e SVG
- AVIF e PNG otimizado rodam em segundo plano (Web Worker), sem travar a página
- Marca d'água em lote (texto ou logo, 9 posições, tamanho e opacidade)
- Comparar antes e depois com barra deslizante
- Girar e espelhar cada foto; copiar como data URI
- Perfis de configuração salvos no navegador
- Avisa quando a foto tinha localização GPS (removida na conversão)
- Renomeia em ordem ou limpa os nomes para web; baixa uma a uma ou tudo em .zip
- Arrastar, escolher ou colar (Ctrl+V); reordena arrastando; barra de ação fixa no celular

## Estrutura

- `assets/base.css`: cores, tema claro/escuro e componentes compartilhados
- `assets/conversor.js`: lógica do conversor
- `assets/encoder-worker.js`: AVIF e PNG otimizado em segundo plano
- Bibliotecas carregadas sob demanda de CDN: `@jsquash/avif`, `@jsquash/oxipng`, `heic2any` (jsDelivr) e JSZip (cdnjs)
- O processamento em segundo plano precisa da página servida por http(s) (GitHub Pages, Vercel etc.). Aberto como arquivo local, o conversor funciona igual, só que na própria página.
