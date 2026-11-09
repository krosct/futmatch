from app.domain.pool import earliest_pelada_date

def test_earliest_pelada_date_picks_oldest_and_formats_date():
    values = ["15/03/2026 20:00:00", "02/01/2026 09:30:00", "20/02/2026 18:00:00"]
    assert earliest_pelada_date(values) == "02/01/2026"

def test_earliest_pelada_date_compares_chronologically_not_textually():
    # "31/12/2025" < "01/02/2026" cronologicamente, mesmo com texto "31" > "01"
    values = ["01/02/2026 10:00:00", "31/12/2025 23:59:59"]
    assert earliest_pelada_date(values) == "31/12/2025"

def test_earliest_pelada_date_ignores_invalid_values():
    assert earliest_pelada_date(["lixo", "", "10/05/2026 08:00:00"]) == "10/05/2026"

def test_earliest_pelada_date_returns_none_without_valid_values():
    assert earliest_pelada_date([]) is None
    assert earliest_pelada_date(["lixo"]) is None
