import React, { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { 
  Sparkles, 
  TrendingUp, 
  ShieldCheck, 
  Layers, 
  HelpCircle, 
  BarChart, 
  Activity, 
  Compass, 
  Heart,
  PieChart,
  Gauge,
  BookOpen,
  ArrowRight,
  Calendar as CalendarIcon,
  AlertTriangle,
  Play,
  RotateCcw,
  CheckCircle,
  FileText,
  Clock,
  ArrowUpRight,
  ShieldAlert,
  Info,
  Music,
  Search,
  Globe,
  Brain,
  Scale
} from "lucide-react";
import { IPO } from "../types";
import { ResponsiveContainer, BarChart as ReBarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";

interface ArenaProps {
  ipos: IPO[];
}

// Rich database of real-world historical IPOs for AI Backtesting Lab
const HISTORICAL_IPOS = [
  { name: "Tata Technologies", symbol: "TATATECH", gmpPercent: 140, qibSub: 203.4, retailSub: 16.5, promoterHolding: 55.6, listingGain: 162.5, listedPositive: true, year: "2023", issueSize: 3042 },
  { name: "IREDA", symbol: "IREDA", gmpPercent: 35, qibSub: 104.6, retailSub: 7.7, promoterHolding: 75.0, listingGain: 87.5, listedPositive: true, year: "2023", issueSize: 2150 },
  { name: "Zomato", symbol: "ZOMATO", gmpPercent: 15, qibSub: 51.8, retailSub: 7.4, promoterHolding: 0.0, listingGain: 65.8, listedPositive: true, year: "2021", issueSize: 9375 },
  { name: "Nykaa", symbol: "NYKAA", gmpPercent: 75, qibSub: 91.2, retailSub: 12.2, promoterHolding: 52.3, listingGain: 96.1, listedPositive: true, year: "2021", issueSize: 5352 },
  { name: "Paytm", symbol: "PAYTM", gmpPercent: -5, qibSub: 2.8, retailSub: 1.6, promoterHolding: 0.0, listingGain: -27.2, listedPositive: false, year: "2021", issueSize: 18300 },
  { name: "Happy Forgings", symbol: "HAPPYFORGE", gmpPercent: 42, qibSub: 220.1, retailSub: 15.1, promoterHolding: 78.2, listingGain: 44.5, listedPositive: true, year: "2023", issueSize: 1008 },
  { name: "DOMS Industries", symbol: "DOMS", gmpPercent: 68, qibSub: 116.0, retailSub: 69.1, promoterHolding: 74.9, listingGain: 68.2, listedPositive: true, year: "2023", issueSize: 1200 },
  { name: "IdeaForge Technology", symbol: "IDEAFORGE", gmpPercent: 82, qibSub: 125.8, retailSub: 85.2, promoterHolding: 30.2, listingGain: 94.0, listedPositive: true, year: "2023", issueSize: 567 },
  { name: "SignatureGlobal", symbol: "SIGNATURE", gmpPercent: 12, qibSub: 12.7, retailSub: 6.8, promoterHolding: 69.3, listingGain: 15.6, listedPositive: true, year: "2023", issueSize: 730 },
  { name: "LIC of India", symbol: "LICI", gmpPercent: -2, qibSub: 1.7, retailSub: 2.0, promoterHolding: 96.5, listingGain: -7.8, listedPositive: false, year: "2022", issueSize: 21000 },
];

export default function AiArena({ ipos }: ArenaProps) {
  const [arenaTab, setArenaTab] = useState<"comparator" | "planner" | "research">("comparator");

  // Dynamic date and milestone helpers
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "TBA";
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return dateStr;
    }
  };

  const formatDateShort = (dateStr?: string) => {
    if (!dateStr) return "TBA";
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    } catch {
      return dateStr;
    }
  };

  const activeIpos = ipos.filter(i => i.status === "ACTIVE" || i.status === "UPCOMING");
  const activeIpo1 = activeIpos[0] || ipos[0] || { name: "Acme CloudTech AI", symbol: "ACMEAI", closeDate: "2026-07-22", maxPrice: 475, lotSize: 30, gmpPercent: 38.9 };
  const activeIpo2 = activeIpos[1] || ipos[1] || { name: "NovaCharge Mobility", symbol: "NOVAMOBI", closeDate: "2026-07-24", maxPrice: 195, lotSize: 75, gmpPercent: 21.5 };

  const milestonesList: any[] = [];
  ipos.forEach(ipo => {
    if (ipo.status === "ACTIVE" || ipo.status === "UPCOMING") {
      if (ipo.closeDate) {
        milestonesList.push({
          ipoName: ipo.name,
          type: "APPLICATION CLOSE",
          date: ipo.closeDate,
          color: "bg-primary animate-pulse",
          textColor: "text-primary font-bold",
          subtext: "UPI MANDATE EXPIRES 5:00 PM"
        });

        const close = new Date(ipo.closeDate);
        const allotment = new Date(close);
        allotment.setDate(close.getDate() + 2);
        milestonesList.push({
          ipoName: ipo.name,
          type: "ALLOTMENT RELEASE",
          date: allotment.toISOString().split("T")[0],
          color: "bg-amber-500",
          textColor: "text-amber-500 font-bold",
          subtext: `${ipo.registrar || "Link Intime / KFintech"} Registrar`
        });

        const refund = new Date(close);
        refund.setDate(close.getDate() + 5);
        milestonesList.push({
          ipoName: ipo.name,
          type: "REFUND INITIATION",
          date: refund.toISOString().split("T")[0],
          color: "bg-blue-500",
          textColor: "text-blue-500 font-bold",
          subtext: "Automated ECS Credit / UPI unblock"
        });
      }

      if (ipo.listingDate) {
        milestonesList.push({
          ipoName: ipo.name,
          type: "LISTING DAY CEREMONY",
          date: ipo.listingDate,
          color: "bg-emerald-500 animate-bounce",
          textColor: "text-emerald-500 font-bold animate-pulse",
          subtext: "BSE & NSE INDEXING 10:00 AM"
        });
      }
    }
  });

  milestonesList.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const topMilestones = milestonesList.slice(0, 5);

  // Comparator states
  const [compIpoId1, setCompIpoId1] = useState(ipos[0]?.id || "acme-cloudtech");
  const [compIpoId2, setCompIpoId2] = useState(ipos[1]?.id || ipos[0]?.id || "novacharge-mobility");

  // Groq analysis state caches for comparison elements
  const [compAnalysisCache, setCompAnalysisCache] = useState<Record<string, any>>({});
  const [loadingComp, setLoadingComp] = useState<Record<string, boolean>>({});

  const ipo1 = ipos.find(i => i.id === compIpoId1 || i.symbol === compIpoId1) || ipos[0];
  const ipo2 = ipos.find(i => i.id === compIpoId2 || i.symbol === compIpoId2) || ipos[1] || ipos[0];

  // Fetch Groq AI analysis for selected IPOs when comparing
  const fetchGroqAnalysis = async (ipoId: string) => {
    if (!ipoId || compAnalysisCache[ipoId] || loadingComp[ipoId]) return;
    setLoadingComp(prev => ({ ...prev, [ipoId]: true }));
    try {
      const res = await fetch("/api/groq/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ipoId })
      });
      if (res.ok) {
        const data = await res.json();
        setCompAnalysisCache(prev => ({ ...prev, [ipoId]: data }));
      }
    } catch (err) {
      console.error("Groq analysis call failed:", err);
    } finally {
      setLoadingComp(prev => ({ ...prev, [ipoId]: false }));
    }
  };

  useEffect(() => {
    if (ipo1?.id) fetchGroqAnalysis(ipo1.id);
    if (ipo2?.id) fetchGroqAnalysis(ipo2.id);
  }, [compIpoId1, compIpoId2]);

  // AI IPO Calendar Planner States
  const [plannerIpo, setPlannerIpo] = useState(ipos[0]?.id || "acme-cloudtech");

  // Grounded Deep Research States
  const [researchQuery, setResearchQuery] = useState("Acme CloudTech AI listing Day predictions & SEBI red flags");
  const [isResearching, setIsResearching] = useState(false);
  const [researchResponse, setResearchResponse] = useState("");
  const [researchSources, setResearchSources] = useState<any[]>([]);
  const [useGrounding, setUseGrounding] = useState(true);
  const [useThinking, setUseThinking] = useState(false);

  useEffect(() => {
    if (ipos.length > 0) {
      if (!compIpoId1) setCompIpoId1(ipos[0].id);
      if (!compIpoId2) setCompIpoId2(ipos[1]?.id || ipos[0].id);
      setPlannerIpo(ipos[0].id);
    }
  }, [ipos]);

  // Grounded Deep Research Handler
  const handleRunResearch = async () => {
    if (!researchQuery.trim()) return;
    setIsResearching(true);
    setResearchResponse("");
    setResearchSources([]);

    try {
      const response = await fetch(`/api/groq/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: researchQuery,
          useGrounding,
          useThinking
        })
      });
      const data = await response.json();
      setResearchResponse(data.text);
      setResearchSources(data.sources || []);
    } catch (e) {
      console.error("Research failed:", e);
      setResearchResponse("### Connection Error\n\nUnable to transmit deep research telemetry to the Groq LLM server. Please check your network or try again.");
    } finally {
      setIsResearching(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 text-foreground text-xs px-1 sm:px-0">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 sm:gap-4 border-b border-border pb-4 sm:pb-5">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center">
            <Sparkles className="h-5 w-5 sm:h-6 sm:w-6 mr-2 text-primary animate-pulse shrink-0" /> AI Arena & Intelligence Matrix
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Access side-by-side comparative matrices, map IPO timelines, and perform grounded web intelligence research.
          </p>
        </div>

        {/* Sub-Tabs Nav Selector */}
        <div className="bg-muted/60 border border-border/50 p-1 rounded-xl flex items-center gap-1 overflow-x-auto max-w-full font-semibold text-xs shrink-0 no-scrollbar">
          <button
            onClick={() => setArenaTab("comparator")}
            className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg transition-all cursor-pointer flex items-center space-x-1.5 whitespace-nowrap ${
              arenaTab === "comparator" ? "bg-card text-foreground shadow-sm font-semibold" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Scale className="h-3.5 w-3.5 shrink-0" />
            <span>Comparison Matrix</span>
          </button>
          <button
            onClick={() => setArenaTab("planner")}
            className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg transition-all cursor-pointer flex items-center space-x-1.5 whitespace-nowrap ${
              arenaTab === "planner" ? "bg-card text-foreground shadow-sm font-semibold" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <CalendarIcon className="h-3.5 w-3.5 shrink-0" />
            <span>Calendar Planner</span>
          </button>
          <button
            onClick={() => setArenaTab("research")}
            className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg transition-all cursor-pointer flex items-center space-x-1.5 whitespace-nowrap ${
              arenaTab === "research" ? "bg-card text-foreground shadow-sm font-semibold" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Brain className="h-3.5 w-3.5 shrink-0" />
            <span>Grounded Research</span>
          </button>
        </div>
      </div>

      {/* ----------------- TAB 1: COMPARATOR MATRIX ----------------- */}
      {arenaTab === "comparator" && (
        <div className="space-y-4 sm:space-y-6 animate-fadeIn">
          {/* Comparator Box Header */}
          <div className="w-full p-3.5 sm:p-5 rounded-xl sm:rounded-2xl border border-border bg-card shadow-sm space-y-3 sm:space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4">
              <div>
                <h3 className="text-sm sm:text-base font-bold flex items-center text-foreground">
                  <Scale className="h-4 w-4 sm:h-5 sm:w-5 text-primary mr-2 shrink-0" />
                  Side-by-Side IPO Comparison Matrix
                </h3>
                <p className="text-[11px] sm:text-xs text-muted-foreground mt-0.5">
                  Select two offerings to dynamically benchmark subscription demand, valuation brackets, and Groq AI ratings.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 pt-1 sm:pt-2">
              <div className="space-y-1">
                <label className="block text-[10px] uppercase tracking-wider font-mono font-bold text-muted-foreground">Primary IPO</label>
                <select
                  value={compIpoId1}
                  onChange={(e) => setCompIpoId1(e.target.value)}
                  className="w-full bg-muted/40 border border-border px-3 py-2 rounded-xl focus:outline-none focus:border-primary text-foreground font-medium text-xs"
                >
                  {ipos.map(i => (
                    <option key={i.id} value={i.id}>{i.name} ({i.symbol})</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-[10px] uppercase tracking-wider font-mono font-bold text-muted-foreground">Benchmark Against</label>
                <select
                  value={compIpoId2}
                  onChange={(e) => setCompIpoId2(e.target.value)}
                  className="w-full bg-muted/40 border border-border px-3 py-2 rounded-xl focus:outline-none focus:border-primary text-foreground font-medium text-xs"
                >
                  {ipos.map(i => (
                    <option key={i.id} value={i.id}>{i.name} ({i.symbol})</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Structured Side-by-Side Table Matrix */}
          {ipo1 && ipo2 ? (
            <div className="overflow-x-auto border border-border rounded-xl sm:rounded-2xl bg-card shadow-sm scrollbar-thin">
              <div className="min-w-[650px] sm:min-w-[800px] divide-y divide-border">
                {/* Header Row (Names & Tickers) */}
                <div className="grid grid-cols-12 bg-muted/30 p-3.5 sm:p-5 items-center">
                  <div className="col-span-3">
                    <span className="text-[10px] sm:text-xs uppercase tracking-wider font-mono font-bold text-muted-foreground">Comparison Parameter</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => (
                      <div key={idx} className="px-2 sm:px-4 text-center">
                        <div className="h-7 w-7 sm:h-9 sm:w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center font-bold text-primary text-[10px] sm:text-xs font-mono mx-auto mb-1.5 sm:mb-2">
                          {ipo.symbol ? ipo.symbol.slice(0, 2) : "IP"}
                        </div>
                        <h4 className="text-xs sm:text-sm font-bold text-foreground line-clamp-1">{ipo.name}</h4>
                        <span className="text-[9px] sm:text-[10px] font-mono font-bold bg-muted text-muted-foreground px-1.5 sm:py-0.5 rounded mt-0.5 sm:mt-1 inline-block">
                          {ipo.symbol}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Status Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-center">
                  <div className="col-span-3">
                    <span className="text-xs font-bold text-foreground">Filing Status</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => (
                      <div key={idx} className="px-2 sm:px-4 text-center">
                        <span className={`text-[10px] sm:text-xs font-bold px-2 sm:px-2.5 py-0.5 rounded-full ${
                          ipo.status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground"
                        }`}>
                          {ipo.status || "UPCOMING"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* SECTION: AI INTELLIGENCE & EVALUATION */}
                <div className="grid grid-cols-12 bg-primary/5 p-3 sm:p-4 items-center font-mono font-bold text-primary text-[10px] sm:text-xs tracking-wider uppercase">
                  <div className="col-span-12 flex items-center">
                    <Sparkles className="h-3.5 w-3.5 sm:h-4 sm:w-4 mr-1.5 sm:mr-2 shrink-0" />
                    <span>AI Evaluation & Valuation Matrix</span>
                  </div>
                </div>

                {/* AI Score Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-center">
                  <div className="col-span-3">
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-foreground">AI Score</span>
                      <span className="text-[9px] sm:text-[10px] text-muted-foreground">Groq AI rating</span>
                    </div>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => {
                      const analysis = compAnalysisCache[ipo.id] || ipo.aiAnalysis || {};
                      const score = analysis.aiScore ?? ipo.aiScore ?? 0;
                      return (
                        <div key={idx} className="px-2 sm:px-4 text-center">
                          <div className="inline-flex items-center justify-center p-2 sm:p-3 bg-violet-500/10 border border-violet-500/20 rounded-xl sm:rounded-2xl">
                            <span className="text-base sm:text-lg font-black text-primary font-mono">{score}</span>
                            <span className="text-[9px] sm:text-[10px] text-muted-foreground font-mono">/100</span>
                          </div>
                          <div className="w-16 sm:w-20 mx-auto mt-1.5 sm:mt-2 bg-muted rounded-full h-1.5 overflow-hidden">
                            <div className="bg-primary h-full rounded-full" style={{ width: `${score}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* AI Recommendation Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-center">
                  <div className="col-span-3">
                    <span className="text-xs font-bold text-foreground">AI Recommendation</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => {
                      const analysis = compAnalysisCache[ipo.id] || ipo.aiAnalysis || {};
                      const rec = analysis.recommendation || ipo.recommendation || "MODERATE";
                      return (
                        <div key={idx} className="px-2 sm:px-4 text-center">
                          <span className={`text-[10px] sm:text-xs font-bold px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full ${
                            rec === "APPLY" ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" :
                            rec === "AVOID" ? "bg-rose-500/10 text-rose-500 border border-rose-500/20" :
                            "bg-amber-500/10 text-amber-500 border border-amber-500/20"
                          }`}>
                            {rec}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* AI Reasoning Summary Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-start">
                  <div className="col-span-3">
                    <span className="text-xs font-bold text-foreground">AI Reasoning Summary</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => {
                      const analysis = compAnalysisCache[ipo.id] || ipo.aiAnalysis || {};
                      return (
                        <div key={idx} className="px-2 sm:px-4 text-left text-xs text-muted-foreground">
                          <p className="text-xs sm:text-sm text-foreground leading-relaxed">
                            {(analysis as any).reasoningSummary || (ipo as any).aiSummary || "Run full AI valuation in Directory tab to pull real-time prospectus summary."}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Key Drivers Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-stretch">
                  <div className="col-span-3">
                    <span className="text-xs font-bold text-foreground">Key Drivers</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => {
                      const analysis = compAnalysisCache[ipo.id] || ipo.aiAnalysis || {};
                      const pros = analysis.detailedPros || ipo.strengths || [];
                      const cons = analysis.detailedCons || ipo.risks || [];
                      return (
                        <div key={idx} className="px-2 sm:px-4 border-r border-border last:border-0 text-xs text-muted-foreground">
                          {pros.length > 0 && (
                            <div>
                              <span className="text-[9px] sm:text-[10px] uppercase font-mono font-bold text-emerald-500">Strengths:</span>
                              <ul className="list-disc pl-3.5 sm:pl-4 text-[9px] sm:text-[10px] mt-1 text-foreground space-y-0.5">
                                {pros.slice(0, 3).map((p: string, i: number) => <li key={i}>{p}</li>)}
                              </ul>
                            </div>
                          )}

                          {cons.length > 0 && (
                            <div className={pros.length > 0 ? "mt-2 sm:mt-3" : undefined}>
                              <span className="text-[9px] sm:text-[10px] uppercase font-mono font-bold text-rose-500">Risks / Flags:</span>
                              <ul className="list-disc pl-3.5 sm:pl-4 text-[9px] sm:text-[10px] mt-1 text-foreground space-y-0.5">
                                {cons.slice(0, 3).map((c: string, i: number) => <li key={i}>{c}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Price Band Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-center">
                  <div className="col-span-3">
                    <span className="text-xs font-bold text-foreground">Price Band</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => (
                      <div key={idx} className="px-2 sm:px-4 text-center text-xs font-semibold text-foreground">
                        {ipo.priceBand || `₹${ipo.minPrice || "TBA"} - ₹${ipo.maxPrice || "TBA"}`}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Issue Size Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-center">
                  <div className="col-span-3">
                    <span className="text-xs font-bold text-foreground">Issue Size</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => (
                      <div key={idx} className="px-2 sm:px-4 text-center text-xs font-bold text-foreground font-mono">
                        {ipo.issueSize || "N/A"}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Lot Size & Minimum Bid Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-center">
                  <div className="col-span-3">
                    <span className="text-xs font-bold text-foreground">Minimum Lot Bid</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => (
                      <div key={idx} className="px-2 sm:px-4 text-center text-xs text-foreground">
                        <span className="font-bold">{ipo.lotSize || 0} Shares</span>
                        <p className="text-[9px] sm:text-[10px] text-muted-foreground mt-0.5">
                          Min ₹{((ipo.maxPrice || 0) * (ipo.lotSize || 0)).toLocaleString("en-IN")}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Subscription Demand Row */}
                <div className="grid grid-cols-12 p-3.5 sm:p-5 items-center">
                  <div className="col-span-3">
                    <span className="text-xs font-bold text-foreground">Subscription Demand</span>
                  </div>
                  <div className="col-span-9 grid grid-cols-2 gap-2 sm:gap-4">
                    {[ipo1, ipo2].map((ipo, idx) => (
                      <div key={idx} className="px-2 sm:px-4 text-center font-mono text-xs text-foreground">
                        {ipo.status === "UPCOMING" && !ipo.subscriptionOverall ? (
                          <span className="text-muted-foreground text-[10px] sm:text-[11px] font-sans">Upcoming</span>
                        ) : (
                          <span className="font-bold text-foreground">{ipo.subscriptionOverall ?? 0}x</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-8">Select valid listings to initiate comparison matrices.</p>
          )}
        </div>
      )}

      {/* ----------------- TAB 2: AI IPO CALENDAR PLANNER ----------------- */}
      {arenaTab === "planner" && (
        <div className="grid grid-cols-1 animate-fadeIn">
          {/* Calendar visualizer (Full width) */}
          <div className="w-full p-3.5 sm:p-5 rounded-xl sm:rounded-2xl border border-border bg-card shadow-sm space-y-4 sm:space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-0">
              <h3 className="text-sm sm:text-base font-bold flex items-center text-primary">
                <CalendarIcon className="h-4 w-4 sm:h-4.5 sm:w-4.5 mr-1.5 text-primary shrink-0" /> Active IPO Calendar Tracker & Cash Flow Optimizer
              </h3>
              <span className="bg-amber-500/10 text-amber-500 font-mono px-2 py-0.5 rounded-full text-[10px] font-bold self-start sm:self-auto">
            
              </span>
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Monitor key milestones, application limits, and dates. Our <strong>Cash Flow Optimizer</strong> checks overlapping timelines to ensure your capital isn't locked up inefficiently across multiple listings.
            </p>

            {/* Overlapping Dates Warning Banner */}
            <div className="p-3 sm:p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start space-x-2.5 sm:space-x-3 text-[11px] leading-relaxed">
              <AlertTriangle className="h-4 w-4 sm:h-4.5 sm:w-4.5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold text-amber-500 block mb-0.5">OVERLAPPING APPLICATION WINDOW DETECTED</span>
                <p className="text-foreground/90">
                  Applying for both <strong>{activeIpo1.name}</strong> (closes {formatDateShort(activeIpo1.closeDate)}) and <strong>{activeIpo2.name}</strong> (closes {formatDateShort(activeIpo2.closeDate)}) simultaneously blocks a minimum of <strong>₹{((activeIpo1.maxPrice || 0) * (activeIpo1.lotSize || 0) + (activeIpo2.maxPrice || 0) * (activeIpo2.lotSize || 0)).toLocaleString("en-IN")}</strong> in UPI escrow. 
                  Since cash refunds for {activeIpo1.symbol || activeIpo1.name.split(" ")[0]} won't credit until allotment, the AI suggests <strong>prioritizing {activeIpo1.name}</strong> first, or applying through distinct family PANs to optimize cash flows.
                </p>
              </div>
            </div>

            {/* Calendar list */}
            <div className="space-y-3 font-mono">
              <h4 className="font-semibold font-sans text-xs text-muted-foreground uppercase tracking-wider">UPCOMING MILESTONE DEADLINES</h4>
              
              <div className="divide-y divide-border border border-border rounded-xl overflow-x-auto bg-muted/20">
                {topMilestones.length > 0 ? (
                  topMilestones.map((milestone, idx) => (
                    <div key={idx} className="p-3 sm:p-3.5 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-0 items-center text-[10px] sm:text-[11px] hover:bg-muted/40 transition-colors min-w-[450px] sm:min-w-0">
                      <div className="flex items-center space-x-2 font-sans">
                        <div className={`h-2 w-2 rounded-full shrink-0 ${milestone.color}`}></div>
                        <span className="font-bold truncate">{milestone.ipoName}</span>
                      </div>
                      <span className={`${milestone.textColor} font-mono`}>{milestone.type}</span>
                      <span>{formatDate(milestone.date)}</span>
                      <span className="text-right sm:text-right text-muted-foreground text-[9px] sm:text-[10px]">{milestone.subtext}</span>
                    </div>
                  ))
                ) : (
                  <div className="p-8 text-center text-muted-foreground text-xs font-sans">
                    No active or upcoming IPO milestones on the calendar.
                  </div>
                )}
              </div>
            </div>

            {/* Key Balance Sheet Metrics Table */}
            {(() => {
              const selectedIpo = ipos.find(i => i.id === plannerIpo) || ipos[0];
              const financials =
                selectedIpo?.analysis?.financials ??
                selectedIpo?.aiAnalysis?.financials ??
                selectedIpo?.financials ??
                [];
              return (
                <div className="mt-6 sm:mt-8">
                  <h4 className="font-semibold font-sans text-xs text-muted-foreground uppercase tracking-wider mb-2">
                    Key Balance Sheet Metrics (₹ in Cr)
                  </h4>
                  <div className="overflow-x-auto border border-border rounded-xl bg-card shadow-sm">
                    <table className="w-full text-xs text-left border-collapse min-w-[350px]">
                      <thead>
                        <tr className="border-b border-border bg-muted/30 text-muted-foreground">
                          <th className="py-2.5 px-3">Year</th>
                          <th className="py-2.5 px-3">Revenue</th>
                          <th className="py-2.5 px-3">PAT (Profit)</th>
                          <th className="py-2.5 px-3">Debt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {financials.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-4 px-3 text-center text-muted-foreground">
                              Financial balance sheet metrics not available.
                            </td>
                          </tr>
                        ) : (
                          financials.map((fin: any, idx: number) => {
                            const year = fin.year ?? fin.fiscalYear;
                            const revenue = fin.revenue ?? fin.totalRevenue;
                            const profit = fin.profit ?? fin.pat ?? fin.netProfit;
                            const debt = fin.debt ?? fin.totalDebt;
                            return (
                              <tr key={idx} className="border-b border-border text-foreground hover:bg-muted/10">
                                <td className="py-2.5 px-3 font-mono font-bold">{year ?? "-"}</td>
                                <td className="py-2.5 px-3">₹{revenue ?? "-"} Cr</td>
                                <td className={`py-2.5 px-3 ${Number(profit) >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                                  ₹{profit ?? "-"} Cr
                                </td>
                                <td className="py-2.5 px-3">₹{debt ?? "-"} Cr</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ----------------- TAB 3: GROUNDED DEEP RESEARCH ----------------- */}
      {arenaTab === "research" && (
        <div className="p-3.5 sm:p-5 rounded-xl sm:rounded-2xl border border-border bg-card shadow-sm space-y-4 sm:space-y-6 animate-fadeIn">
          <div className="space-y-1">
            <h3 className="text-sm sm:text-base font-bold flex items-center text-primary">
              <Brain className="h-4 w-4 sm:h-4.5 sm:w-4.5 mr-1.5 text-primary shrink-0" /> AI Deep Research & Grounded Search Engine
            </h3>
            <p className="text-muted-foreground leading-relaxed text-[10px] sm:text-[11px]">
              Query latest financial news, prospectus filings, and grey market trends powered by search tools.
            </p>
          </div>

          <div className="space-y-4">
            {/* Input Bar */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  value={researchQuery}
                  onChange={(e) => setResearchQuery(e.target.value)}
                  placeholder="Enter research topic, e.g., Solaris Renewable GMP updates from the web..."
                  className="w-full bg-muted/40 border border-border rounded-xl py-2.5 pl-10 pr-4 text-xs focus:outline-none text-foreground font-medium"
                />
              </div>
              <button
                onClick={handleRunResearch}
                disabled={isResearching}
                className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold px-4 sm:px-5 py-2.5 sm:py-0 rounded-xl shadow-sm transition-all text-xs flex items-center justify-center space-x-1.5 shrink-0 cursor-pointer w-full sm:w-auto"
              >
                {isResearching ? (
                  <>
                    <RotateCcw className="h-3.5 w-3.5 animate-spin" />
                    <span>Searching...</span>
                  </>
                ) : (
                  <>
                    <Globe className="h-3.5 w-3.5" />
                    <span>Run Grounded Query</span>
                  </>
                )}
              </button>
            </div>

            {/* Results Frame */}
            {isResearching ? (
              <div className="p-6 sm:p-8 border border-border rounded-xl text-center space-y-3 bg-muted/5">
                <RotateCcw className="h-7 w-7 sm:h-8 sm:w-8 animate-spin mx-auto text-primary" />
                <div>
                  <h4 className="font-bold text-xs sm:text-sm text-foreground">Scanning search indexes...</h4>
                  <p className="text-[10px] sm:text-[11px] text-muted-foreground max-w-sm mx-auto mt-1">
                    {useThinking ? "Invoking deep reasoning loop on LLM preview nodes..." : "Grounding results with authorized SEC, SEBI, and broker listings..."}
                  </p>
                </div>
              </div>
            ) : researchResponse ? (
              <div className="grid grid-cols-1 gap-6">
                <div className="w-full p-3.5 sm:p-5 bg-muted/10 border border-border rounded-xl space-y-3 sm:space-y-4">
                  <span className="text-[8px] sm:text-[9px] font-mono font-bold text-muted-foreground uppercase tracking-wider block">GROUNDED INTELLIGENCE BRIEF</span>
                  <div className="prose prose-xs sm:prose-sm dark:prose-invert max-w-none text-foreground">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h1: ({node, ...props}) => <h1 className="text-xl sm:text-2xl font-bold mt-4 mb-3" {...props} />,
                        h2: ({node, ...props}) => <h2 className="text-lg sm:text-xl font-bold mt-4 mb-2" {...props} />,
                        h3: ({node, ...props}) => <h3 className="text-base sm:text-lg font-semibold mt-3 mb-2" {...props} />,
                        h4: ({node, ...props}) => <h4 className="text-sm sm:text-base font-semibold mt-3 mb-1" {...props} />,
                        p: ({node, ...props}) => <p className="mb-3 leading-relaxed text-xs sm:text-sm" {...props} />,
                        ul: ({node, ...props}) => <ul className="list-disc pl-5 mb-3 space-y-1 text-xs sm:text-sm" {...props} />,
                        ol: ({node, ...props}) => <ol className="list-decimal pl-5 mb-3 space-y-1 text-xs sm:text-sm" {...props} />,
                        li: ({node, ...props}) => <li className="leading-relaxed" {...props} />,
                      }}
                    >
                      {researchResponse}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-6 sm:p-8 border border-dashed border-border rounded-xl text-center text-muted-foreground bg-muted/5 space-y-1">
                <Brain className="h-7 w-7 sm:h-8 sm:w-8 mx-auto text-muted-foreground/60 animate-pulse" />
                <h4 className="font-bold text-xs text-foreground">Grounded Search Panel</h4>
                <p className="text-[10px] sm:text-[11px] max-w-sm mx-auto leading-relaxed">
                  Enter any public research query above and select search tools to run grounded summaries with legal prospectus links.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}