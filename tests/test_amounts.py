from whale.amounts import Amount, format_amount, parse_amount, usd


def test_standard_bracket():
    a = parse_amount("$1,001 - $15,000")
    assert a == Amount(100_100, 1_500_000)
    assert a.mid_cents == 800_050


def test_bracket_wrapped_across_lines():
    # PTR amounts wrap in their column; the parser rejoins them with a space.
    assert parse_amount("$15,001 - $50,000") == Amount(1_500_100, 5_000_000)


def test_en_dash_and_extra_whitespace():
    assert parse_amount("  $50,001 –   $100,000 ") == Amount(5_000_100, 10_000_000)


def test_exact_amount():
    a = parse_amount("$2,722.50")
    assert a == Amount(272_250, 272_250, 272_250)
    assert a.mid_cents == 272_250


def test_open_ended_top_bracket_has_no_midpoint():
    # "Over $50,000,000" has no defensible maximum, so inventing a midpoint
    # would fabricate volume.
    a = parse_amount("Over $50,000,000")
    assert a.min_cents == 5_000_000_000
    assert a.max_cents is None
    assert a.mid_cents is None


def test_unparseable_returns_none():
    assert parse_amount(None) is None
    assert parse_amount("") is None
    assert parse_amount("N/A") is None


def test_reversed_bracket_is_normalized():
    assert parse_amount("$15,000 - $1,001") == Amount(100_100, 1_500_000)


def test_format_preserves_range_semantics():
    assert format_amount(100_100, 1_500_000) == "$1,001–$15k"
    assert format_amount(5_000_000_000, None) == ">$50.0M".replace(".0M", "M")
    assert format_amount(272_250, 272_250, 272_250) == "$2,723"


def test_usd_compaction():
    assert usd(272_250) == "$2,723"
    assert usd(1_700_000) == "$17k"
    assert usd(170_000_000) == "$1.7M"
    assert usd(None) == "?"
