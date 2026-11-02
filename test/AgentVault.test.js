const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentVault", function () {
  let vault, token0, token1, token2;
  let owner, agent, outsider;
  let mockRouter;

  const DECIMALS_18 = 18;
  const DECIMALS_6 = 6;

  beforeEach(async function () {
    [owner, agent, outsider] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token0 = await MockERC20.deploy("TALPHA", "TALPHA", DECIMALS_18);
    token1 = await MockERC20.deploy("TBETA", "TBETA", DECIMALS_18);
    token2 = await MockERC20.deploy("tUSDT", "tUSDT", DECIMALS_6);

    await token0.waitForDeployment();
    await token1.waitForDeployment();
    await token2.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockSwapRouter");
    mockRouter = await MockRouter.deploy();
    await mockRouter.waitForDeployment();

    const routerAddr = await mockRouter.getAddress();

    const AgentVault = await ethers.getContractFactory("AgentVault");
    vault = await AgentVault.deploy(
      agent.address,
      routerAddr,
      500,   // 5% max position
      200,   // 2% daily loss cap
      0      // no cooldown for tests
    );
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    // Mint tokens to owner
    await token0.mint(owner.address, ethers.parseUnits("1000000", 18));
    await token1.mint(owner.address, ethers.parseUnits("1000000", 18));
    await token2.mint(owner.address, ethers.parseUnits("1000000", 6));

    // Mint tokens to mock router so it can return swaps
    await token0.mint(routerAddr, ethers.parseUnits("1000000", 18));
    await token1.mint(routerAddr, ethers.parseUnits("1000000", 18));
    await token2.mint(routerAddr, ethers.parseUnits("1000000", 6));

    // Approve and deposit
    await token0.approve(vaultAddr, ethers.MaxUint256);
    await token1.approve(vaultAddr, ethers.MaxUint256);
    await token2.approve(vaultAddr, ethers.MaxUint256);

    await vault.deposit(await token0.getAddress(), ethers.parseUnits("100000", 18));
    await vault.deposit(await token1.getAddress(), ethers.parseUnits("100000", 18));
    await vault.deposit(await token2.getAddress(), ethers.parseUnits("100000", 6));
  });

  describe("Deployment", function () {
    it("should set owner, agent, and router correctly", async function () {
      expect(await vault.owner()).to.equal(owner.address);
      expect(await vault.agent()).to.equal(agent.address);
      expect(await vault.allowedRouter()).to.equal(await mockRouter.getAddress());
    });

    it("should set initial limits", async function () {
      expect(await vault.maxPositionPct()).to.equal(500);
      expect(await vault.dailyLossCapPct()).to.equal(200);
      expect(await vault.cooldownSeconds()).to.equal(0);
    });
  });

  describe("Deposits and Withdrawals", function () {
    it("should track token balances after deposit", async function () {
      const bal = await vault.getTokenBalance(await token0.getAddress());
      expect(bal).to.equal(ethers.parseUnits("100000", 18));
    });

    it("should allow owner to withdraw", async function () {
      const t0Addr = await token0.getAddress();
      const withdrawAmt = ethers.parseUnits("50000", 18);
      await vault.withdraw(t0Addr, withdrawAmt);
      expect(await vault.getTokenBalance(t0Addr)).to.equal(ethers.parseUnits("50000", 18));
    });

    it("should reject withdrawal exceeding balance", async function () {
      const t0Addr = await token0.getAddress();
      await expect(
        vault.withdraw(t0Addr, ethers.parseUnits("200000", 18))
      ).to.be.revertedWith("Insufficient balance");
    });

    it("should reject deposit from non-owner", async function () {
      const t0Addr = await token0.getAddress();
      await expect(
        vault.connect(agent).deposit(t0Addr, 100)
      ).to.be.revertedWith("Not owner");
    });

    it("should allow owner emergency withdraw even when paused", async function () {
      await vault.pause();
      const t0Addr = await token0.getAddress();
      await vault.emergencyWithdraw(t0Addr);
      expect(await vault.getTokenBalance(t0Addr)).to.equal(0);
    });

    it("should return deposited tokens list", async function () {
      const tokens = await vault.getDepositedTokens();
      expect(tokens.length).to.equal(3);
    });
  });

  describe("Trade Execution", function () {
    it("should allow agent to execute trade", async function () {
      const t0Addr = await token0.getAddress();
      const t1Addr = await token1.getAddress();
      const amountIn = ethers.parseUnits("1000", 18);

      await mockRouter.setReturnAmount(amountIn);

      const tx = await vault.connect(agent).executeTrade(
        t0Addr, t1Addr, 3000, amountIn, 0
      );
      const receipt = await tx.wait();

      const tradeEvent = receipt.logs.find(l => {
        try { return vault.interface.parseLog(l)?.name === "TradeExecuted"; } catch { return false; }
      });
      expect(tradeEvent).to.not.be.undefined;
    });

    it("should reject trade from non-agent", async function () {
      const t0Addr = await token0.getAddress();
      const t1Addr = await token1.getAddress();
      await expect(
        vault.connect(outsider).executeTrade(t0Addr, t1Addr, 3000, 100, 0)
      ).to.be.revertedWith("Not agent");
    });

    it("should reject trade exceeding max position size", async function () {
      const t0Addr = await token0.getAddress();
      const t1Addr = await token1.getAddress();
      // 100000 * 18dec + 100000 * 18dec + 100000 * 6dec = total ~200000e18 + 100000e6
      // 5% of that is huge, but let's try a huge amount
      const hugeAmount = ethers.parseUnits("99999999", 18);
      await expect(
        vault.connect(agent).executeTrade(t0Addr, t1Addr, 3000, hugeAmount, 0)
      ).to.be.reverted;
    });

    it("should reject trade when paused", async function () {
      await vault.pause();
      const t0Addr = await token0.getAddress();
      const t1Addr = await token1.getAddress();
      await expect(
        vault.connect(agent).executeTrade(t0Addr, t1Addr, 3000, 100, 0)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
  });

  describe("Arb Execution", function () {
    it("should allow agent to execute arb", async function () {
      const t0Addr = await token0.getAddress();
      const t1Addr = await token1.getAddress();
      const t2Addr = await token2.getAddress();

      const path = ethers.solidityPacked(
        ["address", "uint24", "address", "uint24", "address"],
        [t0Addr, 3000, t1Addr, 3000, t2Addr]
      );

      const amountIn = ethers.parseUnits("1000", 18);
      await mockRouter.setReturnAmount(ethers.parseUnits("1100", 6));

      const tx = await vault.connect(agent).executeArb(path, amountIn, 0);
      const receipt = await tx.wait();

      const arbEvent = receipt.logs.find(l => {
        try { return vault.interface.parseLog(l)?.name === "ArbExecuted"; } catch { return false; }
      });
      expect(arbEvent).to.not.be.undefined;
    });
  });

  describe("Limits & Access Control", function () {
    it("should allow owner to set limits", async function () {
      await vault.setLimits(1000, 300, 60);
      expect(await vault.maxPositionPct()).to.equal(1000);
      expect(await vault.dailyLossCapPct()).to.equal(300);
      expect(await vault.cooldownSeconds()).to.equal(60);
    });

    it("should allow agent to tighten limits only", async function () {
      await vault.connect(agent).tightenLimits(300, 100, 10);
      expect(await vault.maxPositionPct()).to.equal(300);
    });

    it("should reject agent loosening limits", async function () {
      await expect(
        vault.connect(agent).tightenLimits(600, 200, 0)
      ).to.be.revertedWith("Can only tighten max position");
    });

    it("should allow owner to change agent", async function () {
      await vault.setAgent(outsider.address);
      expect(await vault.agent()).to.equal(outsider.address);
    });

    it("should allow owner to change router", async function () {
      await vault.setRouter(outsider.address);
      expect(await vault.allowedRouter()).to.equal(outsider.address);
    });

    it("should allow agent to pause", async function () {
      await vault.connect(agent).pause();
      expect(await vault.paused()).to.be.true;
    });

    it("should reject agent unpause", async function () {
      await vault.pause();
      await expect(
        vault.connect(agent).unpause()
      ).to.be.revertedWith("Not owner");
    });
  });

  describe("Vault State", function () {
    it("should return correct vault state", async function () {
      const state = await vault.getVaultState();
      expect(state._owner).to.equal(owner.address);
      expect(state._agent).to.equal(agent.address);
      expect(state._maxPositionPct).to.equal(500);
      expect(state._paused).to.be.false;
    });
  });
});
