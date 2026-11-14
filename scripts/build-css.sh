#!/usr/bin/env bash
# Regenera static/css/tailwind.css (CSS do Tailwind compilado e versionado).
# Uso:  scripts/build-css.sh           recompila
#       scripts/build-css.sh --check   falha se faltar alguma classe usada no HTML/JS (usado no CI)
# Só roda em desenvolvimento/CI: a VPS recebe o CSS já compilado e não precisa de Node.
set -euo pipefail
cd "$(dirname "$0")/.."

TAILWIND="tailwindcss@3.4.19"
OUT="static/css/tailwind.css"
build() { npx --yes "$TAILWIND" -c tailwind.config.js -i static/css/tailwind.input.css -o "$1" --minify >/dev/null 2>&1; }

if [[ "${1:-}" != "--check" ]]; then
  build "$OUT"
  # O hash do CSS fica registrado em static/lib/CHECKSUMS.sha256 (um teste confere); regrava junto
  python3 - "$OUT" <<'PY'
import hashlib, re, sys
novo = hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()
arq = "static/lib/CHECKSUMS.sha256"
txt = open(arq, encoding="utf-8").read()
txt = re.sub(r"^[0-9a-f]{64}( css/tailwind\.css)$", novo + r"\1", txt, flags=re.M)
open(arq, "w", encoding="utf-8").write(txt)
PY
  echo "CSS atualizado: $OUT (checksum regravado)"
  exit 0
fi

TMP="$(mktemp --suffix=.css)"
trap 'rm -f "$TMP"' EXIT
build "$TMP"
# Compara as classes (seletores) e não os bytes: prefixos de navegador podem variar entre máquinas
python3 - "$OUT" "$TMP" <<'PY'
import re, sys
sel = lambda path: set(re.findall(r'\.((?:\\.|[A-Za-z0-9_-])+)', open(path, encoding="utf-8").read()))
atual, esperado = sel(sys.argv[1]), sel(sys.argv[2])
faltam, sobram = sorted(esperado - atual), sorted(atual - esperado)
if sobram:
    print("Aviso: classes no CSS que ninguém usa mais:", ", ".join(sobram))
if faltam:
    print("Classes usadas sem regra no CSS:", ", ".join(faltam))
    print("Rode: scripts/build-css.sh")
    sys.exit(1)
print("CSS do Tailwind em dia.")
PY
