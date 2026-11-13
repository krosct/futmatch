"""Regras por formato: abertura nos turnos e Rei da Pelada."""
import pytest

from app.domain.king_of_court import compute_state, next_match
from app.domain.matchmaker import MatchmakerService
from app.domain.models import Team

IDS = ["A", "B", "C", "D"]


def jogo(h, a, hs, as_):
    return {"home_team_id": h, "away_team_id": a, "home_score": hs, "away_score": as_, "finished": True}


def times(n):
    return [Team(id=f"t{i}", name=f"T{i}", color="#000") for i in range(1, n + 1)]


# ---- Turno único / Turno e retorno: quem abre ----
@pytest.mark.parametrize("n", [3, 4, 5, 6])
@pytest.mark.parametrize("rounds", [1, 2])
def test_abertura_define_primeiro_jogo_e_mantem_tabela_completa(n, rounds):
    ts = times(n)
    fx = MatchmakerService.generate_round_robin_fixtures(ts, rounds, first_match=("t2", "t1"))
    assert (fx[0].home_team_id, fx[0].away_team_id, fx[0].round_number) == ("t2", "t1", 1)
    assert len(fx) == rounds * n * (n - 1) // 2
    assert [m.id for m in fx] == [f"m_{i}" for i in range(1, len(fx) + 1)]
    pares = {frozenset((m.home_team_id, m.away_team_id)) for m in fx}
    assert len(pares) == n * (n - 1) // 2


def test_abertura_invalida_mantem_ordem_padrao():
    ts = times(4)
    base = MatchmakerService.generate_round_robin_fixtures(ts, 1)
    for bad in [("t1", "t1"), ("t1", "zzz"), (None, None), ("", "t2")]:
        fx = MatchmakerService.generate_round_robin_fixtures(ts, 1, first_match=bad)
        assert [(m.home_team_id, m.away_team_id) for m in fx] == [(m.home_team_id, m.away_team_id) for m in base]


# ---- Rei da Pelada ----
def test_vencedor_fica_perdedor_vai_para_fim_da_fila():
    st = compute_state(IDS, [jogo("A", "B", 2, 0)])
    assert st["court"] == ["A", "C"] and st["queue"] == ["D", "B"]


def test_abertura_escolhida_no_rei():
    assert compute_state(IDS, [], start_pair=["C", "D"])["court"] == ["C", "D"]
    assert compute_state(IDS, [], start_pair=["C", "C"])["court"] == ["A", "B"]


def test_limite_de_vitorias_consecutivas_tira_o_vencedor():
    hist = [jogo("A", "B", 1, 0), jogo("A", "C", 1, 0)]
    st = compute_state(IDS, hist, max_consecutive_wins=2)
    assert st["court"] == ["D", "B"] and st["queue"] == ["C", "A"]
    # zero = nunca sai por vitórias
    assert compute_state(IDS, hist, max_consecutive_wins=0)["court"] == ["A", "D"]


def test_perdedor_fora_do_campo_nao_duplica_na_fila():
    # V x G (V vence) -> campo [V, L], fila [G]; depois G x V com G perdendo (G já está na fila)
    teams = ["V", "G", "L"]
    st = compute_state(teams, [jogo("V", "G", 2, 0), jogo("G", "V", 0, 1)])
    assert sorted(st["court"] + st["queue"]) == sorted(teams)
    assert len(st["queue"]) == len(set(st["queue"]))
    assert st["queue"] == ["G"]


def test_empate_ambos_saem():
    assert compute_state(IDS, [jogo("A", "B", 1, 1)], draw_rule="both")["court"] == ["C", "D"]


@pytest.mark.parametrize("regra,fica", [
    ("fewer_points", "A"), ("fewer_goals", "A"), ("fewer_wins", "A"),
    ("more_points", "C"), ("more_goals", "C"), ("more_wins", "C"),
])
def test_empate_criterios(regra, fica):
    # A vence B 2x0 e empata com C 3x3: A tem 4 pts, 5 gols, 1 vitória; C tem 1 pt, 3 gols, 0 vitórias
    hist = [jogo("A", "B", 2, 0), jogo("A", "C", 3, 3)]
    st = compute_state(IDS, hist, draw_rule=regra)
    assert fica in st["court"]
    assert ("C" if fica == "A" else "A") not in st["court"]


