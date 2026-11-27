# Verification list

Choices built with the agent's recommended answer (CLAUDE.md workflow 11, owner instruction 27-11-2026), and standing items the business must supply or confirm before go-live. Each also has a "PENDING OWNER" row in `docs/decisions.md` where it was a build choice.

Line format: date · milestone · what was decided · why · who must verify · how to verify.
When an item is verified, strike it through and add "verified DD-MM-YYYY by <name>"; record the answer in decisions.md.

## Finance
- 18-11-2026 · M2 · Placeholder chart of accounts (34 accounts, one stock account 1310, WIP 1320, GRNI, clearing, revenue, COGS, variances), 39 default posting rules, ST-18 and WHT-153-1A/1B codes · no chart given · Finance · import the real chart (M11 importer) and check every posting rule maps to the right account
- 18-11-2026 · M2 · Account 5400 "Rounding difference - stock values" (expense under 5000) · rounding sweep needs an account · Finance · confirm account, type and place in the chart
- 19-11-2026 · M2/M6 · Conversion cost left when the whole FG lot left before batch close → production-variance expense account (placeholder) · owner Q11 answer needs an account · Finance · name the account before M6
- 25-11-2026 · M3 · Landed-cost corrections: Purchase Officer enters, Finance Manager posts with e-signature (`purch.landed_cost.correct`); split by the original's allocation; one currency/basis; total corrections ≤ original; rate re-read at posting; GD amounts in the charge currency · not stated · Finance · post a correction in staging and check the split per lot and the journal
- 26-11-2026 · M3 · Exchange gain/loss account 6300 (placeholder, role EXCHANGE_DIFFERENCE) · IAS 21 differences need an account · Finance · confirm the account
- 27-11-2026 · M3 · WHT base is per WITHHOLDING code (seeded INCL_SALES_TAX, unconfirmed); WHT posts only once rate, non-filer rate and base are confirmed; a never-checked vendor pays the non-filer rate; filer check stale after `purch.vendor.filer_check_max_days` = 30 · not stated · Finance · confirm each WHT code's rates and base in Tax codes; confirm the 30-day staleness
- 27-11-2026 · M3 · Invoice/payment reversal by Finance Manager only, e-signature REVERSED; invoice not reversed while a payment or debit note names it; debit notes DN-{FY}-{SEQ:5}, approval matrix DEBIT_NOTE (one band, Finance Manager), PRICE_CLAIM / SHORT_SUPPLY / RETURN_TO_VENDOR rules · not stated · Finance · run demo/M3.md steps 15–19 and check the journals
- 27-11-2026 · M4 · Account 6400 "QC sample expense" (placeholder, expense under 6000): QC samples (SAMPLE_ISSUE, event QC_SAMPLE) are debited here at the lot's cost · owner correction 27-11 needs an account · Finance · confirm the account (or map QC_SAMPLE_EXPENSE per item category in Posting rules) and check one sample's journal
- Standing · M8 · Chart of accounts (real, with codes) · go-live blocker · Finance · import file reviewed and signed off
- Standing · M3/M8 · WHT rates and base per section (filer / non-filer) · go-live blocker · Finance · each code's rates confirmed in the Tax codes screen
- Standing · M5/M8 · Sales tax per product (standard, reduced, exempt, zero-rated) · pharma products differ · Finance · tax code set on every FG item
- Standing · M1/M3/M5 · Approval limits (PO, quotation discount, SO credit, vendor payment, stock adjustment, debit note) · placeholders seeded · Finance + Management · approval matrix screen matches the signed delegation of authority
- Standing · M2 · Costing method (IAS 2): lot-actual cost (receipt price + landed cost), no moving average · confirm it suits the auditors · Finance · auditor sign-off
- Standing · M2–M8 · Special accounts: rounding (5400), price/usage variances, exchange (6300), advance tax (import IT), sales returns · placeholders · Finance · each mapped in Posting rules
- Standing · M6 · Conversion cost method (machine-hour / labour rate / overhead %) · needed for batch cost · Finance + Production · `fin.cost_rates` filled per line and one batch costed by hand
- Standing · M8 · FBR / PRAL access (POS ID, sandbox and production credentials) · FBR integration · Finance + Management · sandbox invoice accepted

