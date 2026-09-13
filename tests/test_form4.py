"""Form 4 parsing against two real filings.

APPLE_XML is the minimal shape EDGAR's own filer tool emits. The committed
fixture is a joint filing with two reporting owners, footnoted VWAP prices,
holdings alongside transactions, and an exhibit appended after the XML — its
ownership XML is verbatim from EDGAR; the header envelope around it was
reconstructed in the format the Apple submission uses.
"""

import re
from decimal import Decimal
from pathlib import Path

import pytest

from whale import form4
from whale.form4 import Form4, Owner, Transaction, parse_form4, parse_submission

from form4_samples import APPLE_ACCESSION, APPLE_VALUE_CENTS, APPLE_XML, submission

FIXTURE = (Path(__file__).parent / "fixtures" / "form4_0001214659-26-011648.txt").read_text()


def _tx(code="P", shares="100", price="10.00", **kw) -> Transaction:
    fields = dict(security_title=None, tx_date="2026-09-09", deemed_execution_date=None,
                  transaction_code=code, timeliness=None,
                  shares=Decimal(shares) if shares is not None else None,
                  price_per_share=Decimal(price) if price is not None else None,
                  acquired_disposed=None, shares_after=None, direct_or_indirect=None,
                  nature_of_ownership=None)
    fields.update(kw)
    return Transaction(**fields)


def _doc(*txs) -> Form4:
    return Form4(document_type="4", period_of_report=None, issuer_cik="0000000001",
                 issuer_name="X", ticker_as_filed="X", aff_10b5_one=None,
                 not_subject_to_section16=None,
                 owners=[Owner(cik="0000000002", name="Someone")],
                 transactions=list(txs), footnotes={}, remarks=None)


# --- the minimal filing ------------------------------------------------------


def test_minimal_filing_parses_completely():
    doc = parse_form4(APPLE_XML)
    assert (doc.issuer_cik, doc.issuer_name, doc.ticker) == ("0000320193", "Apple Inc.", "AAPL")
    assert doc.aff_10b5_one is True
    assert doc.owners == [Owner(cik="0001780525", name="Newstead Jennifer", is_officer=True,
                                officer_title="SVP, GC and Government Affairs")]
    (tx,) = doc.transactions
    assert (tx.transaction_code, tx.action) == ("S", "sale")
    assert (tx.shares, tx.price_per_share) == (Decimal("1438"), Decimal("317.23"))
    assert tx.value_cents == APPLE_VALUE_CENTS
    # Optional leaves that this filing simply omits.
    assert tx.security_title is None and tx.acquired_disposed is None
    assert tx.direct_or_indirect is None and tx.footnotes == []


def test_absent_10b5_1_element_is_unknown_not_false():
    xml = APPLE_XML.replace("<aff10b5One>true</aff10b5One>", "")
    assert parse_form4(xml).aff_10b5_one is None


def test_boolean_spellings():
    assert form4._bool("true") is True and form4._bool("1") is True
    assert form4._bool("false") is False and form4._bool("0") is False
    assert form4._bool(None) is None and form4._bool("maybe") is None


def test_missing_price_means_unknown_value():
    xml = APPLE_XML.replace(
        "<transactionPricePerShare><value>317.23</value></transactionPricePerShare>", "")
    (tx,) = parse_form4(xml).transactions
    assert tx.price_per_share is None and tx.value_cents is None


def test_zero_price_means_unknown_value():
    assert _tx(price="0").value_cents is None


def test_value_rounds_half_up_to_cents():
    assert _tx(shares="1234.5678", price="187.3456").value_cents == 23_129_085
    # Python's round() would give 12 here; a filed figure rounds half up.
    assert _tx(shares="1", price="0.125").value_cents == 13


def test_derivative_table_is_ignored():
    xml = APPLE_XML.replace("</nonDerivativeTable>", """</nonDerivativeTable>
    <derivativeTable>
        <derivativeTransaction>
            <securityTitle><value>Stock Option</value></securityTitle>
            <transactionDate><value>2026-09-08</value></transactionDate>
            <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
            <transactionAmounts>
                <transactionShares><value>1000</value></transactionShares>
                <transactionPricePerShare><value>50</value></transactionPricePerShare>
            </transactionAmounts>
        </derivativeTransaction>
    </derivativeTable>""")
    assert len(parse_form4(xml).transactions) == 1


def test_filing_without_issuer_or_owner_is_rejected():
    with pytest.raises(ValueError):
        parse_form4(APPLE_XML.replace("<issuerCik>0000320193</issuerCik>", ""))
    with pytest.raises(ValueError):
        parse_form4(re.sub(r"<reportingOwner>.*?</reportingOwner>", "", APPLE_XML, flags=re.S))
    with pytest.raises(ValueError):
        parse_form4("<notAForm/>")


# --- the joint filing (fixture) ----------------------------------------------


def test_full_submission_header():
    header, xml = parse_submission(FIXTURE)
    assert header.accession == "0001214659-26-011648"
    assert header.form_type == "4"
    assert header.filed_date == "2026-09-11"
    assert header.accepted_at == "2026-09-12T01:59:18Z"  # 21:59:18 EDT
    assert header.period_of_report == "2026-09-09"
    assert (header.issuer_cik, header.issuer_name) == ("0000896493", "Hyperscale Data, Inc.")
    assert xml is not None and xml.startswith("<?xml")


