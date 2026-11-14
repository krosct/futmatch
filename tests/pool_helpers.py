"""Helpers para vincular peladas à pool simulando a janela de vínculo do admin."""


async def vincular_pool(client, atual: str, anterior: str):
    """Vincula `atual` a `anterior` ligando cada jogador ao homônimo da pool (como o modal faria)."""
    info = (await client.get(f"/api/peladas/{atual}")).json()
    candidatos = (await client.get(f"/api/peladas/{atual}/pool-candidates", params={"parent_code": [anterior]})).json()["candidates"]
    por_nome = {c["name"].strip().lower(): c["id"] for c in candidatos}
    links = [{"player_id": p["id"], "pool_player_id": por_nome[p["name"].strip().lower()]}
             for p in info["players"] if p["name"].strip().lower() in por_nome]
    return await client.post(f"/api/peladas/{atual}/pool", json={"parent_codes": [anterior], "links": links})