## QA
- 18-11-2026 · M2 · Return limit per customer: `customer_id` required on DISPATCH and SALES_RETURN, returns counted from the original lot and its return lots; a deactivated customer may still return goods · not stated · QA + Sales · return more than dispatched to one customer and check it is refused
- 25-11-2026 · M3 · Material lot number ML{YY}-{SEQ:5}, reset each calendar year · no format given · QA · confirm the format against the SOP
- Standing · M3 · Lot number format (material ML{YY}-{SEQ:5}; FG batch AP{YY}-{SEQ:4}; return original-R{n}) · labels and records · QA · format matches the SOP
- Standing · M3 · Minimum remaining shelf life at GRN (`purch.grn.min_shelf_life_pct`, default 0 = off) · not given · QA + Warehouse · set the percent in Settings
- Standing · M6 · Checker steps (which production steps need doer + checker beyond output/yield) · M6 list · QA + Production · list signed off before M6
- Standing · M6 · Line clearance owner (Production or QA signs) · not given · QA + Production · named in the batch record SOP
- Standing · M9 · Serialization / track-and-trace vendor (DRAP) · not chosen · QA + Management · vendor named and interface agreed

## QC
- 27-11-2026 · M4 · Specs approved directly by a QC Manager with e-signature (not the approval matrix); approver ≠ drafter ≠ submitter; rejection → DRAFT with reason · simplest flow meeting "QC Manager approval" · QC · draft, submit and approve a spec in Specifications; try approving your own (refused)
- 27-11-2026 · M4 · Spec items: RM, PM, API, EXCIPIENT, BULK, FG; tests NUMERIC (min/max, negative allowed, 6 decimals) or TEXT (e.g. "Complies"); one assay and one water test per spec · covers pharmacopoeial monographs · QC · enter one real monograph (e.g. Paracetamol BP) and check every test fits
- 27-11-2026 · M4 · A lot cannot be sampled until its item has an APPROVED spec (SPEC_NOT_APPROVED) · results need limits · QC · confirm every QC-required item gets a spec before go-live
- 27-11-2026 · M4 · Expiry / retest "reached" = on or before the later of the movement date and today; a back-dated issue or dispatch of an expired lot is refused; reservations use today · owner said "past expiry", the day itself was not stated · QC + Warehouse · try to issue a lot on its expiry day (refused) and the day before (allowed)
- 27-11-2026 · M4 · Sample types TEST and RETENTION (= reserve); a sample movement is never reversed (correct a wrong quantity by stock adjustment) · a sample is consumed · QC + Warehouse · take a sample with a retention quantity and check both rows in the lot's ledger
- 27-11-2026 · M4 · Sampling: dated today, from one location, test quantity required, retention optional; the spec version is pinned at sampling; one result per test (re-test in task 4); numeric pass = min ≤ value ≤ max inclusive; text pass = the analyst's "complies"; results may still be entered on an FG lot after it went to HOLD · not stated · QC · run demo/M4.md steps 1–6
- 27-11-2026 · M4 · Review: one REVIEWED e-signature per sample covers all its unreviewed results; reviewer ≠ analyst of every result; a failed FG result puts the lot on HOLD at once (reason names the tests), a failed material result waits for the QC Manager's disposition · not stated · QC + QA · review a sample in Results review; enter a failing assay on an FG lot and check it is on HOLD

## Production
- See Finance (conversion cost) and QA (checker steps, line clearance).

## Warehouse
- See QA (shelf-life %).

## Sales
- See QA (return limit per customer).

## Management
- Standing · M10 · Cloud region for staging and production (data residency) · hosting · Management · region chosen in writing
- Standing · M11 · Go-live date · plan UAT and data migration · Management · date agreed with Finance, QA and Production
