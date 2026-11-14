"""Arrastar partidas na tabela: [MOD] reage à movimentação e a dica aponta onde o formato se mantém."""
from dataclasses import asdict

import pytest

from app.domain.championship_integrity import is_modified
from app.domain.fixture_moves import mover_partida, trocar_partidas, valid_drop_targets
from app.domain.king_of_court import plan_next
from app.domain.matchmaker import MatchmakerService
from app.domain.models import Team


def tabela(n, rounds=1):
    teams = [Team(id=f"t{i}", name=f"T{i}", color="#000") for i in range(1, n + 1)]
    matches = MatchmakerService.generate_round_robin_fixtures(teams, rounds=rounds)
    return [asdict(m) for m in matches], [t.id for t in teams]


def ids_rodada(fixtures, rodada):
    return [f["id"] for f in fixtures if f["round_number"] == rodada]


# ---- Turno único: troca e mover ----
@pytest.mark.parametrize("n", [4, 5, 6])
def test_tabela_gerada_nao_e_mod(n):
    fx, ids = tabela(n)
    assert not is_modified("single", ids, fx)


def test_troca_entre_rodadas_quebra_o_formato_e_reverter_some_o_mod():
    fx, ids = tabela(4)
    a, b = ids_rodada(fx, 1)[0], ids_rodada(fx, 3)[0]
    # Partida de outra rodada cai numa rodada que já tem os dois times: time repetido
    trocada = trocar_partidas(fx, a, b)
    assert is_modified("single", ids, trocada)
    # Reverter a troca volta à tabela original e o [MOD] some
    assert not is_modified("single", ids, trocar_partidas(trocada, a, b))


def test_turno_e_retorno_troca_com_jogo_de_volta_preserva_formato():
    fx, ids = tabela(4, rounds=2)
    a = fx[0]
    volta = next(f for f in fx if f["id"] != a["id"]
                 and {f["home_team_id"], f["away_team_id"]} == {a["home_team_id"], a["away_team_id"]})
    assert volta["round_number"] != a["round_number"]
    assert not is_modified("double", ids, trocar_partidas(fx, a["id"], volta["id"]))


def test_mover_para_rodada_com_o_mesmo_time_quebra_o_formato():
    fx, ids = tabela(4)
    origem = next(f for f in fx if f["round_number"] == 1)
    # Rodada 2 tem partidas com todos os times: qualquer time repetido quebra a rodada
    destino = 2
    quebrada = mover_partida(fx, origem["id"], destino)
    assert is_modified("single", ids, quebrada)
    # Desfazer (voltar para a rodada original) faz o [MOD] sumir
    assert not is_modified("single", ids, mover_partida(quebrada, origem["id"], 1))


def test_mover_partida_que_esvazia_rodada_quebra_o_formato():
    fx, ids = tabela(3)  # 3 times: cada rodada tem 1 partida
    # Esvaziar a rodada 1 deixa buraco na numeração
    quebrada = mover_partida(fx, ids_rodada(fx, 1)[0], 2)
    assert is_modified("single", ids, quebrada)


def test_partidas_sem_round_number_nao_viram_mod():
    # Tabelas antigas, sem round_number, continuam sem [MOD] pela regra de rodadas
    ids = ["A", "B", "C", "D"]
    legado = [{"id": "m_1", "home_team_id": "A", "away_team_id": "B"},
              {"id": "m_2", "home_team_id": "C", "away_team_id": "D"},
              {"id": "m_3", "home_team_id": "A", "away_team_id": "C"},
              {"id": "m_4", "home_team_id": "B", "away_team_id": "D"},
              {"id": "m_5", "home_team_id": "A", "away_team_id": "D"},
              {"id": "m_6", "home_team_id": "B", "away_team_id": "C"}]
    assert not is_modified("single", ids, legado)


