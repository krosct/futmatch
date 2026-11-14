"""Paleta única de cores de time: fonte da verdade do domínio.

Os adaptadores (validação HTTP, endpoint de info da pelada e frontend) leem daqui.
Cada cor precisa ter classes correspondentes em static/css/ds.css (ver teste de consistência).
"""

TEAM_COLORS = (
    {"color": "#84cc16", "label": "Verde"},
    {"color": "#f97316", "label": "Laranja"},
    {"color": "#3b82f6", "label": "Azul"},
    {"color": "#ef4444", "label": "Vermelho"},
    {"color": "#eab308", "label": "Amarelo"},
    {"color": "#64748b", "label": "Preto"},
    {"color": "#a855f7", "label": "Roxo"},
    {"color": "#f0abfc", "label": "Magenta"},
)

TEAM_COLOR_HEXES = frozenset(c["color"] for c in TEAM_COLORS)


def is_team_color(value: str) -> bool:
    return value.lower() in TEAM_COLOR_HEXES