def test_empate_desempata_por_tempo_em_campo():
    # Jogo 1: A 1x1 B (ambos saem) ... com regra de gols iguais: sai quem está há mais jogos
    hist = [jogo("A", "B", 1, 0), jogo("A", "C", 0, 0)]
    # A: 3+1 pts / C: 1 pt -> fewer_points manda C embora
    assert "C" not in compute_state(IDS, hist, draw_rule="fewer_points")["court"]
    # Iguais em tudo (primeiro jogo 1x1): empata, sai o mandante
    st = compute_state(IDS, [jogo("A", "B", 1, 1)], draw_rule="fewer_goals")
    assert st["court"] == ["B", "C"]


def test_regra_invalida_cai_no_padrao():
    assert compute_state(IDS, [jogo("A", "B", 1, 1)], draw_rule="xyz")["court"] == ["C", "D"]


def test_proxima_partida_e_ids_sequenciais():
    ts = times(3)
    m = next_match(ts, [])
    assert (m.id, m.round_number, m.home_team_id, m.away_team_id) == ("m_1", 1, "t1", "t2")
    fx = [{"id": "m_1", "home_team_id": "t1", "away_team_id": "t2", "home_score": 1, "away_score": 0, "finished": True}]
    m2 = next_match(ts, fx)
    assert (m2.id, m2.round_number, m2.home_team_id, m2.away_team_id) == ("m_2", 2, "t1", "t3")
    assert next_match(ts[:1], []) is None


async def test_endpoint_rei_e_validacao(async_client):
    teams = [{"id": f"t{i}", "name": f"T{i}", "players": [{"id": f"p{i}", "name": f"J{i}"}]} for i in range(1, 4)]
    fx = [{"id": "m_1", "home_team_id": "t1", "away_team_id": "t2", "home_score": 2, "away_score": 0, "finished": True}]
    r = await async_client.post("/api/king/next-match", json={"teams": teams, "fixtures": fx})
    body = r.json()
    assert r.status_code == 200
    assert (body["match"]["home_team_id"], body["match"]["away_team_id"]) == ("t1", "t3")
    assert body["queue"] == ["t2"]
    bad = await async_client.post("/api/king/next-match", json={"teams": teams, "draw_rule": "x"})
    assert bad.status_code == 422


async def test_endpoint_turno_com_abertura(async_client):
    teams = [{"id": f"t{i}", "name": f"T{i}", "players": [{"id": f"p{i}", "name": f"J{i}"}]} for i in range(1, 5)]
    r = await async_client.post("/api/generate-schedule", json={"teams": teams, "rounds": 1, "first_home_id": "t3", "first_away_id": "t2"})
    j = r.json()
    assert (j[0]["home_team_id"], j[0]["away_team_id"]) == ("t3", "t2")


async def test_config_das_regras_persiste(async_client):
    code = (await async_client.post("/api/peladas/create", json={"name": "Regras", "password": "senha1"})).json()["code"]
    cfg = {"players_per_team": 5, "match_duration_minutes": 10, "total_rounds": 0, "championship_type": "king",
           "points_win": 3, "points_draw": 1, "first_match_home_id": "team_2", "first_match_away_id": "team_1",
           "king_draw_rule": "fewer_goals", "king_max_consecutive_wins": 3}
    assert (await async_client.post(f"/api/peladas/{code}/sync-state", json={"players": [], "config": cfg})).status_code == 200
    got = (await async_client.get(f"/api/config?pelada_code={code}")).json()
    for k in ("championship_type", "first_match_home_id", "first_match_away_id", "king_draw_rule", "king_max_consecutive_wins"):
        assert got[k] == cfg[k]


# ---- Consistência: times precisam de jogadores, partidas precisam de times ----
from app.domain.state_rules import find_state_inconsistency
from app.domain.championship_integrity import is_modified


def test_time_com_jogador_inexistente_e_rejeitado():
    players = [{"id": "p1", "name": "Ana"}]
    ok = [{"id": "t1", "name": "A", "players": [{"id": "p1", "name": "Ana"}]}]
    bad = [{"id": "t1", "name": "A", "players": [{"id": "x9", "name": "Fantasma"}]}]
    assert find_state_inconsistency(players, ok, []) is None
    assert "Fantasma" in find_state_inconsistency(players, bad, [])


def test_partida_sem_time_e_rejeitada():
    teams = [{"id": "t1", "name": "A", "players": []}]
    assert find_state_inconsistency([], teams, [{"home_team_id": "t1", "away_team_id": "t2"}])
    assert find_state_inconsistency([], [], [{"home_team_id": "t1", "away_team_id": "t2"}])


