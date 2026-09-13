"""Shared Form 4 literals and builders for the insider tests.

APPLE_XML is a real filing (accession 0001140361-26-036226) as EDGAR's own
filer tool emits it — no security title, no ownership nature, no
acquired/disposed code — which is the shape that breaks naive parsers.
`submission()` wraps XML in the full-submission envelope, in the format the
same filing uses; `feed()` builds a getcurrent Atom page, one entry per
participant like the real one.
"""

APPLE_ACCESSION = "0001140361-26-036226"

APPLE_XML = """<?xml version="1.0"?>
<ownershipDocument>
    <schemaVersion>X0609</schemaVersion>
    <documentType>4</documentType>
    <periodOfReport>2026-09-08</periodOfReport>
    <issuer>
        <issuerCik>0000320193</issuerCik>
        <issuerName>Apple Inc.</issuerName>
        <issuerTradingSymbol>AAPL</issuerTradingSymbol>
    </issuer>
    <reportingOwner>
        <reportingOwnerId>
            <rptOwnerCik>0001780525</rptOwnerCik>
            <rptOwnerName>Newstead Jennifer</rptOwnerName>
        </reportingOwnerId>
        <reportingOwnerRelationship>
            <isOfficer>true</isOfficer>
            <officerTitle>SVP, GC and Government Affairs</officerTitle>
        </reportingOwnerRelationship>
    </reportingOwner>
    <aff10b5One>true</aff10b5One>
    <nonDerivativeTable>
        <nonDerivativeTransaction>
            <transactionDate><value>2026-09-08</value></transactionDate>
            <transactionCoding>
                <transactionCode>S</transactionCode>
            </transactionCoding>
            <transactionAmounts>
                <transactionShares><value>1438</value></transactionShares>
                <transactionPricePerShare><value>317.23</value></transactionPricePerShare>
            </transactionAmounts>
            <postTransactionAmounts>
                <sharesOwnedFollowingTransaction><value>34352</value></sharesOwnedFollowingTransaction>
            </postTransactionAmounts>
        </nonDerivativeTransaction>
    </nonDerivativeTable>
    <ownerSignature>
        <signatureDate>2026-09-10</signatureDate>
    </ownerSignature>
</ownershipDocument>"""

# 1438 × $317.23 = $456,176.74
APPLE_VALUE_CENTS = 45_617_674


def submission(accession: str, xml: str | None, *, filed: str = "20260910",
               accepted: str = "20260910183031", form: str = "4",
               issuer: tuple[str, str] = ("0000320193", "Apple Inc.")) -> str:
    """A full-submission .txt with the SEC header's tab-separated fields."""
    body = f"<XML>\n{xml}\n</XML>\n" if xml is not None else "(no xml here)\n"
    return (
        f"<SEC-DOCUMENT>{accession}.txt : {filed}\n"
        f"<SEC-HEADER>{accession}.hdr.sgml : {filed}\n"
        f"<ACCEPTANCE-DATETIME>{accepted}\n"
        f"ACCESSION NUMBER:\t\t{accession}\n"
        f"CONFORMED SUBMISSION TYPE:\t{form}\n"
        f"PUBLIC DOCUMENT COUNT:\t\t1\n"
        f"CONFORMED PERIOD OF REPORT:\t20260908\n"
        f"FILED AS OF DATE:\t\t{filed}\n"
        f"DATE AS OF CHANGE:\t\t{filed}\n"
        f"\n"
        f"REPORTING-OWNER:\t\n"
        f"\n"
        f"\tOWNER DATA:\t\n"
        f"\t\tCOMPANY CONFORMED NAME:\t\t\tNewstead Jennifer\n"
        f"\t\tCENTRAL INDEX KEY:\t\t\t0001780525\n"
        f"\n"
        f"ISSUER:\t\t\n"
        f"\n"
        f"\tCOMPANY DATA:\t\n"
        f"\t\tCOMPANY CONFORMED NAME:\t\t\t{issuer[1]}\n"
        f"\t\tCENTRAL INDEX KEY:\t\t\t{issuer[0]}\n"
        f"</SEC-HEADER>\n"
        f"<DOCUMENT>\n<TYPE>{form}\n<SEQUENCE>1\n<FILENAME>form4.xml\n<DESCRIPTION>FORM 4\n"
        f"<TEXT>\n{body}</TEXT>\n</DOCUMENT>\n</SEC-DOCUMENT>\n"
    )


def feed(*entries: tuple) -> bytes:
    """A getcurrent Atom page. Each entry: (accession, form, cik, name, role, filed, updated)."""
    items = []
    for acc, form, cik, name, role, filed, updated in entries:
        items.append(
            f"<entry>\n"
            f"<title>{form} - {name} ({cik}) ({role})</title>\n"
            f'<link rel="alternate" type="text/html" '
            f'href="https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace("-", "")}/{acc}-index.htm"/>\n'
            f'<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; {filed} &lt;b&gt;AccNo:&lt;/b&gt; {acc} '
            f"&lt;b&gt;Size:&lt;/b&gt; 4 KB\n</summary>\n"
            f"<updated>{updated}</updated>\n"
            f'<category scheme="https://www.sec.gov/" label="form type" term="{form}"/>\n'
            f"<id>urn:tag:sec.gov,2008:accession-number={acc}</id>\n"
            f"</entry>\n"
        )
    return (
        '<?xml version="1.0" encoding="ISO-8859-1" ?>\n'
        '<feed xmlns="http://www.w3.org/2005/Atom">\n'
        "<title>Latest Filings</title>\n<updated>2026-09-13T05:46:57-04:00</updated>\n"
        + "".join(items) + "</feed>\n"
    ).encode("latin-1")