def test_reporting_owner_block_does_not_masquerade_as_issuer():
    # Both blocks carry COMPANY CONFORMED NAME; the ISSUER block comes second.
    header, _ = parse_submission(FIXTURE)
    assert header.issuer_name != "AULT MILTON C III"


def test_exhibits_are_skipped_even_when_first():
    docs = re.findall(r"<DOCUMENT>.*?</DOCUMENT>", FIXTURE, flags=re.S)
    assert len(docs) == 2 and "<TYPE>EX-24" in docs[1]
    swapped = FIXTURE.replace(docs[0], "@@FORM@@").replace(docs[1], docs[0]).replace("@@FORM@@", docs[1])
    _, xml = parse_submission(swapped)
    assert xml is not None and "<ownershipDocument>" in xml


def test_submission_without_ownership_xml():
    header, xml = parse_submission(submission(APPLE_ACCESSION, None))
    assert header.accession == APPLE_ACCESSION and xml is None


def test_joint_filing_owners_and_roles():
    doc = parse_form4(parse_submission(FIXTURE)[1])
    primary, holding = doc.owners
    assert primary.cik == "0001212502" and primary.name == "AULT MILTON C III"
    assert (primary.is_director, primary.is_officer, primary.is_ten_percent_owner) == (True, True, True)
    assert primary.officer_title == "Executive Chairman"
    assert holding.cik == "0001734770" and holding.is_ten_percent_owner and holding.is_other
    assert holding.other_text == "See Remark"
    assert doc.aff_10b5_one is False  # spelled "0" in this filing
    assert doc.not_subject_to_section16 is False
    assert doc.remarks.startswith("Mr. Ault, Chief Executive Officer")


def test_footnotes_attach_to_the_rows_that_cite_them():
    doc = parse_form4(parse_submission(FIXTURE)[1])
    assert len(doc.transactions) == 3  # the two nonDerivativeHolding rows are not transactions
    first, _, third = doc.transactions
    assert first.footnote_ids == ["F1"]
    assert first.footnotes[0].startswith("The common stock was purchased in open market")
    assert "Range: $0.1878 to $0.1893" in first.footnotes[0]
    assert third.footnote_ids == ["F3"]
    assert third.direct_or_indirect == "I"
    assert third.nature_of_ownership == "By Ault & Company, Inc."
    assert first.acquired_disposed == "A" and first.security_title == "Class A Common Stock"


def test_joint_filing_values():
    doc = parse_form4(parse_submission(FIXTURE)[1])
    assert [t.value_cents for t in doc.transactions] == [103_785, 423_396, 2_838_000]
    assert form4.direction_totals(doc.transactions) == {"purchase": 3_365_181, "sale": 0}
    assert form4.keep_reason(doc, 5_000_000) is None       # $33.7k does not clear $50k
    assert form4.keep_reason(doc, 3_000_000) == "purchase"


# --- header details ----------------------------------------------------------


def test_acceptance_stamp_is_eastern():
    assert form4.eastern_to_utc("20260910183031") == "2026-09-10T22:30:31Z"  # EDT
    assert form4.eastern_to_utc("20260115090000") == "2026-01-15T14:00:00Z"  # EST
    assert form4.eastern_to_utc("garbage") is None


def test_header_fields_are_tab_separated():
    header = form4.parse_sec_header(submission(APPLE_ACCESSION, APPLE_XML, filed="20260910"))
    assert header.filed_date == "2026-09-10"
    assert header.form_type == "4"
    assert header.issuer_cik == "0000320193"


# --- what to keep ------------------------------------------------------------


def test_open_market_keeps_only_p_and_s():
    txs = [_tx(code=c) for c in ("A", "F", "M", "P", "G", "S", "J")]
    assert [t.transaction_code for t in form4.open_market(txs)] == ["P", "S"]


def test_direction_totals_ignore_rows_without_a_value():
    totals = form4.direction_totals([_tx("S", "100", "10"), _tx("S", "100", None), _tx("A", "5", "1")])
    assert totals == {"purchase": 0, "sale": 100_000}


def test_keep_reason_floor_is_inclusive_and_per_direction():
    floor = 5_000_000  # $50,000.00
    assert form4.keep_reason(_doc(_tx("S", "500", "100.00")), floor) == "sale"
    assert form4.keep_reason(_doc(_tx("S", "499999", "0.1")), floor) is None      # $49,999.90
    assert form4.keep_reason(_doc(_tx("S", "300", "100"), _tx("S", "250", "100")), floor) == "sale"
    assert form4.keep_reason(_doc(_tx("P", "300", "100"), _tx("S", "300", "100")), floor) is None
    # Both directions clear the floor: the larger one names the reason.
    assert form4.keep_reason(_doc(_tx("P", "600", "100"), _tx("S", "900", "100")), floor) == "sale"
    assert form4.keep_reason(_doc(_tx("P", "100", None)), floor) is None


def test_ticker_normalisation():
    assert form4.normalize_ticker(" aapl ") == "AAPL"
    assert form4.normalize_ticker("BRK.B") == "BRK.B"  # punctuation left as filed
    for raw in ("NONE", "N/A", "na", "", "-", None):
        assert form4.normalize_ticker(raw) is None
