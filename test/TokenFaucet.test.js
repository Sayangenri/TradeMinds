const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TokenFaucet", function () {
  const DRIP = ethers.parseUnits("50", 6);
  const FUND = ethers.parseUnits("1000000", 6);
  const DAY = 24 * 60 * 60;

  let faucet, token, owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Test USDT", "tUSDT", 6);
    const Faucet = await ethers.getContractFactory("TokenFaucet");
    faucet = await Faucet.deploy(await token.getAddress(), DRIP, DAY);
    await token.mint(await faucet.getAddress(), FUND);
  });

  it("drips 50 tUSDT to the caller", async function () {
    await expect(faucet.connect(alice).claim())
      .to.emit(faucet, "Claimed").withArgs(alice.address, DRIP);
    expect(await token.balanceOf(alice.address)).to.equal(DRIP);
    expect(await token.balanceOf(await faucet.getAddress())).to.equal(FUND - DRIP);
  });

  it("claimFor credits the recipient, not the relayer", async function () {
    await faucet.connect(bob).claimFor(alice.address);
    expect(await token.balanceOf(alice.address)).to.equal(DRIP);
    expect(await token.balanceOf(bob.address)).to.equal(0n);
  });

  it("enforces the cooldown per recipient across claim and claimFor", async function () {
    await faucet.connect(alice).claim();
    await expect(faucet.connect(alice).claim()).to.be.revertedWith("Cooldown active");
    await expect(faucet.connect(bob).claimFor(alice.address)).to.be.revertedWith("Cooldown active");
    await faucet.connect(bob).claim();
  });

  it("allows claiming again after the cooldown", async function () {
    await faucet.connect(alice).claim();
    const next = await faucet.nextClaimAt(alice.address);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(next)]);
    await faucet.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(DRIP * 2n);
  });

  it("reverts when the faucet is empty", async function () {
    await faucet.setConfig(FUND + 1n, DAY);
    await expect(faucet.connect(alice).claim()).to.be.revertedWith("Faucet empty");
  });

  it("rejects the zero address", async function () {
    await expect(faucet.claimFor(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
  });

  it("restricts config and withdraw to the owner", async function () {
    await expect(faucet.connect(alice).setConfig(1, 1))
      .to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
    await expect(faucet.connect(alice).withdraw(1))
      .to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
    await faucet.withdraw(DRIP);
    expect(await token.balanceOf(owner.address)).to.equal(DRIP);
  });
});
