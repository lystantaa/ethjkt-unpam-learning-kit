import { useMemo, useState, useCallback, type ReactNode } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useReadContracts } from "wagmi";
import { readContract, writeContract, waitForTransactionReceipt } from "@wagmi/core";
import { formatUnits, parseUnits } from "viem";

import { CONFIG } from "../config";
import { ERC20_ABI, AMM_ABI } from "./abi";
import { wagmiConfig } from "./wagmi";

const SEPOLIA = CONFIG.SEPOLIA_CHAIN_ID;
const tokenA = { address: CONFIG.TOKEN_A.address, abi: ERC20_ABI };
const tokenB = { address: CONFIG.TOKEN_B.address, abi: ERC20_ABI };
const amm = { address: CONFIG.AMM_ADDRESS, abi: AMM_ABI };
const HKEY = "ks_hist_v2_" + String(CONFIG.AMM_ADDRESS).toLowerCase();

// ---------- helpers ----------
function fmt(raw, dec) {
  if (raw == null || dec == null) return "–";
  return Number(formatUnits(raw, dec)).toLocaleString("id-ID", { maximumFractionDigits: 4 });
}
function fmtNum(x) {
  return Number(x).toLocaleString("id-ID", { maximumFractionDigits: 4 });
}
function fmtPrice(x: number) {
  if (!isFinite(x) || x <= 0) return "–";
  if (x < 0.0001) return x.toExponential(3);
  return x.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
// rumus x*y=k + fee 0.3%
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inWithFee = amountIn * 997n;
  return (inWithFee * reserveOut) / (reserveIn * 1000n + inWithFee);
}
// slippage = (spotPrice - effectivePrice) / spotPrice * 100
function calcSlippage(amountIn: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint): number {
  if (amountIn <= 0n || amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0;
  const spotPrice = Number(reserveOut) / Number(reserveIn);
  const effectivePrice = Number(amountOut) / Number(amountIn);
  return Math.max(0, ((spotPrice - effectivePrice) / spotPrice) * 100);
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HKEY) || "[]"); }
  catch { return []; }
}
function trim(s: string): string {
  const n = Number(s);
  if (!isFinite(n)) return "";
  return String(Math.round(n * 1e6) / 1e6);
}
function shortErr(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return err?.shortMessage || err?.message || String(e);
}

// ---------- Price Chart Data ----------
// Generate x*y=k hyperbola points (normalized 0..1 range)
function generateCurvePoints(rA: bigint, rB: bigint, decA: number, decB: number, svgW = 300, svgH = 160) {
  if (rA <= 0n || rB <= 0n) return { path: "", dot: null, k: 0n };
  const k = rA * rB;
  const rANum = Number(formatUnits(rA, decA));
  const rBNum = Number(formatUnits(rB, decB));

  // x range: from 10% to 300% of current reserveA
  const xMin = rANum * 0.1;
  const xMax = rANum * 3.0;
  const steps = 80;
  const pts: [number, number][] = [];

  for (let i = 0; i <= steps; i++) {
    const x = xMin + (i / steps) * (xMax - xMin);
    const y = (rANum * rBNum) / x; // x*y = k  (using float for display)
    pts.push([x, y]);
  }

  // Find Y min/max for scaling
  const yMin = Math.min(...pts.map(p => p[1]));
  const yMax = Math.max(...pts.map(p => p[1]));
  const xRange = xMax - xMin;
  const yRange = yMax - yMin || 1;

  const pad = { l: 8, r: 8, t: 10, b: 10 };
  const plotW = svgW - pad.l - pad.r;
  const plotH = svgH - pad.t - pad.b;

  const toSvg = (x: number, y: number) => [
    pad.l + ((x - xMin) / xRange) * plotW,
    pad.t + plotH - ((y - yMin) / yRange) * plotH,
  ];

  const pathParts = pts.map(([x, y], i) => {
    const [sx, sy] = toSvg(x, y);
    return `${i === 0 ? "M" : "L"} ${sx.toFixed(1)} ${sy.toFixed(1)}`;
  });

  // Current price dot position
  const [dotX, dotY] = toSvg(rANum, rBNum);

  return { path: pathParts.join(" "), dot: { x: dotX, y: dotY }, k };
}

