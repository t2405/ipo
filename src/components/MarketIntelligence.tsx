import React, { useState, useEffect } from "react";
import { 
  TrendingUp, 
  TrendingDown, 
  Minus, 
  Sparkles, 
  Settings, 
  Gauge, 
  Activity, 
  Loader2, 
  AlertCircle, 
  RefreshCw,
  Sliders,
  DollarSign,
  TrendingUp as BulletIcon,
  ChevronRight,
  Info
} from "lucide-react";
import { 
  ResponsiveContainer, 
  ComposedChart, 
  Bar, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  Legend 
} from "recharts";

interface Benchmark {
  value: number;
  change: number;
  pctChange: number;
  status: "BULLISH" | "BEARISH" | "STABLE" | "VOLATILE" | "COMPLACENT" | "NET_BUYERS" | "NET_SELLERS";
}

interface Benchmarks {
  nifty: Benchmark;
  sensex: Benchmark;
  banknifty: Benchmark;
  indiavix: Benchmark;
  fii: { flow: number; status: string };
  dii: { flow: number; status: string };
}

interface SectorImpact {
  sector: string;
  multiplierBias: string;
  status: "EXPANDING" | "CONTRACTING" | "STABLE";
  narrative: string;
}

interface AdjustmentResult {
  adjustedRiskScore: number;
  advisoryConsensus: string;
  gmpAdjustmentBias: string;
  sectorImpacts: SectorImpact[];
  benchmarks: Benchmarks;
}

