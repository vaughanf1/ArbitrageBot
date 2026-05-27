# NATHAN-I — What Cesar needs in place

A practical checklist for the three stages: **testing → fine-tuning → going live.**
Short version: **for testing and fine-tuning you need almost nothing — just a browser.**
Real money ("going live") needs accounts + funding + a round of development work, and
should not be rushed.

---

## Stage 1 — Testing (you can do this today)

The bot is already deployed and running in **paper mode** (simulated trades on **real,
live market data**). To watch and test it:

| Item | Needed? | Notes |
|---|---|---|
| A web browser | ✅ Yes | That's it. The bot runs in the cloud (Railway). |
| Any software installed on your computer | ❌ No | Nothing to install. Just open the dashboard link. |
| Accounts / API keys at the exchanges | ❌ No | Scanning uses public market data; no keys required to test. |
| Money on any exchange | ❌ No | Paper mode places no real orders. |

**Dashboard:** https://dashboard-production-0d5f.up.railway.app/

> Important: the green "P&L" you see in paper mode is **simulated and booked at entry** —
> it's a theoretical figure to show the engine is finding edges, **not** real earnings.

---

## Stage 2 — Fine-tuning (also today, no accounts needed)

This is about tuning *behaviour* before any real money. All done from the dashboard's
**Controls** page — still no installs, no keys:

- **Risk limits** — max trade size, max daily exposure, max daily loss %, trailing stop.
- **Minimum spread %** — how big an edge must be before it counts as a position to enter.
- **Which markets to pair** — the Polymarket↔Kalshi prediction pairs are curated in an
  allowlist; we extend/refine that list together as you decide which markets you trust.
- Watch over several sessions, then we adjust thresholds based on what we see.

Optional in this stage:

- **Daily email report** — if you want the end-of-day summary emailed, we need a
  **Resend** account (free tier is fine) and a verified sender address. ~10 min to set up.

---

## Stage 3 — Going live (real money) — requires prep + development

**Be aware:** live order placement is **not built yet**. The engine currently *detects*
real opportunities and *simulates* fills, but the code that actually sends orders to the
exchanges is intentionally switched off and unimplemented (v1 is paper-only by design).
So "going live" is a project with two parallel tracks:

### A. What YOU (Cesar) need to procure

For each venue you want to trade live, you need an account, identity verification, funding,
and API credentials:

**Crypto — BitGet** (and/or the spot venues we scan: Binance, Bybit, OKX, Kraken, Coinbase)
- [ ] Verified BitGet account (KYC complete)
- [ ] Account funded with trading capital (USDT)
- [ ] API key set: **API key + secret + passphrase** (create with *trade* permission, IP-restricted)

**Prediction markets — Polymarket**
- [ ] A crypto wallet (Polymarket settles on the Polygon network)
- [ ] **USDC on Polygon** in that wallet for trading capital
- [ ] Wallet **private key** + Polymarket API credentials (key / secret / passphrase)
- [ ] Confirm you're eligible/allowed to trade Polymarket from your jurisdiction

**Prediction markets — Kalshi** (US-regulated exchange)
- [ ] Verified Kalshi account (US-person KYC / eligibility)
- [ ] Account funded (USD)
- [ ] **API key ID** + the **RSA private key file** Kalshi issues you

**Reporting / hosting (already mostly in place)**
- [ ] Railway account — ✅ you already have this (the bot lives here)
- [ ] Resend account for emailed reports — optional

> You do **not** need anything installed on your personal computer for any of this.
> Keys are pasted into the Railway dashboard (secure environment variables), not your laptop.
> The only file is Kalshi's private key, which we store as a Railway secret.

### B. What needs to be BUILT before live (development — my side)

These are the gaps between "great paper demo" and "safe with real money":

1. **Implement real order placement** for each venue (signed orders to BitGet, Polymarket
   CLOB, Kalshi) — currently returns "not implemented."
2. **Settlement / real P&L** — today P&L is booked at entry; live needs trades tracked to
   actual resolution/close (the v2 accrual work).
3. **Lock down the controls** — the kill-switch / limits / start-stop endpoints are currently
   open (no auth). They must be authenticated before real money is exposed.
4. **Live dry-run** — go live with tiny size first, reconcile every fill against the
   exchange, then scale up.

### Suggested order

1. ✅ Test in paper (now) → 2. Fine-tune limits + market list (now) →
3. Open + fund the exchange accounts (you, in parallel) →
4. Build live execution + settlement + auth (me) →
5. Live dry-run with small size → 6. Scale up.

---

### TL;DR for Cesar
- **To start testing & fine-tuning now:** nothing — just the browser + the dashboard link.
- **To go live later:** funded + verified accounts at BitGet / Polymarket / Kalshi with API
  keys, *plus* a development phase to turn on real trading safely. No software on your computer
  either way.