def test_partida_nova_com_time_sem_jogadores_e_rejeitada():
    from app.domain.state_rules import find_empty_team_in_new_fixtures
    teams = [
        {"id": "t1", "name": "A", "players": [{"id": "p1", "name": "Ana"}]},
        {"id": "t2", "name": "B", "players": []},
    ]
    nova = {"id": "m_new", "home_team_id": "t1", "away_team_id": "t2"}
    assert find_empty_team_in_new_fixtures(teams, [nova], set()) is not None
    assert find_empty_team_in_new_fixtures(teams, [nova], {"m_old"}) is not None
    # Partida já existente (editar/remover) continua permitida mesmo com time vazio
    assert find_empty_team_in_new_fixtures(teams, [nova], {"m_new"}) is None
    ok = {"id": "m_ok", "home_team_id": "t1", "away_team_id": "t1"}
    assert find_empty_team_in_new_fixtures(teams, [ok], set()) is None


async def test_sync_recusa_estado_inconsistente(async_client):
    code = (await async_client.post("/api/peladas/create", json={"name": "Incons", "password": "senha1"})).json()["code"]
    team = {"id": "team_1", "name": "Time 1", "players": [{"id": "px", "name": "Fantasma"}]}
    r = await async_client.post(f"/api/peladas/{code}/sync-state", json={"players": [], "teams": [team]})
    assert r.status_code == 400
    r2 = await async_client.post(f"/api/peladas/{code}/sync-state", json={"fixtures": [{"id": "m_1", "home_team_id": "a", "away_team_id": "b"}]})
    assert r2.status_code == 400


async def test_sync_recusa_partida_nova_com_time_sem_jogadores(async_client):
    code = (await async_client.post("/api/peladas/create", json={"name": "SemJog", "password": "senha1"})).json()["code"]
    ana = {"id": "p1", "name": "Ana"}
    t1 = {"id": "t1", "name": "A", "players": [ana]}
    t2 = {"id": "t2", "name": "B", "players": [{"id": "p2", "name": "Bia"}]}
    players = [ana, {"id": "p2", "name": "Bia"}]
    sync = f"/api/peladas/{code}/sync-state"
    partida = {"id": "m_1", "home_team_id": "t1", "away_team_id": "t2"}

    # Nova partida com time sem jogadores: recusada
    t2_vazio = {**t2, "players": []}
    r = await async_client.post(sync, json={"players": players, "teams": [t1, t2_vazio], "fixtures": [partida]})
    assert r.status_code == 400
    assert "time sem jogadores" in r.json()["detail"]

    # Com jogadores: criada
    assert (await async_client.post(sync, json={"players": players, "teams": [t1, t2], "fixtures": [partida]})).status_code == 200

    # Partida já existente continua editável mesmo se o time esvaziar depois
    assert (await async_client.post(sync, json={"players": [ana], "teams": [t1, t2_vazio], "fixtures": [partida]})).status_code == 200


# ---- [MOD]: edição fora das regras do formato ----
def fx(h, a, hs=0, as_=0, fin=True, i=1):
    return {"id": f"m_{i}", "home_team_id": h, "away_team_id": a, "home_score": hs, "away_score": as_, "finished": fin}


def test_mod_turno_unico():
    ids = ["A", "B", "C"]
    full = [fx("A", "B"), fx("A", "C"), fx("B", "C")]
    assert not is_modified("single", ids, full)
    assert is_modified("single", ids, full[:-1])                 # partida removida
    assert is_modified("single", ids, full + [fx("A", "B")])     # partida repetida
    assert is_modified("single", ids, full + [fx("A", "Z")])     # time inexistente
    assert not is_modified("double", ids, full + full)
    assert is_modified("double", ids, full)
    assert not is_modified("single", ids, [])


def test_mod_rei_da_pelada():
    ids = ["A", "B", "C", "D"]
    ok = [fx("A", "B", 1, 0, i=1), fx("A", "C", 1, 0, i=2)]
    assert not is_modified("king", ids, ok)
    assert is_modified("king", ids, [fx("A", "B", 1, 0, i=1), fx("B", "D", 0, 0, i=2)])
    # resultado editado muda quem deveria jogar a próxima
    assert is_modified("king", ids, [fx("A", "B", 0, 1, i=1), fx("A", "C", 1, 0, i=2)])
    # partida em aberto no meio impede a previsão, sem acusar [MOD]
    assert not is_modified("king", ids, [fx("A", "B", fin=False, i=1), fx("C", "D", i=2)])


def test_formato_livre_nunca_e_mod():
    assert not is_modified("custom", ["A"], [fx("A", "Z")])


async def test_endpoint_check(async_client):
    body = {"championship_type": "single", "team_ids": ["A", "B", "C"], "fixtures": [fx("A", "B")]}
    assert (await async_client.post("/api/championship/check", json=body)).json() == {"modified": True}


