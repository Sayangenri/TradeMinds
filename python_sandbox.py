"""
AMM Arbitrage Practice Sandbox
-------------------------------
Two Uniswap-V2-style pools for the SAME pair (TOKEN/USDC) with different
reserves => a price gap. This script:
  1. computes the spot price of each pool (with decimals handled correctly)
  2. simulates buying on the cheap pool and selling on the expensive one,
     using the real constant-product-with-fee math
  3. reports NET profit after fees + price impact

Change the reserves and trade size at the bottom and watch how
"obvious" gaps often turn into losses once the real math is applied.
"""

FEE = 0.003  # 0.3% per swap, like Uniswap V2

def spot_price(reserve_token, reserve_usdc, dec_token, dec_usdc):
    """Price of 1 TOKEN in USDC, decimals normalized."""
    rt = reserve_token / 10**dec_token
    ru = reserve_usdc  / 10**dec_usdc
    return ru / rt

def get_amount_out(amount_in, reserve_in, reserve_out):
    """
    Constant-product swap output WITH the 0.3% fee.
    amount_out = (amount_in * (1-fee) * reserve_out) / (reserve_in + amount_in*(1-fee))
    All three inputs must be in the SAME units/decimals.
    """
    amount_in_with_fee = amount_in * (1 - FEE)
    return (amount_in_with_fee * reserve_out) / (reserve_in + amount_in_with_fee)

def simulate_arb(poolA, poolB, usdc_to_spend, dec_token, dec_usdc):
    """
    poolA, poolB are dicts: {'token': reserve_token_raw, 'usdc': reserve_usdc_raw}
    Strategy: spend USDC on whichever pool prices TOKEN cheaper (buy TOKEN),
    then sell that TOKEN on the other pool for USDC.
    """
    pA = spot_price(poolA['token'], poolA['usdc'], dec_token, dec_usdc)
    pB = spot_price(poolB['token'], poolB['usdc'], dec_token, dec_usdc)
    print(f"Pool A spot price: {pA:,.4f} USDC/TOKEN")
    print(f"Pool B spot price: {pB:,.4f} USDC/TOKEN")
    gap_pct = abs(pA - pB) / min(pA, pB) * 100
    print(f"Raw price gap:     {gap_pct:.3f}%\n")

    # buy on the cheaper pool
    if pA < pB:
        buy, sell, buy_name, sell_name = poolA, poolB, "A", "B"
    else:
        buy, sell, buy_name, sell_name = poolB, poolA, "B", "A"

    # work in human units for clarity
    buy_token_res  = buy['token']  / 10**dec_token
    buy_usdc_res   = buy['usdc']   / 10**dec_usdc
    sell_token_res = sell['token'] / 10**dec_token
    sell_usdc_res  = sell['usdc']  / 10**dec_usdc

    # leg 1: USDC -> TOKEN on cheap pool
    token_bought = get_amount_out(usdc_to_spend, buy_usdc_res, buy_token_res)
    # leg 2: TOKEN -> USDC on expensive pool
    usdc_back    = get_amount_out(token_bought, sell_token_res, sell_usdc_res)

    gross = usdc_back - usdc_to_spend
    print(f"Buy  on pool {buy_name}: spend {usdc_to_spend:,.2f} USDC -> get {token_bought:,.6f} TOKEN")
    print(f"Sell on pool {sell_name}: sell {token_bought:,.6f} TOKEN -> get {usdc_back:,.2f} USDC")
    print(f"\nGross P&L (fees + price impact already included): {gross:,.2f} USDC")

    # subtract a rough gas estimate (two swaps). Tune to the chain.
    gas_cost_usdc = 0.50
    net = gross - gas_cost_usdc
    print(f"Minus est. gas ({gas_cost_usdc} USDC): NET P&L = {net:,.2f} USDC")
    print("PROFITABLE ✅" if net > 0 else "NOT profitable ❌ — the gap didn't cover costs")
    print("-" * 60)


if __name__ == "__main__":
    DEC_TOKEN = 18   # e.g. WETH
    DEC_USDC  = 6    # USDC

    # Example 1: a small 0.5% gap, modest trade — watch it likely LOSE
    print("=== Example 1: small gap, small trade ===")
    poolA = {'token': int(1000 * 10**DEC_TOKEN), 'usdc': int(2000000 * 10**DEC_USDC)}  # 2000.00
    poolB = {'token': int(1000 * 10**DEC_TOKEN), 'usdc': int(2010000 * 10**DEC_USDC)}  # 2010.00
    simulate_arb(poolA, poolB, usdc_to_spend=1000, dec_token=DEC_TOKEN, dec_usdc=DEC_USDC)

    # Example 2: same gap but trade too big -> price impact eats you
    print("=== Example 2: same gap, trade TOO big ===")
    simulate_arb(poolA, poolB, usdc_to_spend=200000, dec_token=DEC_TOKEN, dec_usdc=DEC_USDC)

    # Example 3: a genuinely large gap (3%) on a deep pool -> real profit
    print("=== Example 3: large gap, deep pool ===")
    poolC = {'token': int(5000 * 10**DEC_TOKEN), 'usdc': int(10000000 * 10**DEC_USDC)}  # 2000
    poolD = {'token': int(5000 * 10**DEC_TOKEN), 'usdc': int(10300000 * 10**DEC_USDC)}  # 2060
    simulate_arb(poolC, poolD, usdc_to_spend=20000, dec_token=DEC_TOKEN, dec_usdc=DEC_USDC)
