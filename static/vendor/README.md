# Bibliotecas servidas pelo próprio app

| Arquivo | Versão | Origem |
|---|---|---|
| `lucide.min.js` | 1.61.0 | `unpkg.com/lucide@1.61.0/dist/umd/lucide.min.js` |
| `chart.umd.min.js` | 4.6.1 | `cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.min.js` |
| `confetti.browser.min.js` | 1.6.0 | `cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js` |
| `fonts/outfit-latin-*.woff2` | 5.3.0 (@fontsource/outfit) | npm |

Bibliotecas de PDF (`../html2canvas.min.js` e `../jspdf.umd.min.js`) ficam em `static/`.

## Patch local em `html2canvas.min.js`
A função `Sn` (criação do `<style>` na cópia do documento) foi neutralizada para não violar `style-src 'self'`.
Os estilos computados continuam sendo copiados para os elementos; o PDF gerado foi conferido visualmente
(ver `tests/e2e`). Pseudo-elementos (`::before`/`::after`) do próprio html2canvas não são usados pelo relatório.
Ao atualizar o html2canvas, reaplique esse patch ou revalide o PDF.

## Checksums
`vendor/CHECKSUMS.sha256` registra o SHA-256 dos arquivos vendorizados (e de `css/*.css` gerados).
O teste `test_vendored_assets_match_recorded_checksums` falha se algum deles mudar sem revisão.
Ao atualizar um arquivo de propósito, regrave o registro e rode o E2E (`tests/e2e`), que gera um PDF:

    cd static && sha256sum vendor/lucide.min.js vendor/chart.umd.min.js vendor/confetti.browser.min.js html2canvas.min.js jspdf.umd.min.js css/tailwind.css css/app.css css/ds.css vendor/fonts.css | sed 's|  | |' > vendor/CHECKSUMS.sha256
