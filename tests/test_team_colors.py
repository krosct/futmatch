import os
import re

import pytest

from app.domain.team_colors import TEAM_COLORS, is_team_color

@pytest.fixture
async def client(async_client):
    """Cliente com cookies e banco temporário isolado (mesmo fixture de async_client)."""
    return async_client


CSS_PATH = os.path.join(os.path.dirname(__file__), "..", "static", "css", "ds.css")


def test_domain_palette_has_unique_colors_and_labels():
    colors = [c["color"] for c in TEAM_COLORS]
    labels = [c["label"] for c in TEAM_COLORS]
    assert len(set(colors)) == len(colors)
    assert len(set(labels)) == len(labels)
    assert all(re.fullmatch(r"#[0-9a-f]{6}", c) for c in colors)


def test_is_team_color_is_case_insensitive_and_strict():
    assert is_team_color("#F0ABFC")
    assert not is_team_color("#e2e8f0")  # branco saiu da paleta
    assert not is_team_color("#123456")


@pytest.mark.asyncio
async def test_pelada_info_exposes_domain_palette(client):
    code = (await client.post("/api/peladas/create", json={"name": "Cores", "password": "senha1"})).json()["code"]
    info = (await client.get(f"/api/peladas/{code}")).json()
    assert info["team_colors"] == list(TEAM_COLORS)


@pytest.mark.asyncio
async def test_sync_accepts_only_domain_palette(client):
    code = (await client.post("/api/peladas/create", json={"name": "Cores", "password": "senha1"})).json()["code"]
    magenta = [{"id": "team_1", "name": "Magenta", "color": "#F0ABFC", "players": []}]
    assert (await client.post(f"/api/peladas/{code}/sync-state", json={"teams": magenta})).status_code == 200
    branco = [{"id": "team_1", "name": "Branco", "color": "#e2e8f0", "players": []}]
    assert (await client.post(f"/api/peladas/{code}/sync-state", json={"teams": branco})).status_code == 422


def test_every_palette_color_has_css_class_in_each_dynamic_prefix():
    """Cada cor da paleta precisa de classe em ds.css em todo prefixo ds-XXXXXXXX que a usa (o CSS ainda não é gerado da paleta)."""
    with open(CSS_PATH, encoding="utf-8") as fh:
        css = fh.read()
    hexes = [c["color"][1:] for c in TEAM_COLORS]
    prefixes = {p for p in re.findall(r"\.(ds-[0-9a-f]{8})-[0-9a-f]{6}\s*\{", css)
                if any(f".{p}-{h} {{" in css for h in hexes)}
    assert prefixes
    for prefix in prefixes:
        faltando = [h for h in hexes if f".{prefix}-{h} {{" not in css]
        assert not faltando, f"{prefix} sem cor(es) {faltando}"
