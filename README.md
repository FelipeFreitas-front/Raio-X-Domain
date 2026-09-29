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

- WebP, AVIF (codificador de verdade, via WebAssembly), JPG e PNG otimizado
- Qualidade ajustável e peso máximo por imagem (a qualidade baixa sozinha até caber)
- Tamanhos prontos: largura máxima, Instagram, Stories, link compartilhado ou personalizado
- Recortar para preencher (com ponto de enquadramento por foto) ou encaixar inteira com cor de fundo
- Renomeia em ordem (prefixo + número) ou limpa os nomes originais para web
- Mostra peso final e economia; baixa uma a uma ou tudo em .zip
- Aceita arrastar, escolher ou colar (Ctrl+V); reordena arrastando

## Estrutura

- `assets/base.css`: cores, tema claro/escuro e componentes compartilhados
- Bibliotecas carregadas sob demanda de CDN: `@jsquash/avif`, `@jsquash/oxipng` (jsDelivr) e JSZip (cdnjs)
