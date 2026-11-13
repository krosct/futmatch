"""Grafo de pools entre peladas (domínio puro, sem banco nem HTTP).

Cada pelada pode apontar para várias peladas anteriores (pools). Vários caminhos podem chegar à mesma
pelada (ex.: A<-B, A<-C, B<-D, C<-D), e um ciclo de vínculos nunca pode duplicar métricas. Por isso todo
percurso devolve cada código uma única vez, mesmo com ciclo ou caminhos repetidos.
"""
from collections import deque
from typing import Dict, Iterable, List

# Limite de pools diretas por pelada (validação de entrada e de importação)
MAX_POOLS_POR_PELADA = 10


def pool_chain(start: str, parents: Dict[str, Iterable[str]]) -> List[str]:
    """Peladas alcançáveis a partir de `start` (incluindo ele), em ordem de largura, sem repetição.

    `parents` mapeia cada código para os códigos das peladas anteriores diretas. Ciclos são seguros:
    cada nó entra na fila no máximo uma vez.
    """
    ordem: List[str] = []
    vistos = set()
    fila = deque([start])
    while fila:
        atual = fila.popleft()
        if atual in vistos:
            continue
        vistos.add(atual)
        ordem.append(atual)
        for pai in parents.get(atual, ()):
            if pai not in vistos:
                fila.append(pai)
    return ordem
