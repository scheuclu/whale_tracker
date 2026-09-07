"""House Clerk bulk index parsing."""

from datetime import date

from whale import house
from whale.house import IndexEntry, is_recent, parse_index, ptr_entries

# Shaped exactly like the Clerk's 2026FD.xml, including the BOM, the empty
# self-closing fields, and the M/D/YYYY dates it actually emits.
SAMPLE = """﻿<?xml version="1.0" encoding="utf-8"?>
<FinancialDisclosure>
  <Member>
    <Prefix />
    <Last>Wasserman Schultz</Last>
    <First>Debbie</First>
    <Suffix />
    <FilingType>P</FilingType>
    <StateDst>FL25</StateDst>
    <Year>2026</Year>
    <FilingDate>7/14/2026</FilingDate>
    <DocID>20034999</DocID>
  </Member>
  <Member>
    <Prefix />
    <Last>Yakym</Last>
    <First>Rudy C.</First>
    <Suffix>III</Suffix>
    <FilingType>P</FilingType>
    <StateDst>IN02</StateDst>
    <Year>2026</Year>
    <FilingDate>7/13/2026</FilingDate>
    <DocID>20034984</DocID>
  </Member>
  <Member>
    <Prefix />
    <Last>Abdulle</Last>
    <First>Abdisallam</First>
    <Suffix />
    <FilingType>C</FilingType>
    <StateDst>MN02</StateDst>
    <Year>2026</Year>
    <FilingDate>6/11/2026</FilingDate>
    <DocID>10078673</DocID>
  </Member>
</FinancialDisclosure>
""".encode("utf-8")


def test_parses_every_member_row():
    assert len(parse_index(SAMPLE, 2026)) == 3


def test_only_periodic_transaction_reports_are_selected():
    # The same index carries candidate reports, amendments and extensions,
    # none of which contain transactions.
    ptrs = ptr_entries(parse_index(SAMPLE, 2026))
    assert [e.doc_id for e in ptrs] == ["20034999", "20034984"]


def test_dates_are_normalized_to_iso():
    assert parse_index(SAMPLE, 2026)[0].filing_date == "2026-07-14"


def test_suffix_is_kept_in_the_filer_name():
    yakym = parse_index(SAMPLE, 2026)[1]
    assert yakym.filer_name == "Rudy C. Yakym III"


def test_pdf_url_points_at_the_ptr_directory():
    entry = parse_index(SAMPLE, 2026)[0]
    assert entry.pdf_url == (
        "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20034999.pdf"
    )


def test_malformed_date_does_not_raise():
    xml = SAMPLE.replace(b"7/14/2026", b"not-a-date")
    assert parse_index(xml, 2026)[0].filing_date is None


def test_rows_without_a_docid_are_skipped():
    xml = SAMPLE.replace(b"<DocID>20034999</DocID>", b"<DocID></DocID>")
    assert len(parse_index(xml, 2026)) == 2


def test_whitespace_and_crlf_are_stripped():
    # The Clerk's companion .txt uses CRLF; the XML carries stray whitespace.
    xml = SAMPLE.replace(b"<DocID>20034999</DocID>", b"<DocID> 20034999\r\n </DocID>")
    assert parse_index(xml, 2026)[0].doc_id == "20034999"


def test_is_recent_gates_the_notification_path():
    today = date(2026, 7, 20)
    assert is_recent("2026-07-14", 7, today) is True
    assert is_recent("2026-07-01", 7, today) is False
    assert is_recent(None, 7, today) is False
    assert is_recent("garbage", 7, today) is False


def test_index_url_shape():
    assert house.INDEX_URL.format(year=2026).endswith("/2026FD.zip")


def test_entry_without_first_name_still_produces_a_label():
    entry = IndexEntry(doc_id="1", last="Smith", first="", suffix="", prefix="",
                       filing_type="P", state_district="TX03", year=2026,
                       filing_date=None)
    assert entry.filer_name == "Smith"