export default function MarketIntelligence() {
  const [benchmarks, setBenchmarks] = useState<Benchmarks | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adjustment form states
  const [niftyBias, setNiftyBias] = useState<"BULLISH" | "BEARISH" | "NEUTRAL">("BULLISH");
  const [sensexBias, setSensexBias] = useState<"BULLISH" | "BEARISH" | "NEUTRAL">("BULLISH");
  const [bankniftyBias, setBankniftyBias] = useState<"BULLISH" | "BEARISH" | "NEUTRAL">("BEARISH");
  const [vixValue, setVixValue] = useState("14.22");
  const [fiiFlow, setFiiFlow] = useState("1240.50");
  const [diiFlow, setDiiFlow] = useState("-350.20");
  const [customScenario, setCustomScenario] = useState("");

  const [adjusting, setAdjusting] = useState(false);
  const [adjustedResult, setAdjustedResult] = useState<AdjustmentResult | null>(null);

  useEffect(() => {
    fetchBenchmarks();

    const interval = setInterval(() => {
      fetchBenchmarks();
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const fetchBenchmarks = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/market/indices", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to pull market benchmarks.");
      const data = await res.json();
      const mapped: Benchmarks = {
        nifty: {
          value: data.nifty,
          change: 0,
          pctChange: 0,
          status: "STABLE",
        },
        sensex: {
          value: data.sensex,
          change: 0,
          pctChange: 0,
          status: "STABLE",
        },
        banknifty: {
          value: data.bankNifty,
          change: 0,
          pctChange: 0,
          status: "STABLE",
        },
        indiavix: {
          value: data.indiaVix,
          change: 0,
          pctChange: 0,
          status: "STABLE",
        },
        fii: {
          flow: 0,
          status: "STABLE",
        },
        dii: {
          flow: 0,
          status: "STABLE",
        },
      };

      setBenchmarks(mapped);
      setVixValue(String(mapped.indiavix.value));
      setFiiFlow("0");
      setDiiFlow("0");
      setNiftyBias("NEUTRAL");
      setSensexBias("NEUTRAL");
      setBankniftyBias("NEUTRAL");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Unable to contact global broker gateways.");
    } finally {
      setLoading(false);
    }
  };

  const handleAdjustScores = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdjusting(true);
    setError(null);

    try {
      const res = await fetch("/api/market/adjust-scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          niftyBias,
          sensexBias,
          bankniftyBias,
          vixValue,
          fiiFlow,
          diiFlow,
          customScenario
        })
      });

      if (!res.ok) throw new Error("AI Score adjustment calculation failed.");
      const data = await res.json();
      setAdjustedResult(data);
      
      // Keep benchmark values in sync with returned ones
      if (data.benchmarks) {
        setBenchmarks(data.benchmarks);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Adjustment query failed.");
    } finally {
      setAdjusting(false);
    }
  };

  const getStatusColor = (status: string) => {
    if (status === "BULLISH" || status === "NET_BUYERS" || status === "EXPANDING") {
      return "text-emerald-500 bg-emerald-500/10 border-emerald-500/20";
    }
    if (status === "BEARISH" || status === "NET_SELLERS" || status === "VOLATILE" || status === "CONTRACTING") {
      return "text-rose-500 bg-rose-500/10 border-rose-500/20";
    }
    return "text-slate-400 bg-slate-500/10 border-slate-500/20";
  };

  const getArrowIcon = (status: string) => {
    if (status === "BULLISH" || status === "NET_BUYERS" || status === "EXPANDING") {
      return <TrendingUp className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-500 shrink-0" />;
    }
    if (status === "BEARISH" || status === "NET_SELLERS" || status === "VOLATILE" || status === "CONTRACTING") {
      return <TrendingDown className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-rose-500 shrink-0" />;
    }
    return <Minus className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-slate-400 shrink-0" />;
  };

  return (
    <div id="market-intelligence-workspace" className="space-y-4 sm:space-y-6 max-w-6xl mx-auto px-1 sm:px-0">
      {/* Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-border pb-4 sm:pb-5 gap-3 sm:gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-widest bg-emerald-500/10 text-emerald-500 px-2.5 py-0.5 sm:px-3 sm:py-1 rounded-full border border-emerald-500/20">
              Macro Intelligence
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground mt-1.5 sm:mt-2 flex items-center">
            <Gauge className="h-5 w-5 sm:h-6 sm:w-6 text-emerald-500 mr-2 shrink-0" />
            AI Market Intelligence Monitor
          </h1>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Track real-time macro indices including Nifty, Sensex, BankNifty, India VIX, FII, and DII capital flows. Adjust baseline scores to evaluate hypothetical risk impacts.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/5 border border-rose-500/20 rounded-xl p-3 sm:p-4 flex items-center space-x-2.5 sm:space-x-3 text-xs text-rose-500">
          <AlertCircle className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />
          <span className="leading-tight">{error}</span>
        </div>
      )}

      {/* Primary Benchmark Board Grid */}
      {benchmarks && (
        <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4">
          {/* Nifty */}
          <div className="bg-card border border-border rounded-xl p-3 sm:p-4 space-y-1.5 sm:space-y-2 relative overflow-hidden">
            <span className="text-[9px] sm:text-[10px] font-bold text-muted-foreground uppercase font-mono block truncate">Nifty 50</span>
            <div className="flex items-baseline gap-1 flex-wrap">
              <span className="text-sm sm:text-base font-black text-foreground">{benchmarks.nifty.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
          </div>

          {/* Sensex */}
          <div className="bg-card border border-border rounded-xl p-3 sm:p-4 space-y-1.5 sm:space-y-2 relative overflow-hidden">
            <span className="text-[9px] sm:text-[10px] font-bold text-muted-foreground uppercase font-mono block truncate">Sensex</span>
            <div className="flex items-baseline gap-1 flex-wrap">
              <span className="text-sm sm:text-base font-black text-foreground">{benchmarks.sensex.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
          </div>

          {/* BankNifty */}
          <div className="bg-card border border-border rounded-xl p-3 sm:p-4 space-y-1.5 sm:space-y-2 relative overflow-hidden">
            <span className="text-[9px] sm:text-[10px] font-bold text-muted-foreground uppercase font-mono block truncate">BankNifty</span>
            <div className="flex items-baseline gap-1 flex-wrap">
              <span className="text-sm sm:text-base font-black text-foreground">{benchmarks.banknifty.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
          </div>

          {/* India VIX */}
          <div className="bg-card border border-border rounded-xl p-3 sm:p-4 space-y-1.5 sm:space-y-2 relative overflow-hidden">
            <span className="text-[9px] sm:text-[10px] font-bold text-muted-foreground uppercase font-mono block truncate">India VIX</span>
            <div className="flex items-baseline gap-1 flex-wrap">
              <span className="text-sm sm:text-base font-black text-foreground">{benchmarks.indiavix.value.toFixed(2)}</span>
            </div>
          </div>

        </div>
      )}

      {/* Adjust AI Scores Simulator Sandbox */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Left column: Parameters Adjustment Panel */}
        <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-6">
          <h3 className="text-xs font-black text-foreground uppercase tracking-widest font-mono flex items-center">
            <Sliders className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-500 mr-1.5 shrink-0" />
            Adjust baseline scores
          </h3>
          <p className="text-[10px] text-muted-foreground mt-0.5 mb-4 sm:mb-5">
            Modify current capital flow sizes or bias ratings and trigger recalculation.
          </p>

          <form onSubmit={handleAdjustScores} className="space-y-3 sm:space-y-4">
            {/* Nifty bias */}
            <div>
              <label className="text-[9px] font-bold text-muted-foreground uppercase block mb-1">Nifty 50 Bias</label>
              <select
                value={niftyBias}
                onChange={(e: any) => setNiftyBias(e.target.value)}
                className="w-full bg-muted/20 border border-border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="BULLISH">Bullish (Expanding)</option>
                <option value="BEARISH">Bearish (Contracting)</option>
                <option value="NEUTRAL">Neutral (Stable)</option>
              </select>
            </div>

            {/* BankNifty bias */}
            <div>
              <label className="text-[9px] font-bold text-muted-foreground uppercase block mb-1">BankNifty Bias</label>
              <select
                value={bankniftyBias}
                onChange={(e: any) => setBankniftyBias(e.target.value)}
                className="w-full bg-muted/20 border border-border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="BULLISH">Bullish (Expanding)</option>
                <option value="BEARISH">Bearish (Contracting)</option>
                <option value="NEUTRAL">Neutral (Stable)</option>
              </select>
            </div>

            {/* Vix & Flow row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] font-bold text-muted-foreground uppercase block mb-1">India VIX Index</label>
                <input
                  type="number"
                  step="0.01"
                  value={vixValue}
                  onChange={(e) => setVixValue(e.target.value)}
                  className="w-full bg-muted/20 border border-border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1"
                />
              </div>

              <div>
                <label className="text-[9px] font-bold text-muted-foreground uppercase block mb-1">FII Net Flow (Cr)</label>
                <input
                  type="number"
                  step="0.1"
                  value={fiiFlow}
                  onChange={(e) => setFiiFlow(e.target.value)}
                  className="w-full bg-muted/20 border border-border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none"
                />
              </div>
            </div>

            {/* DII Flows */}
            <div>
              <label className="text-[9px] font-bold text-muted-foreground uppercase block mb-1">DII Net Flow (Cr)</label>
              <input
                type="number"
                step="0.1"
                value={diiFlow}
                onChange={(e) => setDiiFlow(e.target.value)}
                className="w-full bg-muted/20 border border-border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none"
              />
            </div>

            {/* Custom scenario string */}
            <div>
              <label className="text-[9px] font-bold text-muted-foreground uppercase block mb-1">Custom Scenario / Rumor override</label>
              <textarea
                value={customScenario}
                onChange={(e) => setCustomScenario(e.target.value)}
                placeholder="e.g. Union Budget cuts green subsidies, or sudden interest rate hike announcement..."
                className="w-full bg-muted/20 border border-border rounded-xl px-3 py-2 text-xs text-foreground focus:outline-none h-16 resize-none"
              />
            </div>

            <button
              type="submit"
              disabled={adjusting}
              className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold rounded-xl flex items-center justify-center space-x-2 transition-all cursor-pointer disabled:opacity-50"
            >
              {adjusting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                  <span>Computing Multipliers...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  <span>Recalculate Score Impact</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Right column: Impact Results Dashboard */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-6 flex flex-col justify-between">
          {adjustedResult ? (
            <div className="space-y-4 sm:space-y-6">
              <div className="flex justify-between items-start border-b border-border/60 pb-3 sm:pb-4 gap-2">
                <div>
                  <span className="text-[9px] font-bold text-emerald-500 uppercase font-mono block">Recalculated Risk Metrics</span>
                  <h4 className="text-xs sm:text-sm font-black text-foreground mt-0.5">Macro Valuation Impact Assessment</h4>
                </div>

                <div className="text-right shrink-0">
                  <span className="text-[9px] font-bold text-muted-foreground uppercase block">Calculated Risk Index</span>
                  <span className={`text-lg sm:text-xl font-extrabold ${adjustedResult.adjustedRiskScore > 60 ? "text-rose-500" : "text-emerald-500"}`}>
                    {adjustedResult.adjustedRiskScore} / 100
                  </span>
                </div>
              </div>

              {/* Advisoryconsensus banner */}
              <div className="p-3.5 sm:p-4 bg-muted/30 border border-border rounded-xl space-y-2">
                <span className="text-[9px] font-bold uppercase font-mono tracking-wider text-primary flex items-center">
                  <Info className="h-3.5 w-3.5 mr-1 shrink-0" />
                  Consensus Advisory
                </span>
                <p className="text-xs text-foreground leading-relaxed">
                  {adjustedResult.advisoryConsensus}
                </p>
                <div className="text-[10px] text-emerald-500 font-semibold bg-emerald-500/5 p-2 rounded-lg border border-emerald-500/10 mt-1">
                  <strong>GMP Bias:</strong> {adjustedResult.gmpAdjustmentBias}
                </div>
              </div>

              {/* Sector impacts list */}
              <div className="space-y-2.5 sm:space-y-3">
                <h5 className="text-[10px] font-bold text-muted-foreground uppercase font-mono tracking-wider">Sector Specific Multiplier Adjustments</h5>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 sm:gap-3">
                  {adjustedResult.sectorImpacts.map((sector, idx) => (
                    <div key={idx} className="bg-muted/10 border border-border/40 p-3 sm:p-3.5 rounded-xl space-y-1.5">
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-xs font-bold text-foreground truncate">{sector.sector}</span>
                        <span className={`text-[9px] sm:text-[10px] font-bold px-2 py-0.5 rounded shrink-0 ${getStatusColor(sector.status)}`}>
                          {sector.multiplierBias} ({sector.status})
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-normal">
                        {sector.narrative}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 sm:py-16 flex flex-col items-center justify-center space-y-3 sm:space-y-4 my-auto">
              <div className="bg-emerald-500/10 p-3.5 sm:p-4 rounded-full text-emerald-500 border border-emerald-500/25">
                <Activity className="h-7 w-7 sm:h-8 sm:w-8 animate-pulse" />
              </div>
              <div>
                <h4 className="text-xs sm:text-sm font-black text-foreground">Awaiting Score Adjustment Parameters</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">
                  Adjust any variables in the left panel and click "Recalculate Score Impact" to generate hypothetical valuation multipliers and IPO GMP risk spreads.
                </p>
              </div>
            </div>
          )}

          <div className="border-t border-border pt-3 sm:pt-4 mt-4 sm:mt-6 text-[9px] sm:text-[10px] text-muted-foreground flex flex-col sm:flex-row items-center justify-between font-mono gap-1 sm:gap-0">
            <span>Powered by Gemini 3.5 Flash Model</span>
            <span>State: Real-time Live Tracking ready</span>
          </div>
        </div>
      </div>
    </div>
  );
}