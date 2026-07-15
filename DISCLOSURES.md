# Important Disclosures

**DiversiFi Capital Covered Call Analyzer**

## Purpose and scope

This software is an internal analysis tool provided for informational and illustrative
purposes only. It does not constitute investment, tax, or legal advice, and it is not an
offer to sell or a solicitation of an offer to buy any security or to engage in any
options strategy. Nothing produced by this tool should be relied upon as a recommendation
to buy, sell, or write any option or security. Any investment decision should be made
only after a review of the client's individual circumstances with a qualified advisor.

## Options risk

Options involve substantial risk and are not suitable for all investors. Before trading
options, investors should read [Characteristics and Risks of Standardized
Options](https://www.theocc.com/company-information/documents-and-archives/options-disclosure-document)
(the Options Disclosure Document) published by the Options Clearing Corporation.

Covered call writing in particular:

- Caps upside participation above the strike price. If the stock rises above the strike,
  shares may be called away and further appreciation is forgone.
- Does not protect against a decline in the underlying stock beyond the premium received.
- Carries early assignment risk at any time before expiration, including around dividend
  dates and earnings announcements.
- May create taxable events, including recognition of gains on shares that are called
  away and the tax treatment of premium received. Holding period and qualified dividend
  treatment can also be affected. Consult a tax professional.

## Hypothetical and projected figures

Premiums, returns on investment, annualized returns, and monthly cash flow figures shown
by this tool are hypothetical calculations derived from market quotes at a moment in
time. They assume execution at the quoted bid, which is not guaranteed, and annualized
figures assume conditions that repeat, which they may not. Actual results will differ.
Past or projected performance is not a guarantee of future results.

"Call probability" is the option's model-derived delta (Black-Scholes, computed from
midpoint-implied volatility). It is an approximation commonly used as a rough proxy for
the probability of the option finishing in the money. It is a model output, not an
actual probability, and it changes continuously with market conditions.

## Market data

Quotes, option chains, earnings dates, and dividend data are retrieved from publicly
available Yahoo Finance endpoints and are delayed, may be inaccurate, incomplete, or
unavailable, and are provided without warranty of any kind. Thinly traded contracts may
show stale or wide markets. Always verify strikes, premiums, expirations, and earnings
dates against the executing broker's platform before placing any trade. The "Verify on
Barchart" link is provided for convenience only. This project is not affiliated with,
sponsored by, or endorsed by Yahoo, Barchart, or any data provider, and users are
responsible for complying with those services' terms of use.

## Software

This software is provided "as is," without warranty of any kind, express or implied,
including but not limited to warranties of merchantability, fitness for a particular
purpose, accuracy, or non-infringement. In no event shall the authors or DiversiFi
Capital be liable for any claim, damages, or other liability arising from the use of
this software.

The DiversiFi Capital name and logo are the property of DiversiFi Capital. Publication
of this repository does not grant any license to use them.

© 2026 DiversiFi Capital. All rights reserved.
