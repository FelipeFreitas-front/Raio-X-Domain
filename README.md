# raio-x

Consulta completa de domínio direto no navegador: WHOIS (RDAP), DNS, hospedagem provável, provedor de e-mail, SPF/DMARC/DKIM e propagação.

## Como usar

Abra o `index.html` no navegador (ou publique no GitHub Pages) e digite um domínio, uma URL ou um e-mail.

Também dá para abrir direto um domínio pelo endereço: `index.html#exemplo.com.br`.

## O que mostra

- Onde o domínio está registrado, idade e data de expiração
- Hospedagem provável e dono do IP
- Provedor de e-mail e checagem de SPF, DMARC e DKIM
- Registros DNS agrupados por finalidade (site, e-mail, nameservers, TXT)
- Pontos de atenção em português claro (vencimento, www quebrado, falta de DMARC etc.)
- Propagação global (estilo whatsmydns): 11 servidores DNS públicos em vários países e 9 cidades simuladas via Google, com valor esperado e verificação automática a cada 30 s até propagar

## Exportação

- Lista legível para colar em WhatsApp ou e-mail
- Arquivo de zona BIND (importável na Cloudflare, Hostinger, cPanel, Route 53)
- Planilha CSV e JSON

## Como funciona

Um único arquivo HTML, sem servidor e sem chave de API. Usa o RDAP (via bootstrap da IANA) e o DNS-over-HTTPS do Google e da Cloudflare. As consultas ficam salvas no navegador por 24 h.
