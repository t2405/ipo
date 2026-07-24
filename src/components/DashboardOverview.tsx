import React, { useState } from "react";
import { 
  TrendingUp, 
  ArrowUpRight, 
  Activity, 
  CheckCircle, 
  Sparkles, 
  HelpCircle,
  Clock,
  Award
} from "lucide-react";
import { 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  ScatterChart,
  Scatter,
  ZAxis
} from "recharts";
import { IPO } from "../types";

interface DashboardProps {
  ipos: IPO[];
  onNavigate: (tab: string) => void;
  applicationsCount: number;
  portfolioValue: number;
  notifications: any[];
  onClearNotifications: () => void;
}

export default function DashboardOverview({ 
  ipos, 
  onNavigate, 
  applicationsCount, 
  portfolioValue,
  notifications,
  onClearNotifications
}: DashboardProps) {
  // Scatter Chart data computation
  const scatterData = React.useMemo(() => {
    const source = ipos.length > 0 ? ipos : [
      { name: "Acme CloudTech AI", subscriptionOverall: 38.5, gmpPercent: 44.2, aiScore: 92, industry: "Enterprise AI & Tech", symbol: "ACT" },
      { name: "Solaris Renewable", subscriptionOverall: 28.2, gmpPercent: 31.8, aiScore: 85, industry: "Clean Energy & Grid", symbol: "SOL" },
      { name: "NovaCharge Mobility", subscriptionOverall: 21.4, gmpPercent: 19.5, aiScore: 78, industry: "Electric Mobility", symbol: "NCM" },
      { name: "ZetaPay Fintech", subscriptionOverall: 14.8, gmpPercent: 12.0, aiScore: 70, industry: "Fintech & Payments", symbol: "ZPF" },
      { name: "Apex LogiChain", subscriptionOverall: 11.2, gmpPercent: 8.5, aiScore: 64, industry: "Logistics & Supply", symbol: "ALC" },
      { name: "BioPharma Lab", subscriptionOverall: 9.6, gmpPercent: 6.2, aiScore: 58, industry: "Healthcare & Biotech", symbol: "BPL" },
    ];
    
    return source.map((ipo, idx) => ({
      name: ipo.name,
      symbol: ipo.symbol || ipo.name.split(' ')[0],
      sub: ipo.subscriptionOverall || ipo.subscriptionRetail || (5 + idx * 8),
      gmp: ipo.gmpPercent || (2 + idx * 7),
      score: ipo.aiScore || (50 + idx * 7),
      industry: ipo.industry || "General Tech",
      color: ["#8b5cf6", "#10b981", "#3b82f6", "#f59e0b", "#ec4899", "#6366f1"][idx % 6]
    }));
  }, [ipos]);

  // Scatter spotlight selected IPO
  const [selectedScatterIpo, setSelectedScatterIpo] = useState<any>(null);

  React.useEffect(() => {
    if (scatterData.length > 0 && !selectedScatterIpo) {
      setSelectedScatterIpo(scatterData[0]);
    }
  }, [scatterData]);

  // Allotment chance estimator states
  const [estimatorIpoSymbol, setEstimatorIpoSymbol] = useState<string>("");
  const [estimatorCategory, setEstimatorCategory] = useState<"retail" | "hni" | "qib">("retail");

  React.useEffect(() => {
    if (scatterData.length > 0 && !estimatorIpoSymbol) {
      setEstimatorIpoSymbol(scatterData[0].symbol);
    }
  }, [scatterData]);

  const estimatedChance = React.useMemo(() => {
    const currentSymbol = estimatorIpoSymbol || (scatterData[0]?.symbol);
    if (!currentSymbol) return 100;
    
    const match = scatterData.find(s => s.symbol === currentSymbol);
    if (!match) return 100;
    
    let demandFactor = match.sub;
    if (estimatorCategory === "hni") {
      demandFactor = match.sub * 1.8;
    } else if (estimatorCategory === "qib") {
      demandFactor = match.sub * 2.5;
    }
    
    if (demandFactor <= 1) return 100;
    return Math.max(0.5, Math.min(100, (1 / demandFactor) * 100));
  }, [estimatorIpoSymbol, estimatorCategory, scatterData]);

  // Widget content renderers
  const renderStatsOverview = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-border/40 pb-2">
        <div>
          <h4 className="font-bold text-xs sm:text-sm text-foreground">Key Portfolio & Performance Stats</h4>
          <p className="text-[10px] text-muted-foreground">Portfolio metrics, subscriptions applied, and live market sentiment.</p>
        </div>
        <Activity className="h-4 w-4 text-primary shrink-0 ml-2" />
      </div>
      <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 pt-1">
        <div className="p-3 sm:p-4 rounded-xl border border-border bg-muted/25 flex flex-col justify-between hover:border-primary/20 transition-all">
          <div className="flex justify-between items-start text-muted-foreground">
            <span className="text-[10px] font-bold uppercase tracking-wider font-mono">Portfolio Value</span>
            <TrendingUp className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          </div>
          <div className="mt-2">
            <h3 className="text-lg sm:text-xl font-extrabold text-foreground">₹{portfolioValue.toLocaleString()}</h3>
            <span className="text-[10px] text-emerald-500 font-medium flex items-center mt-0.5">
              <ArrowUpRight className="h-3 w-3 mr-0.5 shrink-0" />
              +₹32,450 (+24.1%) gains
            </span>
          </div>
        </div>
        <div className="p-3 sm:p-4 rounded-xl border border-border bg-muted/25 flex flex-col justify-between hover:border-primary/20 transition-all">
          <div className="flex justify-between items-start text-muted-foreground">
            <span className="text-[10px] font-bold uppercase tracking-wider font-mono">Applied IPOs</span>
            <CheckCircle className="h-3.5 w-3.5 text-blue-500 shrink-0" />
          </div>
          <div className="mt-2">
            <h3 className="text-lg sm:text-xl font-extrabold text-foreground">{applicationsCount}</h3>
            <span className="text-[10px] text-muted-foreground mt-0.5 block">
              1 Pending Allotment • 2 Listed
            </span>
          </div>
        </div>
        <div className="p-3 sm:p-4 rounded-xl border border-border bg-muted/25 flex flex-col justify-between hover:border-primary/20 transition-all">
          <div className="flex justify-between items-start text-muted-foreground">
            <span className="text-[10px] font-bold uppercase tracking-wider font-mono">AI Smart Score</span>
            <Award className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          </div>
          <div className="mt-2">
            <h3 className="text-lg sm:text-xl font-extrabold text-foreground">82<span className="text-xs text-muted-foreground font-normal">/100</span></h3>
            <span className="text-[10px] text-violet-400 font-medium flex items-center mt-0.5">
              <Sparkles className="h-3 w-3 mr-0.5 text-violet-500 shrink-0" />
              Strong subscription outlook
            </span>
          </div>
        </div>
        <div className="p-3 sm:p-4 rounded-xl border border-border bg-muted/25 flex flex-col justify-between hover:border-primary/20 transition-all">
          <div className="flex justify-between items-start text-muted-foreground">
            <span className="text-[10px] font-bold uppercase tracking-wider font-mono">Market Heat</span>
            <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          </div>
          <div className="mt-2">
            <h3 className="text-lg sm:text-xl font-extrabold text-foreground">Very Active</h3>
            <span className="text-[10px] text-amber-500 font-medium flex items-center mt-0.5">
              3 active issues this week
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  const renderAnalyticsScatter = () => (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-border/40 pb-2 gap-2">
        <div>
          <h4 className="text-sm sm:text-base font-extrabold text-foreground flex items-center">
            <Sparkles className="h-4 w-4 text-violet-500 mr-2 animate-pulse shrink-0" />
            AI Analytics Dashboard Matrix
          </h4>
          <p className="text-[10px] sm:text-[11px] text-muted-foreground">Advanced correlation mapping, Grey Market Premium vs demand multiples, and Allotment Estimator.</p>
        </div>
        <span className="text-[10px] bg-primary/10 text-primary px-2.5 py-0.5 rounded-full font-mono font-bold self-start sm:self-auto shrink-0">Quantitative Desk</span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6 pt-1">
        {/* Scatter Graph */}
        <div className="xl:col-span-2 bg-muted/10 border border-border/40 rounded-xl p-3 sm:p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-3 gap-1">
            <div>
              <h5 className="text-xs font-bold text-foreground">GMP % vs. Subscription Intensity Correlation</h5>
              <p className="text-[10px] text-muted-foreground">Click any bubble/node below to trigger active AI diagnostics.</p>
            </div>
            <div className="flex items-center space-x-1.5 text-[9px] text-muted-foreground font-mono">
              <span className="inline-block w-2 h-2 rounded-full bg-violet-500 animate-ping shrink-0" />
              <span>Size proportional to AI score</span>
            </div>
          </div>
          <div className="h-56 sm:h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 10, bottom: 20, left: -25 }}>
                <XAxis 
                  type="number" 
                  dataKey="sub" 
                  name="Subscription" 
                  unit="x" 
                  stroke="#888888" 
                  fontSize={9} 
                  tickLine={false}
                  label={{ value: 'Subscription Multiple (x)', position: 'bottom', offset: 0, style: { fill: '#888', fontSize: 9 } }} 
                />
                <YAxis 
                  type="number" 
                  dataKey="gmp" 
                  name="GMP" 
                  unit="%" 
                  stroke="#888888" 
                  fontSize={9} 
                  tickLine={false}
                  label={{ value: 'GMP Premium (%)', angle: -90, position: 'insideLeft', offset: 10, style: { fill: '#888', fontSize: 9 } }} 
                />
                <ZAxis type="number" dataKey="score" range={[60, 400]} />
                <Tooltip 
                  cursor={{ strokeDasharray: '3 3' }} 
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      return (
                        <div className="bg-card border border-border p-2.5 rounded-lg shadow-lg space-y-0.5 text-[11px] z-50">
                          <p className="font-bold text-foreground">{data.name}</p>
                          <p className="text-[9px] text-muted-foreground font-mono">{data.industry}</p>
                          <div className="grid grid-cols-2 gap-x-2 pt-1 border-t border-border/30 text-[10px] font-mono">
                            <span className="text-muted-foreground">Subscription:</span>
                            <span className="font-bold text-foreground text-right">{data.sub}x</span>
                            <span className="text-muted-foreground">GMP Premium:</span>
                            <span className="font-bold text-emerald-500 text-right">+{data.gmp}%</span>
                            <span className="text-muted-foreground">AI Score:</span>
                            <span className="font-bold text-primary text-right">{data.score}/100</span>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Scatter name="IPOs" data={scatterData}>
                  {scatterData.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={entry.color} 
                      onClick={() => setSelectedScatterIpo(entry)} 
                      className="cursor-pointer hover:opacity-80 transition-opacity" 
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
        
        {/* Analytical Spotlight Panel */}
        <div className="space-y-4 flex flex-col justify-between">
          {/* Spot 1: Selected Spotlight Deep-Dive */}
          {selectedScatterIpo && (
            <div className="bg-muted/15 border border-border/40 rounded-xl p-3 sm:p-4 space-y-3 flex-1 flex flex-col justify-between min-h-[160px]">
              <div>
                <div className="flex items-center justify-between border-b border-border/20 pb-1.5">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Spotlight Audit</span>
                  <span className="text-[9px] font-mono font-semibold text-primary px-1.5 py-0.5 bg-primary/5 rounded-full shrink-0">
                    {selectedScatterIpo.symbol}
                  </span>
                </div>
                <div className="mt-2">
                  <h5 className="text-xs font-bold text-foreground">{selectedScatterIpo.name}</h5>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{selectedScatterIpo.industry}</p>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3 font-mono text-[9px]">
                  <div className="bg-background/40 p-1.5 rounded border border-border/40">
                    <span className="text-[8px] text-muted-foreground block uppercase font-bold">Valuation Rating</span>
                    <span className={`font-bold block mt-0.5 ${
                      selectedScatterIpo.score >= 80 ? "text-emerald-400" : selectedScatterIpo.score >= 65 ? "text-amber-400" : "text-rose-400"
                    }`}>
                      {selectedScatterIpo.score >= 80 ? "Premium Value" : selectedScatterIpo.score >= 65 ? "Fair Value" : "Aggressive Price"}
                    </span>
                  </div>
                  <div className="bg-background/40 p-1.5 rounded border border-border/40">
                    <span className="text-[8px] text-muted-foreground block uppercase font-bold">Risk Matrix</span>
                    <span className="text-foreground font-bold block mt-0.5">
                      {selectedScatterIpo.gmp >= 25 && selectedScatterIpo.sub >= 15 ? "High Gain Safe" :
                        selectedScatterIpo.gmp >= 25 ? "Speculative High" :
                        selectedScatterIpo.sub >= 15 ? "Moderate Flow" : "Conservative Play"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="pt-2 border-t border-border/20 text-[10px] text-muted-foreground italic flex items-center space-x-1.5 leading-tight">
                <Sparkles className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                <span>
                  AI Advice: {selectedScatterIpo.score >= 80 ? "Strong buy on listing dips. Multi-quota applications suggested." : "Monitor subscription trend on closing day to secure quick premium exit."}
                </span>
              </div>
            </div>
          )}

          {/* Spot 2: Allotment Chance Estimator */}
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 sm:p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-primary/10 pb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-primary">Allotment Chance Estimator</span>
              <HelpCircle className="h-3.5 w-3.5 text-primary cursor-help shrink-0" aria-label="Based on actual subscription multiples and mathematical probability rules." />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px]">
              <div>
                <label className="block text-[8px] text-muted-foreground font-bold uppercase mb-1">Target IPO</label>
                <select
                  value={estimatorIpoSymbol}
                  onChange={(e) => setEstimatorIpoSymbol(e.target.value)}
                  className="w-full bg-background border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-primary"
                >
                  {scatterData.map(ipo => (
                    <option key={ipo.symbol} value={ipo.symbol}>{ipo.symbol} ({ipo.sub}x)</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[8px] text-muted-foreground font-bold uppercase mb-1">Category</label>
                <select
                  value={estimatorCategory}
                  onChange={(e) => setEstimatorCategory(e.target.value as any)}
                  className="w-full bg-background border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-primary"
                >
                  <option value="retail">Retail (Indiv)</option>
                  <option value="hni">HNI (Non-Inst)</option>
                  <option value="qib">QIB (Institutional)</option>
                </select>
              </div>
            </div>
            <div className="bg-background/80 border border-border/60 p-2.5 rounded-lg flex items-center justify-between space-x-3">
              <div className="min-w-0 flex-1">
                <span className="text-[8px] font-bold uppercase tracking-wider text-gray-500 block">Probability Gauge</span>
                <span className="text-sm sm:text-base font-black text-white block mt-0.5">{estimatedChance.toFixed(1)}% Chance</span>
                <p className="text-[9px] text-muted-foreground leading-tight mt-1 truncate">
                  {estimatedChance >= 100 
                    ? "Full allotment guaranteed!" 
                    : `Odds: ~1 in ${Math.ceil(100 / estimatedChance)} applicants.`}
                </p>
              </div>
              <div className="w-10 h-10 sm:w-11 sm:h-11 shrink-0 rounded-full border border-border bg-muted/30 flex items-center justify-center relative">
                <svg className="w-full h-full transform -rotate-90">
                  <circle cx="22" cy="22" r="18" stroke="rgba(255, 255, 255, 0.05)" strokeWidth="3" fill="none" />
                  <circle cx="22" cy="22" r="18" stroke="var(--color-primary)" strokeWidth="3" fill="none" 
                    strokeDasharray={113}
                    strokeDashoffset={113 - (113 * Math.min(estimatedChance, 100)) / 100}
                  />
                </svg>
                <span className="absolute text-[8px] font-black font-mono">{Math.round(estimatedChance)}%</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 sm:space-y-6 text-foreground p-2 sm:p-4">
      {/* Stats overview full width */}
      <div className="rounded-xl sm:rounded-2xl border border-border bg-card p-3 sm:p-5 shadow-sm">
        {renderStatsOverview()}
      </div>
      
      {/* Analytics Scatter Matrix */}
      <div className="rounded-xl sm:rounded-2xl border border-border bg-card p-3 sm:p-5 shadow-sm">
        {renderAnalyticsScatter()}
      </div>
    </div>
  );
}