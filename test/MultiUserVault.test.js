const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MultiUserVault", function () {
  const U = (n) => ethers.parseUnits(String(n), 6);
  const MAX_TRADE = U(1000);

  let vault, router, usdt, talpha, tbeta;
  let owner, agent, alice, bob;

  function arbPath(start = usdt.target, end = usdt.target) {
    return ethers.solidityPacked(
      ["address", "uint24", "address", "uint24", "address", "uint24", "address"],
      [start, 3000, talpha.target, 3000, tbeta.target, 3000, end]
    );
  }

  beforeEach(async function () {
    [owner, agent, alice, bob] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdt = await MockERC20.deploy("Test USDT", "tUSDT", 6);
    talpha = await MockERC20.deploy("TALPHA", "TALPHA", 18);
    tbeta = await MockERC20.deploy("TBETA", "TBETA", 18);

    router = await (await ethers.getContractFactory("MockSwapRouter")).deploy();
    await usdt.mint(router.target, U(1_000_000));

    vault = await (await ethers.getContractFactory("MultiUserVault")).deploy(
      usdt.target, agent.address, router.target, MAX_TRADE
    );

    for (const u of [alice, bob]) {
      await usdt.mint(u.address, U(100));
      await usdt.connect(u).approve(vault.target, ethers.MaxUint256);
    }
  });

  describe("deposits and withdrawals", function () {
    it("credits each user separately and registers them once", async function () {
      await vault.connect(alice).deposit(U(50));
      await vault.connect(alice).deposit(U(10));
      await vault.connect(bob).deposit(U(20));
      expect(await vault.balanceOf(alice.address)).to.equal(U(60));
      expect(await vault.balanceOf(bob.address)).to.equal(U(20));
      expect(await vault.getUsers()).to.deep.equal([alice.address, bob.address]);
      expect(await vault.totalBalances()).to.equal(U(80));
    });

    it("lets users withdraw only their own balance", async function () {
      await vault.connect(alice).deposit(U(50));
      await vault.connect(alice).withdraw(U(30));
      expect(await usdt.balanceOf(alice.address)).to.equal(U(80));
      await expect(vault.connect(alice).withdraw(U(21))).to.be.revertedWith("Insufficient balance");
      await expect(vault.connect(bob).withdraw(U(1))).to.be.revertedWith("Insufficient balance");
    });

    it("gives the owner and agent no way to take user funds", async function () {
      await vault.connect(alice).deposit(U(50));
      await expect(vault.connect(owner).withdraw(U(1))).to.be.revertedWith("Insufficient balance");
      await expect(vault.connect(agent).withdraw(U(1))).to.be.revertedWith("Insufficient balance");
    });

    it("blocks deposits but not withdrawals while paused", async function () {
      await vault.connect(alice).deposit(U(50));
      await vault.connect(agent).pause();
      await expect(vault.connect(bob).deposit(U(1))).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await vault.connect(alice).withdraw(U(50));
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
    });
  });

  describe("agent arbitrage", function () {
    beforeEach(async function () {
      await vault.connect(alice).deposit(U(50));
      await vault.connect(bob).deposit(U(50));
    });

    it("credits profit only to the user it traded for", async function () {
      await router.setReturnAmount(U("50.3"));
      await expect(vault.connect(agent).executeArbFor(alice.address, arbPath(), U(50), 0))
        .to.emit(vault, "ArbExecuted").withArgs(alice.address, U(50), U("50.3"), U("0.3"));

      expect(await vault.balanceOf(alice.address)).to.equal(U("50.3"));
      expect(await vault.balanceOf(bob.address)).to.equal(U(50));
      const stats = await vault.getUserStats(alice.address);
      expect(stats.profit).to.equal(U("0.3"));
      expect(stats.trades).to.equal(1n);
      expect(await usdt.balanceOf(vault.target)).to.equal(await vault.totalBalances());
      expect(await usdt.allowance(vault.target, router.target)).to.equal(0n);
    });

    it("reverts a trade that would return less than it spent", async function () {
      await router.setReturnAmount(U("49.9"));
      await expect(vault.connect(agent).executeArbFor(alice.address, arbPath(), U(50), 0))
        .to.be.revertedWith("Unprofitable");
      expect(await vault.balanceOf(alice.address)).to.equal(U(50));
    });

    it("only lets the agent trade", async function () {
      await expect(vault.connect(alice).executeArbFor(alice.address, arbPath(), U(50), 0))
        .to.be.revertedWith("Not agent");
      await expect(vault.connect(owner).executeArbFor(alice.address, arbPath(), U(50), 0))
        .to.be.revertedWith("Not agent");
    });

    it("cannot trade more than the user's balance or the max trade size", async function () {
      await expect(vault.connect(agent).executeArbFor(alice.address, arbPath(), U(51), 0))
        .to.be.revertedWith("Insufficient balance");
      await vault.setMaxTradeAmount(U(10));
      await expect(vault.connect(agent).executeArbFor(alice.address, arbPath(), U(20), 0))
        .to.be.revertedWith("Exceeds max trade");
    });

    it("rejects routes that don't start and end in the asset", async function () {
      await expect(vault.connect(agent).executeArbFor(alice.address, arbPath(talpha.target, usdt.target), U(50), 0))
        .to.be.revertedWith("Path must start with asset");
      await expect(vault.connect(agent).executeArbFor(alice.address, arbPath(usdt.target, talpha.target), U(50), 0))
        .to.be.revertedWith("Path must end with asset");
      const oneHop = ethers.solidityPacked(["address", "uint24", "address"], [usdt.target, 3000, usdt.target]);
      await expect(vault.connect(agent).executeArbFor(alice.address, oneHop, U(50), 0))
        .to.be.revertedWith("Bad hop count");
      await expect(vault.connect(agent).executeArbFor(alice.address, "0x1234", U(50), 0))
        .to.be.revertedWith("Bad path");
    });

    it("stops trading while paused; only the owner can unpause", async function () {
      await vault.connect(agent).pause();
      await expect(vault.connect(agent).executeArbFor(alice.address, arbPath(), U(50), 0))
        .to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(vault.connect(agent).unpause())
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await vault.unpause();
      await vault.connect(agent).executeArbFor(alice.address, arbPath(), U(50), 0);
    });
  });
});