// ---------- MAIN APP ----------
export default function App() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const chainOk = chainId === SEPOLIA;

  const [tab, setTab] = useState("swap");       // swap | liquidity
  const [liqSub, setLiqSub] = useState("add");  // add | remove
  const [logTab, setLogTab] = useState("history"); // log | history
  const [swapDir, setSwapDir] = useState("AtoB");
  const [amountIn, setAmountIn] = useState("");
  const [addA, setAddA] = useState("");
  const [addB, setAddB] = useState("");
  const [removeShares, setRemoveShares] = useState("");
  const [busy, setBusy] = useState<{ key: string; text: string } | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [history, setHistory] = useState(loadHistory);

  // ---------- reads ----------
  const pool = useReadContracts({
    contracts: [
      { ...tokenA, functionName: "symbol" },
      { ...tokenA, functionName: "decimals" },
      { ...tokenB, functionName: "symbol" },
      { ...tokenB, functionName: "decimals" },
      { ...amm, functionName: "reserveA" },
      { ...amm, functionName: "reserveB" },
      { ...amm, functionName: "totalShares" },
    ],
    query: { refetchInterval: 10000 },
  });
  const user = useReadContracts({
    contracts: [
      { ...tokenA, functionName: "balanceOf", args: [address] },
      { ...tokenB, functionName: "balanceOf", args: [address] },
      { ...amm, functionName: "shares", args: [address] },
    ],
    query: { enabled: !!address },
  });

  const d = pool.data;
  const symA = (d?.[0]?.result as string) ?? "XEVO";
  const decA = d?.[1]?.result as number | undefined;
  const symB = (d?.[2]?.result as string) ?? "ETHJKT";
  const decB = d?.[3]?.result as number | undefined;
  const reserveA = (d?.[4]?.result as bigint) ?? 0n;
  const reserveB = (d?.[5]?.result as bigint) ?? 0n;
  const totalShares = (d?.[6]?.result as bigint) ?? 0n;
  const balA = user.data?.[0]?.result as bigint | undefined;
  const balB = user.data?.[1]?.result as bigint | undefined;
  const myShares = user.data?.[2]?.result as bigint | undefined;

  const ready = isConnected && chainOk && decA != null && decB != null;
  const hasPool = reserveA > 0n && reserveB > 0n;

  // Price calculations
  const spotPrice = useMemo(() => {
    if (!hasPool || decA == null || decB == null) return null;
    const rA = Number(formatUnits(reserveA, decA));
    const rB = Number(formatUnits(reserveB, decB));
    return { AtoB: rB / rA, BtoA: rA / rB };
  }, [reserveA, reserveB, decA, decB, hasPool]);

  // Constant k = reserveA * reserveB (raw bigint)
  const constantK = useMemo(() => {
    if (!hasPool) return 0n;
    return reserveA * reserveB;
  }, [reserveA, reserveB, hasPool]);

  // Chart data
  const chartData = useMemo(() => {
    if (!hasPool || decA == null || decB == null) return null;
    return generateCurvePoints(reserveA, reserveB, decA, decB, 400, 160);
  }, [reserveA, reserveB, decA, decB, hasPool]);

  function refresh() { pool.refetch(); user.refetch(); }
  function log(msg: string) {
    const t = new Date().toLocaleTimeString();
    setLogLines((prev) => [`[${t}] ${msg}`, ...prev].slice(0, 40));
  }
  function pushHistory(entry: unknown) {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 50);
      try { localStorage.setItem(HKEY, JSON.stringify(next)); } catch {}
      return next;
    });
    setLogTab("history");
  }

  // ---------- swap preview + slippage ----------
  const swapPreview = useMemo(() => {
    if (!amountIn || Number(amountIn) <= 0 || decA == null || decB == null) {
      return { out: "", slippage: 0 };
    }
    try {
      const rIn = swapDir === "AtoB" ? reserveA : reserveB;
      const rOut = swapDir === "AtoB" ? reserveB : reserveA;
      const inDec = swapDir === "AtoB" ? decA : decB;
      const outDec = swapDir === "AtoB" ? decB : decA;
      const amt = parseUnits(amountIn, inDec);
      const out = getAmountOut(amt, rIn, rOut);
      const slip = calcSlippage(amt, out, rIn, rOut);
      return { out: fmt(out, outDec), slippage: slip, outRaw: out, outDec };
    } catch { return { out: "", slippage: 0 }; }
  }, [amountIn, swapDir, reserveA, reserveB, decA, decB]);

  // Slippage level
  const slippageLevel = useMemo(() => {
    const s = swapPreview.slippage;
    if (s <= 0 || !amountIn) return null;
    if (s < 0.5) return "low";
    if (s < 3) return "medium";
    return "high";
  }, [swapPreview.slippage, amountIn]);

  const slippageIcon = { low: "✅", medium: "⚠️", high: "🚨" };
  const slippageMsg = {
    low: "Slippage rendah — transaksi aman",
    medium: "Slippage sedang — hati-hati",
    high: "Slippage tinggi! Jumlah terlalu besar vs pool",
  };

  // ---------- liquidity auto-pair ----------
  function onAddA(v: string) {
    setAddA(v);
    if (hasPool && v && Number(v) > 0 && decA != null && decB != null) {
      try {
        const amtA = parseUnits(v, decA);
        const amtB = (amtA * reserveB) / reserveA;
        setAddB(trim(formatUnits(amtB, decB)));
      } catch {}
    } else if (!v) setAddB("");
  }
  function onAddB(v: string) {
    setAddB(v);
    if (hasPool && v && Number(v) > 0 && decA != null && decB != null) {
      try {
        const amtB = parseUnits(v, decB);
        const amtA = (amtB * reserveA) / reserveB;
        setAddA(trim(formatUnits(amtA, decA)));
      } catch {}
    } else if (!v) setAddA("");
  }

  // ---------- write flows ----------
  async function ensureAllowance(token: typeof tokenA, amount: bigint, sym: string, setStep: (t: string) => void) {
    const cur = await readContract(wagmiConfig, {
      address: token.address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [address, CONFIG.AMM_ADDRESS],
    });
    if ((cur as bigint) >= amount) return;
    setStep(`Approve ${sym} — cek MetaMask`);
    log(`Approve ${sym}... konfirmasi di wallet`);
    const hash = await writeContract(wagmiConfig, {
      address: token.address,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONFIG.AMM_ADDRESS, amount],
    });
    setStep(`Approve ${sym} terkirim, nunggu…`);
    await waitForTransactionReceipt(wagmiConfig, { hash });
    log(`Approve ${sym} sukses.`);
  }

  async function doSwap() {
    if (!guard()) return;
    if (!amountIn || Number(amountIn) <= 0) return alert("Isi jumlah swap dulu.");
    const inSym = swapDir === "AtoB" ? symA : symB;
    const outSym = swapDir === "AtoB" ? symB : symA;
    const inDec = swapDir === "AtoB" ? decA : decB;
    const outDec = swapDir === "AtoB" ? decB : decA;
    const rIn = swapDir === "AtoB" ? reserveA : reserveB;
    const rOut = swapDir === "AtoB" ? reserveB : reserveA;
    const token = swapDir === "AtoB" ? tokenA : tokenB;
    const amount = parseUnits(amountIn, inDec!);
    const setStep = (t: string) => setBusy({ key: "swap", text: t });
    setStep("...");
    try {
      await ensureAllowance(token, amount, inSym, setStep);
      setStep("Konfirmasi swap di MetaMask");
      log("Kirim swap... konfirmasi di wallet");
      const hash = await writeContract(wagmiConfig, {
        address: CONFIG.AMM_ADDRESS,
        abi: AMM_ABI,
        functionName: swapDir === "AtoB" ? "swapAforB" : "swapBforA",
        args: [amount],
      });
      setStep("Menukar… (nunggu blok)");
      await waitForTransactionReceipt(wagmiConfig, { hash });
      const outRaw = getAmountOut(amount, rIn, rOut);
      const amtIn = Number(amountIn);
      const amtOut = Number(formatUnits(outRaw, outDec!));
      log(`Swap sukses! ${fmtNum(amtIn)} ${inSym} → ${fmtNum(amtOut)} ${outSym}`);
      pushHistory({
        type: "swap", hash, ts: Date.now(),
        aLogo: swapDir === "AtoB" ? CONFIG.TOKEN_A.logo : CONFIG.TOKEN_B.logo,
        aAmt: fmtNum(amtIn), aSym: inSym,
        bLogo: swapDir === "AtoB" ? CONFIG.TOKEN_B.logo : CONFIG.TOKEN_A.logo,
        bAmt: fmtNum(amtOut), bSym: outSym,
      });
      setAmountIn("");
      refresh();
    } catch (e) {
      log("Swap gagal: " + shortErr(e));
    } finally {
      setBusy(null);
    }
  }

  async function doAddLiquidity() {
    if (!guard()) return;
    if (!addA || !addB || Number(addA) <= 0 || Number(addB) <= 0) return alert("Isi jumlah A & B dulu.");
    const amtA = parseUnits(addA, decA!);
    const amtB = parseUnits(addB, decB!);
    const setStep = (t: string) => setBusy({ key: "add", text: t });
    setStep("...");
    try {
      await ensureAllowance(tokenA, amtA, symA, setStep);
      await ensureAllowance(tokenB, amtB, symB, setStep);
      setStep("Konfirmasi tambah di MetaMask");
      log("Kirim addLiquidity...");
      const hash = await writeContract(wagmiConfig, {
        address: CONFIG.AMM_ADDRESS, abi: AMM_ABI,
        functionName: "addLiquidity", args: [amtA, amtB],
      });
      setStep("Menambah… (nunggu blok)");
      await waitForTransactionReceipt(wagmiConfig, { hash });
      log("Tambah likuiditas sukses!");
      pushHistory({
        type: "add", hash, ts: Date.now(),
        aLogo: CONFIG.TOKEN_A.logo, aAmt: fmtNum(Number(addA)), aSym: symA,
        bLogo: CONFIG.TOKEN_B.logo, bAmt: fmtNum(Number(addB)), bSym: symB,
      });
      setAddA(""); setAddB("");
      refresh();
    } catch (e) {
      log("Tambah gagal: " + shortErr(e));
    } finally {
      setBusy(null);
    }
  }

  async function doRemoveLiquidity() {
    if (!guard()) return;
    if (!removeShares || Number(removeShares) <= 0) return alert("Isi jumlah share dulu.");
    const setStep = (t: string) => setBusy({ key: "remove", text: t });
    setStep("Konfirmasi tarik di MetaMask");
    try {
      log("Kirim removeLiquidity...");
      const hash = await writeContract(wagmiConfig, {
        address: CONFIG.AMM_ADDRESS, abi: AMM_ABI,
        functionName: "removeLiquidity", args: [parseUnits(removeShares, 18)],
      });
      setStep("Menarik… (nunggu blok)");
      await waitForTransactionReceipt(wagmiConfig, { hash });
      log("Tarik likuiditas sukses!");
      pushHistory({
        type: "remove", hash, ts: Date.now(),
        aLogo: CONFIG.TOKEN_A.logo, aAmt: "", aSym: symA,
        bLogo: CONFIG.TOKEN_B.logo, bAmt: "", bSym: symB,
      });
      setRemoveShares("");
      refresh();
    } catch (e) {
      log("Tarik gagal: " + shortErr(e));
    } finally {
      setBusy(null);
    }
  }

  function guard() {
    if (!isConnected) { alert("Connect wallet dulu."); return false; }
    if (!chainOk) { alert("Pindah ke Sepolia dulu (lewat tombol wallet)."); return false; }
    return true;
  }

  const fromSym = swapDir === "AtoB" ? symA : symB;
  const toSym = swapDir === "AtoB" ? symB : symA;
  const fromLogo = swapDir === "AtoB" ? CONFIG.TOKEN_A.logo : CONFIG.TOKEN_B.logo;
  const toLogo = swapDir === "AtoB" ? CONFIG.TOKEN_B.logo : CONFIG.TOKEN_A.logo;
  const actLabel = !isConnected ? "Connect dulu" : !chainOk ? "Jaringan salah" : null;

  // Pool share ratio for depth bar
  const mySharePct = useMemo(() => {
    if (!myShares || !totalShares || totalShares === 0n) return 0;
    return Math.min(100, Number((myShares * 10000n) / totalShares) / 100);
  }, [myShares, totalShares]);

  return (
    <div className="page">
      <img className="hero-title" src={CONFIG.TITLE_IMG} alt="AI & BLOCKCHAIN" />

      {/* HEADER */}
      <header className="head">
        <div className="brand">
          <img className="brand-logo" src={CONFIG.BRAND_LOGO} alt="ETHJKT" />
          <div>
            <p className="eyebrow">ETHJKT × UNPAM</p>
            <h1>XevoSwap</h1>
          </div>
        </div>
        {/* Live price ticker */}
        {spotPrice && (
          <div className="price-ticker">
            <span>1 {symA}</span>
            <strong>≈ {fmtPrice(spotPrice.AtoB)} {symB}</strong>
          </div>
        )}
        <ConnectButton chainStatus="icon" showBalance={false} />
      </header>

      <div className="cols">
        {/* ===== MAIN COLUMN ===== */}
        <div className="col col-main">
          {/* Tab selector */}
          <Glass className="pill tabs" inner="tabs-row">
            <button id="tab-swap" className={`tab ${tab === "swap" ? "tab--active" : ""}`} onClick={() => setTab("swap")}>
              ⟳ Swap
            </button>
            <button id="tab-liquidity" className={`tab ${tab === "liquidity" ? "tab--active" : ""}`} onClick={() => setTab("liquidity")}>
              💧 Liquidity
            </button>
          </Glass>

          {/* Main card */}
          <Glass className="card main">
            {tab === "swap" ? (
              <div className="view">
                {/* From box */}
                <div className="box">
                  <div className="box-top">
                    <span className="box-label">Kamu bayar</span>
                    {balA != null && decA != null && swapDir === "AtoB" && (
                      <span className="box-bal">Saldo: {fmt(balA, decA)} {symA}</span>
                    )}
                    {balB != null && decB != null && swapDir === "BtoA" && (
                      <span className="box-bal">Saldo: {fmt(balB, decB)} {symB}</span>
                    )}
                  </div>
                  <div className="box-mid">
                    <input
                      id="swap-amount-in"
                      type="number"
                      min="0"
                      placeholder="0.0"
                      value={amountIn}
                      onChange={(e) => setAmountIn(e.target.value)}
                    />
                    <span className="token-chip">
                      <img className="token-logo" src={fromLogo} alt="" />
                      {fromSym}
                    </span>
                  </div>
                </div>

                {/* Flip button */}
                <button
                  id="swap-flip"
                  className="flip"
                  title="Balik arah"
                  onClick={() => { setSwapDir(swapDir === "AtoB" ? "BtoA" : "AtoB"); setAmountIn(""); }}
                >
                  ⇅
                </button>

                {/* To box */}
                <div className="box">
                  <div className="box-top">
                    <span className="box-label">Kamu terima (perkiraan)</span>
                  </div>
                  <div className="box-mid">
                    <input
                      id="swap-amount-out"
                      type="text"
                      readOnly
                      placeholder="0.0"
                      value={swapPreview.out}
                    />
                    <span className="token-chip">
                      <img className="token-logo" src={toLogo} alt="" />
                      {toSym}
                    </span>
                  </div>
                </div>

                {/* SLIPPAGE WARNING (HAUS feature) */}
                {slippageLevel && (
                  <div className={`slippage-warning ${slippageLevel}`}>
                    <span className="slippage-icon">{slippageIcon[slippageLevel]}</span>
                    <span>{slippageMsg[slippageLevel]}</span>
                    <span className="slippage-pct">{swapPreview.slippage.toFixed(2)}%</span>
                  </div>
                )}

                <div className="actions">
                  <button
                    id="swap-btn"
                    className="act act--primary"
                    disabled={!ready || !!busy?.key}
                    onClick={doSwap}
                  >
                    {busy?.key === "swap"
                      ? <><span className="spinner" />{busy.text}</>
                      : actLabel || `⟳ Swap ${fromSym} → ${toSym}`}
                  </button>
                </div>
              </div>
            ) : (
              /* LIQUIDITY TAB */
              <div className="view">
                <div className="subtabs">
                  <button
                    id="liq-add-btn"
                    className={`subtab ${liqSub === "add" ? "subtab--active" : ""}`}
                    onClick={() => setLiqSub("add")}
                  >
                    + Tambah
                  </button>
                  <button
                    id="liq-remove-btn"
                    className={`subtab ${liqSub === "remove" ? "subtab--active" : ""}`}
                    onClick={() => setLiqSub("remove")}
                  >
                    ↑ Tarik
                  </button>
                </div>

                {liqSub === "add" ? (
                  <div className="view">
                    <div className="box">
                      <div className="box-top">
                        <span className="box-label">Setor {symA}</span>
                        {balA != null && decA != null && (
                          <span className="box-bal">Saldo: {fmt(balA, decA)}</span>
                        )}
                      </div>
                      <div className="box-mid">
                        <input
                          id="liq-add-a"
                          type="number"
                          min="0"
                          placeholder="0.0"
                          value={addA}
                          onChange={(e) => onAddA(e.target.value)}
                        />
                        <span className="token-chip">
                          <img className="token-logo" src={CONFIG.TOKEN_A.logo} alt="" />
                          {symA}
                        </span>
                      </div>
                    </div>
                    <div className="flip flip--plus">+</div>
                    <div className="box">
                      <div className="box-top">
                        <span className="box-label">Setor {symB}</span>
                        {balB != null && decB != null && (
                          <span className="box-bal">Saldo: {fmt(balB, decB)}</span>
                        )}
                      </div>
                      <div className="box-mid">
                        <input
                          id="liq-add-b"
                          type="number"
                          min="0"
                          placeholder="0.0"
                          value={addB}
                          onChange={(e) => onAddB(e.target.value)}
                        />
                        <span className="token-chip">
                          <img className="token-logo" src={CONFIG.TOKEN_B.logo} alt="" />
                          {symB}
                        </span>
                      </div>
                    </div>
                    <p className="hint">
                      {hasPool
                        ? "💡 Isi salah satu, satunya otomatis ngikut rasio pool (x·y=k)."
                        : "🌊 Pool baru: kamu yang tentuin harga awal — isi dua-duanya."}
                    </p>
                    <div className="actions">
                      <button
                        id="liq-add-submit"
                        className="act act--primary"
                        disabled={!ready || busy?.key === "add"}
                        onClick={doAddLiquidity}
                      >
                        {busy?.key === "add"
                          ? <><span className="spinner" />{busy.text}</>
                          : actLabel || "💧 Tambah Likuiditas"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="view">
                    <div className="box">
                      <div className="box-top">
                        <span className="box-label">Share ditarik</span>
                        <span className="box-bal">Punya: {fmt(myShares, 18)} shares</span>
                      </div>
                      <div className="box-mid">
                        <input
                          id="liq-remove-shares"
                          type="number"
                          min="0"
                          placeholder="0.0"
                          value={removeShares}
                          onChange={(e) => setRemoveShares(e.target.value)}
                        />
                        <button
                          className="token-chip chip-btn"
                          onClick={() => myShares != null && setRemoveShares(formatUnits(myShares, 18))}
                        >
                          MAX
                        </button>
                      </div>
                    </div>
                    {/* My share % bar */}
                    {mySharePct > 0 && (
                      <div className="depth-bar-wrap">
                        <div className="depth-label">
                          <span>Share kamu di pool</span>
                          <span style={{ color: "#a855f7", fontFamily: "Space Mono, monospace" }}>
                            {mySharePct.toFixed(2)}%
                          </span>
                        </div>
                        <div className="depth-bar">
                          <div className="depth-bar-fill" style={{ width: `${mySharePct}%` }} />
                        </div>
                      </div>
                    )}
                    <div className="actions">
                      <button
                        id="liq-remove-submit"
                        className="act act--primary"
                        disabled={!ready || busy?.key === "remove"}
                        onClick={doRemoveLiquidity}
                      >
                        {busy?.key === "remove"
                          ? <><span className="spinner" />{busy.text}</>
                          : actLabel || "↑ Tarik Likuiditas"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Glass>
        </div>

        {/* ===== SIDE COLUMN ===== */}
        <div className="col col-side">
          {/* Info card */}
          <Glass className="card info">
            <Row
              k="Akun"
              v={address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "belum connect"}
            />
            <Row
              k="Jaringan"
              v={!isConnected ? "–" : chainOk ? "✅ Sepolia" : `⚠️ chainId ${chainId}`}
            />
            <div className="hr" />
            <Row k={<>Saldo <b>{symA}</b></>} v={fmt(balA, decA)} />
            <Row k={<>Saldo <b>{symB}</b></>} v={fmt(balB, decB)} />
            <div className="hr" />
            <Row k={<>Reserve <b>{symA}</b></>} v={fmt(reserveA, decA)} />
            <Row k={<>Reserve <b>{symB}</b></>} v={fmt(reserveB, decB)} />
            <div className="hr" />
            {spotPrice && (
              <>
                <Row
                  k="Harga"
                  v={
                    <div className="price-display">
                      <span className="price-main">{fmtPrice(spotPrice.AtoB)}</span>
                      <span className="price-sub">{symB} per {symA}</span>
                    </div>
                  }
                />
                <div className="hr" />
              </>
            )}
            <Row k="Share kamu" v={fmt(myShares, 18)} />
            <Row k="Total shares" v={fmt(totalShares, 18)} />
            {mySharePct > 0 && (
              <div className="depth-bar-wrap" style={{ marginTop: "0.4rem" }}>
                <div className="depth-label">
                  <span>Porsi kamu</span>
                  <span style={{ color: "#a855f7", fontFamily: "Space Mono, monospace" }}>{mySharePct.toFixed(2)}%</span>
                </div>
                <div className="depth-bar">
                  <div className="depth-bar-fill" style={{ width: `${mySharePct}%` }} />
                </div>
              </div>
            )}
          </Glass>

          {/* BONUS: Price Chart — x·y=k curve */}
          {hasPool && chartData && (
            <Glass className="card chart-section">
              <div className="chart-header">
                <div>
                  <div className="chart-title">x · y = k Curve</div>
                  <div className="chart-subtitle">
                    {symA} / {symB} Pool
                  </div>
                </div>
                <div className="chart-badge">LIVE</div>
              </div>

              {/* SVG Chart */}
              <div className="chart-wrap">
                <svg viewBox="0 0 400 160" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="curveGrad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.9" />
                      <stop offset="50%" stopColor="#a855f7" stopOpacity="1" />
                      <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.9" />
                    </linearGradient>
                    <linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.02" />
                    </linearGradient>
                    <filter id="glow">
                      <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                      <feMerge>
                        <feMergeNode in="coloredBlur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>

                  {/* Grid lines */}
                  {[0.25, 0.5, 0.75].map((t) => (
                    <line
                      key={t}
                      x1="0" y1={t * 160}
                      x2="400" y2={t * 160}
                      stroke="rgba(124,58,237,0.1)"
                      strokeWidth="1"
                      strokeDasharray="4 4"
                    />
                  ))}
                  {[0.25, 0.5, 0.75].map((t) => (
                    <line
                      key={t}
                      x1={t * 400} y1="0"
                      x2={t * 400} y2="160"
                      stroke="rgba(124,58,237,0.1)"
                      strokeWidth="1"
                      strokeDasharray="4 4"
                    />
                  ))}

                  {/* Area fill under curve */}
                  {chartData.path && (
                    <path
                      d={chartData.path + ` L 392 160 L 8 160 Z`}
                      fill="url(#fillGrad)"
                    />
                  )}

                  {/* Main curve */}
                  {chartData.path && (
                    <path
                      d={chartData.path}
                      fill="none"
                      stroke="url(#curveGrad)"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      filter="url(#glow)"
                    />
                  )}

                  {/* Current price dot */}
                  {chartData.dot && (
                    <>
                      {/* Crosshair lines */}
                      <line
                        x1={chartData.dot.x} y1="0"
                        x2={chartData.dot.x} y2={chartData.dot.y}
                        stroke="rgba(6,182,212,0.4)"
                        strokeWidth="1"
                        strokeDasharray="3 3"
                      />
                      <line
                        x1="0" y1={chartData.dot.y}
                        x2={chartData.dot.x} y2={chartData.dot.y}
                        stroke="rgba(6,182,212,0.4)"
                        strokeWidth="1"
                        strokeDasharray="3 3"
                      />
                      {/* Outer glow ring */}
                      <circle
                        cx={chartData.dot.x}
                        cy={chartData.dot.y}
                        r="8"
                        fill="rgba(6,182,212,0.15)"
                        stroke="rgba(6,182,212,0.4)"
                        strokeWidth="1"
                      />
                      {/* Inner dot */}
                      <circle
                        cx={chartData.dot.x}
                        cy={chartData.dot.y}
                        r="4"
                        fill="#06b6d4"
                        filter="url(#glow)"
                      />
                    </>
                  )}
                </svg>
              </div>

              {/* Stats below chart */}
              <div className="chart-stats">
                <div className="chart-stat">
                  <span className="chart-stat-label">Reserve {symA}</span>
                  <span className="chart-stat-val">{fmt(reserveA, decA)}</span>
                </div>
                <div className="chart-stat">
                  <span className="chart-stat-label">Reserve {symB}</span>
                  <span className="chart-stat-val cyan">{fmt(reserveB, decB)}</span>
                </div>
                <div className="chart-stat">
                  <span className="chart-stat-label">K konstant</span>
                  <span className="chart-stat-val green" title={constantK.toString()}>
                    {(() => {
                      // Format large k into readable form
                      if (!hasPool || decA == null || decB == null) return "–";
                      const kNum = Number(formatUnits(constantK, decA + decB));
                      if (kNum === 0) return "–";
                      if (kNum >= 1e9) return (kNum / 1e9).toFixed(2) + "B";
                      if (kNum >= 1e6) return (kNum / 1e6).toFixed(2) + "M";
                      if (kNum >= 1e3) return (kNum / 1e3).toFixed(2) + "K";
                      return kNum.toFixed(4);
                    })()}
                  </span>
                </div>
              </div>
            </Glass>
          )}
        </div>
      </div>

      {/* ===== LOG + HISTORY ===== */}
      <Glass className="card">
        <div className="subtabs logtabs">
          <button
            id="log-tab-btn"
            className={`subtab ${logTab === "log" ? "subtab--active" : ""}`}
            onClick={() => setLogTab("log")}
          >
            📋 Log
          </button>
          <button
            id="history-tab-btn"
            className={`subtab ${logTab === "history" ? "subtab--active" : ""}`}
            onClick={() => setLogTab("history")}
          >
            🕐 Riwayat ({history.length})
          </button>
        </div>
        {logTab === "log" ? (
          <pre className="log">
            {logLines.length ? logLines.join("\n") : "Belum ada aktivitas — mulai swap atau tambah likuiditas!"}
          </pre>
        ) : (
          <div className="history">
            {history.length === 0 ? (
              <p className="hist-empty">🌊 Belum ada transaksi. Yuk swap pertamamu!</p>
            ) : (
              history.map((h, i) => <HistRow key={i} h={h} />)
            )}
          </div>
        )}
      </Glass>
    </div>
  );
}

// ---------- Small Components ----------
function Glass({
  className = "",
  inner = "col-inner",
  children,
}: {
  className?: string;
  inner?: string;
  children: ReactNode;
}) {
  return (
    <section className={`glass ${className}`}>
      <div className={`glass-content ${inner}`}>{children}</div>
    </section>
  );
}

function Row({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v mono">{v}</span>
    </div>
  );
}

function HistRow({ h }: { h: Record<string, unknown> }) {
  const short = h.hash ? String(h.hash).slice(0, 6) + "…" + String(h.hash).slice(-4) : "";
  const url = h.hash ? "https://sepolia.etherscan.io/tx/" + h.hash : "#";
  const dt = h.ts ? new Date(h.ts as number) : null;
  const date = dt ? dt.toLocaleDateString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
  const time = dt ? dt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "";
  const mid = h.type === "swap" ? "⟳" : h.type === "remove" ? "↑" : "+";
  const via = h.type === "swap" ? "Swap" : h.type === "remove" ? "Tarik LP" : "Tambah LP";
  return (
    <div className="hist-row">
      <span className="hist-token">
        <img className="hist-logo" src={h.aLogo as string} alt="" />
        <span className="hist-amt">{h.aAmt as string} {h.aSym as string}</span>
      </span>
      <span className="hist-arrow">{mid}</span>
      <span className="hist-token">
        <img className="hist-logo" src={h.bLogo as string} alt="" />
        <span className="hist-amt">{h.bAmt as string} {h.bSym as string}</span>
      </span>
      <span className="hist-via">
        <span className="hist-via-top">via <b>XevoSwap</b></span>
        <span className="hist-sub2">{via}</span>
      </span>
      <a className="hist-date" href={url} target="_blank" rel="noopener noreferrer">
        <span className="hist-d">{date} ↗</span>
        <span className="hist-t">{time}</span>
      </a>
      <span className="hist-check">✓</span>
    </div>
  );
}