# ---- [MOD] por mudança de regras ----
from app.domain.championship_integrity import rules_changed

KING = {"championship_type": "king", "first_match_home_id": None, "first_match_away_id": None,
        "king_draw_rule": "both", "king_max_consecutive_wins": 0}


def test_rules_changed_por_formato():
    assert not rules_changed(None, KING)
    assert not rules_changed(KING, dict(KING))
    assert rules_changed(KING, {**KING, "king_draw_rule": "fewer_goals"})
    assert rules_changed(KING, {**KING, "king_max_consecutive_wins": 3})
    assert rules_changed(KING, {**KING, "first_match_home_id": "t1"})
    assert rules_changed(KING, {**KING, "championship_type": "single"})
    # regra do Rei não importa em turno único
    single = {**KING, "championship_type": "single"}
    assert not rules_changed(single, {**single, "king_draw_rule": "fewer_goals"})


def test_mod_so_com_partida_finalizada():
    ids = ["A", "B", "C"]
    full = lambda fin: [fx("A", "B", fin=fin, i=1), fx("A", "C", fin=False, i=2), fx("B", "C", fin=False, i=3)]
    base = {"championship_type": "single", "first_match_home_id": None, "first_match_away_id": None}
    mudou = {**base, "first_match_home_id": "A"}
    # só partidas em aberto: mudar regra não quebra nada
    assert not is_modified("single", ids, full(False), rules=mudou, rules_baseline=base)
    # com partida finalizada: qualquer mudança de regra marca [MOD]
    assert is_modified("single", ids, full(True), rules=mudou, rules_baseline=base)
    # voltando às regras originais, o [MOD] some
    assert not is_modified("single", ids, full(True), rules=base, rules_baseline=base)
    # sem baseline (pelada antiga) não acusa
    assert not is_modified("single", ids, full(True), rules=mudou, rules_baseline=None)
    # trocar para o formato Livre depois de jogar também conta
    assert is_modified("custom", ids, full(True), rules={**base, "championship_type": "custom"}, rules_baseline=base)


async def test_baseline_persiste_na_config(async_client):
    code = (await async_client.post("/api/peladas/create", json={"name": "Base", "password": "senha1"})).json()["code"]
    cfg = {"players_per_team": 5, "match_duration_minutes": 10, "total_rounds": 1, "championship_type": "single",
           "points_win": 3, "points_draw": 1, "rules_baseline": {"championship_type": "single", "lixo": "x", "first_match_home_id": None}}
    assert (await async_client.post(f"/api/peladas/{code}/sync-state", json={"config": cfg})).status_code == 200
    got = (await async_client.get(f"/api/config?pelada_code={code}")).json()
    assert got["rules_baseline"] == {"championship_type": "single", "first_match_home_id": None}  # chave desconhecida descartada


# ---- Geração de tabela e Rei da Pelada: nunca criar partida com time sem jogadores ----
async def test_gerar_tabela_recusa_time_sem_jogadores(async_client):
    cheio = {"id": "t1", "name": "Alfa", "players": [{"id": "p1", "name": "Ana"}]}
    cheio2 = {"id": "t2", "name": "Beta", "players": [{"id": "p2", "name": "Bia"}]}
    vazio = {"id": "t3", "name": "Gama", "players": []}

    r = await async_client.post("/api/generate-schedule", json={"teams": [cheio, cheio2, vazio], "rounds": 1})
    assert r.status_code == 400
    assert "Gama" in r.json()["detail"]

    ok = await async_client.post("/api/generate-schedule", json={"teams": [cheio, cheio2], "rounds": 1})
    assert ok.status_code == 200 and len(ok.json()) == 1


async def test_rei_recusa_proxima_partida_com_time_sem_jogadores(async_client):
    cheio = {"id": "t1", "name": "Alfa", "players": [{"id": "p1", "name": "Ana"}]}
    cheio2 = {"id": "t2", "name": "Beta", "players": [{"id": "p2", "name": "Bia"}]}
    vazio = {"id": "t3", "name": "Gama", "players": []}

    r = await async_client.post("/api/king/next-match", json={
        "teams": [cheio, vazio, cheio2], "first_home_id": "t1", "first_away_id": "t3"})
    assert r.status_code == 400
    assert "Gama" in r.json()["detail"]

    ok = await async_client.post("/api/king/next-match", json={
        "teams": [cheio, vazio, cheio2], "first_home_id": "t1", "first_away_id": "t2"})
    assert ok.status_code == 200 and ok.json()["match"] is not None