# ---- Dicas: onde soltar sem quebrar ----
def test_dicas_turno_unico_apontam_so_a_rodada_original():
    # Com rodadas completas (4 e 6 times), nenhuma troca ou movimento entre rodadas mantém o formato:
    # a dica fica só na rodada onde a partida deveria estar
    for n in (4, 6):
        fx, ids = tabela(n)
        origem = next(f for f in fx if f["round_number"] == 1)
        dica = valid_drop_targets("single", ids, fx, origem["id"])
        assert dica == {"cards": [], "rounds": [1]}
        for r in {f["round_number"] for f in fx}:
            assert (r in dica["rounds"]) == (not is_modified("single", ids, mover_partida(fx, origem["id"], r)))
        for f in fx:
            if f["round_number"] != 1:
                assert (f["id"] in dica["cards"]) == (not is_modified("single", ids, trocar_partidas(fx, origem["id"], f["id"])))


def test_dicas_turno_e_retorno_incluem_o_jogo_de_volta():
    fx, ids = tabela(4, rounds=2)
    a = fx[0]
    volta = next(f for f in fx if f["id"] != a["id"]
                 and {f["home_team_id"], f["away_team_id"]} == {a["home_team_id"], a["away_team_id"]})
    dica = valid_drop_targets("double", ids, fx, a["id"])
    assert volta["id"] in dica["cards"]
    assert a["round_number"] in dica["rounds"]


def test_dicas_rei_da_pelada_trocas_validas():
    teams = [Team(id=t, name=t, color="#000") for t in "ABCD"]
    fx = []
    for i in range(1, 5):
        match, _queue = plan_next(teams, fx, draw_rule="both")
        fx.append({**asdict(match), "finished": True, "home_score": 1, "away_score": 0, "round_number": i,
                   "id": f"m_{i}"})
    ids = list("ABCD")
    # Rei: trocar a ordem de partidas pode quebrar a sequência; a dica só aponta trocas que não quebram
    dica = valid_drop_targets("king", ids, fx, "m_1", draw_rule="both")
    for f in fx:
        if f["id"] == "m_1":
            continue
        valida = not is_modified("king", ids, trocar_partidas(fx, "m_1", f["id"]), draw_rule="both")
        assert (f["id"] in dica["cards"]) == valida


def test_formato_livre_nao_tem_dica():
    fx = [{"id": "m_1", "home_team_id": "A", "away_team_id": "B", "round_number": 1, "finished": False}]
    assert valid_drop_targets("custom", ["A", "B"], fx, "m_1") == {"cards": [], "rounds": []}


# ---- Endpoint ----
async def test_endpoint_drop_targets(async_client):
    fx, ids = tabela(4)
    body = {"championship_type": "single", "team_ids": ids, "fixtures": fx,
            "moved_id": fx[0]["id"]}
    r = await async_client.post("/api/championship/drop-targets", json=body)
    assert r.status_code == 200
    assert set(r.json()) == {"cards", "rounds"}
    assert r.json() == valid_drop_targets("single", ids, fx, fx[0]["id"])


async def test_endpoint_check_recebe_round_number(async_client):
    fx, ids = tabela(4)
    quebrada = mover_partida(fx, fx[0]["id"], 2)
    body = {"championship_type": "single", "team_ids": ids, "fixtures": quebrada}
    assert (await async_client.post("/api/championship/check", json=body)).json() == {"modified": True}
    body["fixtures"] = fx
    assert (await async_client.post("/api/championship/check", json=body)).json() == {"modified": False}


def test_troca_no_turno_e_retorno_2x2_mantem_os_slots():
    # Caso relatado: 2 partidas por rodada; soltar a partida do slot 2 no slot 4 troca só esses dois
    fx = [{"id": "m_1", "round_number": 1, "home_team_id": "A", "away_team_id": "B"},
          {"id": "m_2", "round_number": 1, "home_team_id": "C", "away_team_id": "D"},
          {"id": "m_3", "round_number": 2, "home_team_id": "A", "away_team_id": "C"},
          {"id": "m_4", "round_number": 2, "home_team_id": "B", "away_team_id": "D"}]
    trocada = trocar_partidas(fx, "m_2", "m_4")
    assert [f["id"] for f in trocada] == ["m_1", "m_4", "m_3", "m_2"]
    assert [f["round_number"] for f in trocada] == [1, 1, 2, 2]
    # Trocar de volta devolve a tabela original
    assert trocar_partidas(trocada, "m_2", "m_4") == fx
