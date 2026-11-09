from datetime import datetime
from typing import Iterable, Optional

# Formato em que as peladas guardam created_at (horário de Brasília)
PELADA_CREATED_AT_FORMAT = "%d/%m/%Y %H:%M:%S"
PELADA_DATE_DISPLAY_FORMAT = "%d/%m/%Y"

def earliest_pelada_date(created_at_values: Iterable[str]) -> Optional[str]:
    """Retorna a data (dd/mm/aaaa) da pelada mais antiga da corrente, ou None se não houver datas válidas."""
    parsed = []
    for raw in created_at_values:
        try:
            parsed.append(datetime.strptime(raw, PELADA_CREATED_AT_FORMAT))
        except (TypeError, ValueError):
            continue
    if not parsed:
        return None
    return min(parsed).strftime(PELADA_DATE_DISPLAY_FORMAT)
