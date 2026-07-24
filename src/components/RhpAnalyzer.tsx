import React, { useState, useRef } from "react";
import { 
  FileText, 
  Upload, 
  Sparkles, 
  CheckCircle, 
  AlertTriangle, 
  TrendingUp, 
  Layers, 
  ArrowRight, 
  DollarSign, 
  Briefcase, 
  User, 
  Target, 
  ShieldAlert,
  Search,
  FileCheck,
  RefreshCw,
  Loader2,
  ChevronRight,
  Info
} from "lucide-react";
import { 
  ResponsiveContainer, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  Legend, 
  CartesianGrid,
  LineChart,
  Line
} from "recharts";

interface AnalysisResult {
  companyName: string;
  symbol: string;
  industry: string;
  summary: {
    about: string;
    freshIssue: string;
    ofs: string;
    totalIssue: string;
    priceBand: string;
    listingObjectives: string[];
    promoters: string;
  };
  risks: {
    internal: Array<{ risk: string; impact: string; details: string }>;
    external: Array<{ risk: string; impact: string; details: string }>;
  };
  financials: {
    years: string[];
    revenue: number[];
    ebitda: number[];
    pat: number[];
    ratios: Array<{ name: string; values: string[] }>;
  };
  redFlags: Array<{ title: string; severity: string; description: string }>;
}

export default function RhpAnalyzer() {
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Tab states within the analyzed results
  const [activeSubTab, setActiveSubTab] = useState<"summary" | "risks" | "financials" | "redflags">("summary");
  // Financial chart toggle
  const [financialMetric, setFinancialMetric] = useState<"revenue" | "ebitda" | "pat">("revenue");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const steps = [
    { label: "Uploading Red Herring Prospectus (RHP)...", duration: 800 },
    { label: "Tokenizing document pages & tables...", duration: 1200 },
    { label: "Extracting past 3-year income statement financials...", duration: 1500 },
    { label: "Interrogating regulatory & operation risk variables...", duration: 1200 },
    { label: "Compiling red-flags and related-party disclosure reports...", duration: 1000 },
  ];

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.type === "application/pdf" || droppedFile.name.endsWith(".pdf")) {
        processSelectedFile(droppedFile);
      } else {
        setError("Only PDF format documents are supported for RHP prospectus parsing.");
      }
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processSelectedFile(e.target.files[0]);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const processSelectedFile = async (selectedFile: File) => {
    setFile(selectedFile);
    setError(null);
    setResult(null);
    setAnalyzing(true);
    setProgressStep(0);

    // Simulate progress timeline increments
    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep++;
      if (currentStep < steps.length) {
        setProgressStep(currentStep);
      } else {
        clearInterval(interval);
      }
    }, 1100);

    try {
      // Read file to Base64
      const base64Promise = new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = reader.result as string;
          // Strip the data:application/pdf;base64, prefix if present
          const base64Data = res.includes(";base64,") ? res.split(";base64,")[1] : res;
          resolve(base64Data);
        };
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(selectedFile);
      });

      const pdfBase64 = await base64Promise;

      // Call server route
      const response = await fetch("/api/rhp/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdfName: selectedFile.name,
          pdfBase64: pdfBase64
        })
      });

      if (!response.ok) {
        throw new Error("Failed to communicate with RHP analytical core.");
      }

      const parsedData = await response.json();
      setResult(parsedData);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "An unexpected error occurred during PDF tokenization.");
    } finally {
      clearInterval(interval);
      setAnalyzing(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setResult(null);
    setError(null);
    setProgressStep(0);
  };

  // Format Recharts data
  const getChartData = () => {
    if (!result) return [];
    return result.financials.years.map((year, idx) => ({
      year,
      revenue: result.financials.revenue[idx],
      ebitda: result.financials.ebitda[idx],
      pat: result.financials.pat[idx]
    }));
  };

  return (
    <div id="rhp-analyzer-workspace" className="space-y-4 sm:space-y-6 max-w-6xl mx-auto px-1 sm:px-0">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-border pb-4 sm:pb-5 gap-3 sm:gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-widest bg-primary/10 text-primary px-2.5 py-0.5 sm:px-3 sm:py-1 rounded-full border border-primary/25">
              Premium AI Intelligence
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground mt-1.5 sm:mt-2 flex items-center">
            <Sparkles className="h-5 w-5 sm:h-6 sm:w-6 text-primary mr-2 animate-pulse shrink-0" />
            AI Red Herring Prospectus (RHP) Analyzer
          </h1>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Upload any Indian IPO RHP prospectus. Our Gemini multimodal engine parses hundreds of pages to synthesize core business summaries, financial ledgers, risks, and red flags.
          </p>
        </div>

        {result && (
          <button
            onClick={handleReset}
            className="flex items-center justify-center space-x-2 bg-muted hover:bg-muted/80 text-foreground text-xs font-semibold px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-xl border border-border transition-all cursor-pointer shrink-0 self-start md:self-auto"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Analyze Another Document</span>
          </button>
        )}
      </div>

      {/* Primary Workspace */}
      {!result && !analyzing && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          {/* Left / Center Upload Area */}
          <div className="lg:col-span-2 space-y-4">
            <div
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl sm:rounded-2xl p-6 sm:p-10 flex flex-col items-center justify-center text-center transition-all min-h-[280px] sm:min-h-[350px] relative ${
                dragActive 
                  ? "border-primary bg-primary/5 scale-[0.99]" 
                  : "border-border bg-card/40 hover:bg-card/75"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                onChange={handleFileInput}
                className="hidden"
              />

              <div className="bg-primary/10 p-3 sm:p-4 rounded-full border border-primary/20 text-primary mb-3 sm:mb-4 animate-bounce">
                <Upload className="h-6 w-6 sm:h-8 sm:w-8" />
              </div>

              <h3 className="text-xs sm:text-sm font-bold text-foreground">
                Drag & Drop Prospectus Document Here
              </h3>
              <p className="text-[11px] sm:text-xs text-muted-foreground mt-1.5 max-w-sm leading-relaxed">
                Supports Indian SEBI Draft Red Herring Prospectuses (DRHP) and final RHPs in standard PDF format. (Suggested file size under 40MB)
              </p>

              <button
                onClick={triggerFileInput}
                className="mt-4 sm:mt-6 px-4 sm:px-5 py-2 sm:py-2.5 bg-primary text-primary-foreground hover:bg-primary/95 text-xs font-bold rounded-xl shadow-sm transition-all cursor-pointer w-full sm:w-auto"
              >
                Choose File from Local Storage
              </button>

              {error && (
                <div className="mt-4 sm:mt-6 p-3 sm:p-3.5 bg-destructive/10 text-destructive border border-destructive/20 rounded-xl flex items-center space-x-2 text-xs max-w-md">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>

          </div>

          {/* Right Side Info Panel */}
          <div className="space-y-4">
            <div className="bg-gradient-to-br from-primary/10 via-card to-card border border-primary/20 rounded-xl sm:rounded-2xl p-4 sm:p-6 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-10 bg-primary/5 rounded-full blur-3xl -z-10"></div>
              <h3 className="text-xs sm:text-sm font-bold text-primary flex items-center">
                <Sparkles className="h-4 w-4 mr-1.5 animate-pulse shrink-0" />
                Under the Hood: AI Parsing Engine
              </h3>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                A standard corporate prospectus runs between 300 to 700 pages, dense with legal boilerplate, balance sheets, and related party disclosures.
              </p>
              
              <ul className="space-y-2.5 sm:space-y-3 mt-3 sm:mt-4 text-[11px] text-muted-foreground">
                <li className="flex items-start">
                  <CheckCircle className="h-3.5 w-3.5 text-primary shrink-0 mr-2 mt-0.5" />
                  <span><strong>SEBI Metrics Extraction:</strong> Pulls total capital structure (fresh issue portion vs. OFS exit values).</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle className="h-3.5 w-3.5 text-primary shrink-0 mr-2 mt-0.5" />
                  <span><strong>Bento Financial Ledger:</strong> Synthesizes income statement components (revenue growth, EBITDA margins, Profit after Tax) into visual charts.</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle className="h-3.5 w-3.5 text-primary shrink-0 mr-2 mt-0.5" />
                  <span><strong>Litigation Scrape:</strong> Scans promoter disclosures and outstanding tax cases to isolate high-risk audit flags.</span>
                </li>
              </ul>
            </div>

            <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-2 sm:space-y-3 text-xs">
              <h4 className="font-semibold text-foreground flex items-center">
                <Info className="h-4 w-4 text-muted-foreground mr-1.5 shrink-0" />
                SEBI Prospectus Guideline Note
              </h4>
              <p className="text-muted-foreground leading-relaxed text-[11px] sm:text-xs">
                Draft Red Herring Prospectuses are filed with SEBI for feedback. The finalized RHP includes official subscription dates and exact price bands. It represents the ultimate ground-truth legal disclosure of the enterprise.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Progress / Loading Screen */}
      {analyzing && (
        <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-5 sm:p-8 max-w-xl mx-auto shadow-xl space-y-4 sm:space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex bg-primary/10 p-2.5 sm:p-3 rounded-xl border border-primary/20 text-primary animate-spin">
              <Loader2 className="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <h2 className="text-base sm:text-lg font-bold text-foreground">AI RHP Intelligence Audit Active</h2>
            <p className="text-xs text-muted-foreground truncate">
              Processing <code className="text-primary font-mono">{file?.name || "prospectus.pdf"}</code>
            </p>
          </div>

          {/* Animated custom progress line */}
          <div className="space-y-1.5">
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-primary to-violet-500 rounded-full transition-all duration-500" 
                style={{ width: `${((progressStep + 1) / steps.length) * 100}%` }}
              ></div>
            </div>
            <div className="flex justify-between text-[9px] sm:text-[10px] text-muted-foreground font-mono">
              <span>ANALYZING PAGE SCHEMAS</span>
              <span>{Math.round(((progressStep + 1) / steps.length) * 100)}%</span>
            </div>
          </div>

          {/* Step checklist */}
          <div className="space-y-2.5 sm:space-y-3 pt-2">
            {steps.map((step, idx) => (
              <div 
                key={idx} 
                className={`flex items-center space-x-2.5 sm:space-x-3 text-xs transition-colors duration-300 ${
                  idx < progressStep 
                    ? "text-emerald-500" 
                    : idx === progressStep 
                      ? "text-primary font-semibold" 
                      : "text-muted-foreground/60"
                }`}
              >
                {idx < progressStep ? (
                  <CheckCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-emerald-500" />
                ) : idx === progressStep ? (
                  <Loader2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 animate-spin text-primary" />
                ) : (
                  <div className="h-3.5 w-3.5 sm:h-4 sm:w-4 rounded-full border border-border shrink-0 flex items-center justify-center font-mono text-[8px] sm:text-[9px]">
                    {idx + 1}
                  </div>
                )}
                <span className="text-[11px] sm:text-xs leading-normal">{step.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Analysis Results Dashboard */}
      {result && (
        <div className="space-y-4 sm:space-y-6">
          {/* Company Brief Hero Header */}
          <div className="bg-gradient-to-r from-primary/10 via-card to-card border border-primary/20 rounded-xl sm:rounded-2xl p-4 sm:p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-3 sm:gap-4">
            <div className="space-y-1">
              <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                <span className="text-[9px] sm:text-[10px] font-mono font-bold uppercase bg-primary/10 text-primary border border-primary/25 px-2 py-0.5 rounded">
                  {result.industry}
                </span>
                <span className="text-[9px] sm:text-[10px] font-mono font-bold uppercase bg-muted text-muted-foreground px-2 py-0.5 rounded">
                  NSE Ticker: {result.symbol}
                </span>
              </div>
              <h2 className="text-lg sm:text-xl font-black text-foreground mt-1">
                {result.companyName}
              </h2>
              <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed">
                {result.summary.about}
              </p>
            </div>

            <div className="flex flex-row md:flex-col items-center md:items-end justify-between md:justify-center border-t md:border-t-0 md:border-l border-border pt-3 md:pt-0 md:pl-6 shrink-0 gap-2">
              <div className="text-left md:text-right">
                <span className="text-[9px] sm:text-[10px] text-muted-foreground block font-mono">TOTAL ISSUE SIZE</span>
                <span className="text-base sm:text-lg font-black text-foreground">{result.summary.totalIssue}</span>
              </div>
              <div className="text-right">
                <span className="text-[9px] sm:text-[10px] text-muted-foreground block font-mono">PRICE BAND</span>
                <span className="text-xs font-bold text-primary font-mono">{result.summary.priceBand}</span>
              </div>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="flex border-b border-border overflow-x-auto no-scrollbar">
            <button
              onClick={() => setActiveSubTab("summary")}
              className={`pb-3 px-3.5 sm:px-5 text-xs font-bold transition-all border-b-2 flex items-center space-x-1.5 cursor-pointer whitespace-nowrap shrink-0 ${
                activeSubTab === "summary"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span>AI Executive Summary</span>
            </button>
            <button
              onClick={() => setActiveSubTab("risks")}
              className={`pb-3 px-3.5 sm:px-5 text-xs font-bold transition-all border-b-2 flex items-center space-x-1.5 cursor-pointer whitespace-nowrap shrink-0 ${
                activeSubTab === "risks"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <AlertTriangle className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span>Risk Factors ({(result.risks?.internal?.length ?? 0) + (result.risks?.external?.length ?? 0)})</span>
            </button>
            <button
              onClick={() => setActiveSubTab("financials")}
              className={`pb-3 px-3.5 sm:px-5 text-xs font-bold transition-all border-b-2 flex items-center space-x-1.5 cursor-pointer whitespace-nowrap shrink-0 ${
                activeSubTab === "financials"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <TrendingUp className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span>Financial Ledger</span>
            </button>
            <button
              onClick={() => setActiveSubTab("redflags")}
              className={`pb-3 px-3.5 sm:px-5 text-xs font-bold transition-all border-b-2 flex items-center space-x-1.5 cursor-pointer whitespace-nowrap shrink-0 ${
                activeSubTab === "redflags"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <ShieldAlert className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span>Red Flags & Litigations ({result.redFlags?.length ?? 0})</span>
            </button>
          </div>

          {/* Tab Content Panels */}
          {activeSubTab === "summary" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
              {/* Left Column: KPI metrics & promoter info */}
              <div className="space-y-4 sm:space-y-6 lg:col-span-1">
                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-3 sm:space-y-4">
                  <h3 className="text-xs font-bold text-foreground border-b border-border pb-2">
                    Issue Structure & Capital Mix
                  </h3>
                  
                  <div className="space-y-2 sm:space-y-3 text-xs">
                    <div className="flex justify-between items-center bg-muted/40 p-2 sm:p-2.5 rounded-xl border border-border/40">
                      <span className="text-muted-foreground text-[11px] sm:text-xs">Fresh Issue Size:</span>
                      <span className="font-bold text-foreground text-[11px] sm:text-xs">{result.summary.freshIssue}</span>
                    </div>
                    <div className="flex justify-between items-center bg-muted/40 p-2 sm:p-2.5 rounded-xl border border-border/40">
                      <span className="text-muted-foreground text-[11px] sm:text-xs">Offer For Sale (OFS):</span>
                      <span className="font-bold text-foreground text-[11px] sm:text-xs">{result.summary.ofs}</span>
                    </div>
                    <div className="flex justify-between items-center bg-muted/40 p-2 sm:p-2.5 rounded-xl border border-border/40">
                      <span className="text-muted-foreground text-[11px] sm:text-xs">Total Public Issue:</span>
                      <span className="font-bold text-primary text-[11px] sm:text-xs">{result.summary.totalIssue}</span>
                    </div>
                  </div>
                </div>

                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-2.5 sm:space-y-3">
                  <h3 className="text-xs font-bold text-foreground border-b border-border pb-2 flex items-center">
                    <User className="h-4 w-4 mr-1 text-muted-foreground shrink-0" />
                    Promoters & Shareholder Dilution
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {result.summary.promoters}
                  </p>
                </div>
              </div>

              {/* Right Column: Listing Objectives */}
              <div className="lg:col-span-2 space-y-4 sm:space-y-6">
                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
                  <h3 className="text-xs font-bold text-foreground flex items-center border-b border-border pb-2">
                    <Target className="h-4 w-4 text-primary mr-2 shrink-0" />
                    Listing Objectives (Utilization of Proceeds)
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    According to the RHP filed with regulatory bodies, the capital raised from the fresh issue segment is earmarked for the following utilization goals:
                  </p>
                  
                  <div className="space-y-2.5 sm:space-y-3 pt-1 sm:pt-2">
                    {(result.summary.listingObjectives ?? []).map((obj, idx) => (
                      <div key={idx} className="flex items-start space-x-2.5 sm:space-x-3 bg-muted/20 hover:bg-muted/40 p-2.5 sm:p-3 rounded-xl border border-border/60 transition-all text-xs">
                        <div className="h-5 w-5 sm:h-6 sm:w-6 rounded-lg bg-primary/10 text-primary font-bold flex items-center justify-center shrink-0 text-[11px] sm:text-xs">
                          {idx + 1}
                        </div>
                        <span className="text-muted-foreground mt-0.5 leading-relaxed text-[11px] sm:text-xs">{obj}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSubTab === "risks" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
              {/* Internal operational risks */}
              <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
                <div className="flex items-center justify-between border-b border-border pb-2.5 sm:pb-3">
                  <h3 className="text-xs font-black text-foreground flex items-center">
                    <span className="h-2 w-2 bg-indigo-500 rounded-full mr-2 shrink-0"></span>
                    Internal Operational Risks
                  </h3>
                  <span className="text-[9px] sm:text-[10px] font-mono bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-full">
                    {result.risks?.internal?.length ?? 0} identified
                  </span>
                </div>

                <div className="space-y-3 sm:space-y-4 pt-1">
                  {(result.risks?.internal ?? []).map((item, idx) => (
                    <div key={idx} className="bg-muted/10 border border-border/80 rounded-xl p-3.5 sm:p-4 space-y-1.5 hover:border-indigo-500/20 transition-all">
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-xs font-bold text-foreground truncate">{item.risk}</span>
                        <span className={`text-[8px] sm:text-[9px] font-bold uppercase px-1.5 sm:px-2 py-0.5 rounded-full border shrink-0 ${
                          item.impact === "High" 
                            ? "bg-rose-500/10 text-rose-400 border-rose-500/20" 
                            : item.impact === "Medium"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                              : "bg-slate-500/10 text-slate-400 border-slate-500/20"
                        }`}>
                          {item.impact} Impact
                        </span>
                      </div>
                      <p className="text-[10px] sm:text-[11px] text-muted-foreground leading-relaxed">
                        {item.details}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* External market/regulatory risks */}
              <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
                <div className="flex items-center justify-between border-b border-border pb-2.5 sm:pb-3">
                  <h3 className="text-xs font-black text-foreground flex items-center">
                    <span className="h-2 w-2 bg-violet-500 rounded-full mr-2 shrink-0"></span>
                    External Market & Regulatory Risks
                  </h3>
                  <span className="text-[9px] sm:text-[10px] font-mono bg-violet-500/10 text-violet-400 border border-violet-500/20 px-2 py-0.5 rounded-full">
                    {result.risks?.external?.length ?? 0} identified
                  </span>
                </div>

                <div className="space-y-3 sm:space-y-4 pt-1">
                  {(result.risks?.external ?? []).map((item, idx) => (
                    <div key={idx} className="bg-muted/10 border border-border/80 rounded-xl p-3.5 sm:p-4 space-y-1.5 hover:border-violet-500/20 transition-all">
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-xs font-bold text-foreground truncate">{item.risk}</span>
                        <span className={`text-[8px] sm:text-[9px] font-bold uppercase px-1.5 sm:px-2 py-0.5 rounded-full border shrink-0 ${
                          item.impact === "High" 
                            ? "bg-rose-500/10 text-rose-400 border-rose-500/20" 
                            : item.impact === "Medium"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                              : "bg-slate-500/10 text-slate-400 border-slate-500/20"
                        }`}>
                          {item.impact} Impact
                        </span>
                      </div>
                      <p className="text-[10px] sm:text-[11px] text-muted-foreground leading-relaxed">
                        {item.details}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeSubTab === "financials" && (
            <div className="space-y-4 sm:space-y-6">
              {/* Financial metric switcher */}
              <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-6 space-y-4 sm:space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-border pb-3 sm:pb-4 gap-3 sm:gap-4">
                  <div>
                    <h3 className="text-xs font-bold text-foreground uppercase tracking-wider font-mono">
                      Income Statement Performance (₹ Crores)
                    </h3>
                    <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-0.5">
                      Toggle active variables below to plot financial trends over the past three fiscal periods.
                    </p>
                  </div>

                  <div className="flex bg-muted/50 p-1 rounded-xl border border-border self-start overflow-x-auto no-scrollbar max-w-full">
                    <button
                      onClick={() => setFinancialMetric("revenue")}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                        financialMetric === "revenue"
                          ? "bg-primary text-primary-foreground shadow"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Total Revenue
                    </button>
                    <button
                      onClick={() => setFinancialMetric("ebitda")}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                        financialMetric === "ebitda"
                          ? "bg-primary text-primary-foreground shadow"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      EBITDA
                    </button>
                    <button
                      onClick={() => setFinancialMetric("pat")}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                        financialMetric === "pat"
                          ? "bg-primary text-primary-foreground shadow"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      PAT (Net Profit)
                    </button>
                  </div>
                </div>

                {/* Recharts chart */}
                <div className="h-[220px] sm:h-[280px] w-full text-xs font-mono">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={getChartData()} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" className="opacity-40" />
                      <XAxis dataKey="year" tickLine={false} style={{ fontSize: "10px", fontWeight: "bold" }} />
                      <YAxis tickLine={false} style={{ fontSize: "10px", fontWeight: "bold" }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: "#fff", 
                          borderRadius: "12px", 
                          border: "1px solid #E2E8F0",
                          boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.05)" 
                        }} 
                      />
                      <Legend />
                      <Bar 
                        dataKey={financialMetric} 
                        name={financialMetric === "revenue" ? "Total Revenue (₹ Cr)" : financialMetric === "ebitda" ? "EBITDA (₹ Cr)" : "Net Profit / PAT (₹ Cr)"}
                        fill={financialMetric === "revenue" ? "#6366F1" : financialMetric === "ebitda" ? "#F59E0B" : "#10B981"} 
                        radius={[6, 6, 0, 0]} 
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Ledger Tabular Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
                {/* Metrics Table */}
                <div className="lg:col-span-2 bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-3">
                  <h3 className="text-xs font-bold text-foreground">
                    Historical Financial Summary Table (₹ Cr)
                  </h3>
                  <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                    <table className="w-full text-left border-collapse text-xs min-w-[450px]">
                      <thead>
                        <tr className="border-b border-border/80 text-muted-foreground font-semibold">
                          <th className="pb-3 pt-1">Metric Variable</th>
                          {result.financials.years.map((y, i) => (
                            <th key={i} className="pb-3 pt-1 text-right">{y}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        <tr className="hover:bg-muted/20">
                          <td className="py-3 font-semibold text-foreground">Revenue from Operations</td>
                          {result.financials.revenue.map((val, idx) => (
                            <td key={idx} className="py-3 text-right font-mono text-foreground font-semibold">₹{val.toLocaleString()} Cr</td>
                          ))}
                        </tr>
                        <tr className="hover:bg-muted/20">
                          <td className="py-3 text-muted-foreground">Operating profit (EBITDA)</td>
                          {result.financials.ebitda.map((val, idx) => (
                            <td key={idx} className={`py-3 text-right font-mono font-semibold ${val < 0 ? "text-rose-500" : "text-foreground"}`}>₹{val.toLocaleString()} Cr</td>
                          ))}
                        </tr>
                        <tr className="hover:bg-muted/20">
                          <td className="py-3 text-muted-foreground">Net Profit after Tax (PAT)</td>
                          {result.financials.pat.map((val, idx) => (
                            <td key={idx} className={`py-3 text-right font-mono font-semibold ${val < 0 ? "text-rose-500" : "text-foreground"}`}>₹{val.toLocaleString()} Cr</td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Analytical Ratios */}
                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-3">
                  <h3 className="text-xs font-bold text-foreground">
                    Key Performance Ratios
                  </h3>
                  <div className="space-y-3">
                    {result.financials.ratios.map((ratio, idx) => (
                      <div key={idx} className="space-y-1.5 border-b border-border/40 pb-2.5 last:border-0 last:pb-0">
                        <div className="flex justify-between items-center text-xs gap-2">
                          <span className="font-semibold text-muted-foreground truncate">{ratio.name}</span>
                          <span className="font-mono text-[9px] sm:text-[10px] text-primary bg-primary/5 border border-primary/25 px-1.5 rounded shrink-0">Latest: {ratio.values[ratio.values.length - 1]}</span>
                        </div>
                        <div className="flex justify-between text-[10px] sm:text-[11px] font-mono text-foreground">
                          {result.financials.years.map((year, yIdx) => (
                            <div key={yIdx} className="text-center">
                              <span className="text-[8px] sm:text-[9px] text-muted-foreground block">{year}</span>
                              <span className="font-bold">{ratio.values[yIdx]}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSubTab === "redflags" && (
            <div className="space-y-6">
              <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-6 space-y-4">
                <div className="flex items-center space-x-2 pb-2 border-b border-border">
                  <ShieldAlert className="h-5 w-5 text-rose-500 shrink-0" />
                  <div>
                    <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">
                      SEBI Litigation & Red Flag Audit Board
                    </h3>
                    <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-0.5">
                      Below are the identified pending litigations, promoter pledging details, or auditor qualifications compiled by SEBI.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 pt-1">
                  {(result.redFlags ?? []).map((flag, idx) => (
                    <div 
                      key={idx} 
                      className={`border rounded-xl p-3.5 sm:p-4.5 space-y-2 transition-all relative overflow-hidden ${
                        flag.severity === "High"
                          ? "border-rose-500/25 bg-rose-500/5 hover:bg-rose-500/10"
                          : flag.severity === "Medium"
                            ? "border-amber-500/25 bg-amber-500/5 hover:bg-amber-500/10"
                            : "border-slate-500/20 bg-muted/10 hover:bg-muted/20"
                      }`}
                    >
                      {/* Alert status colored banner line */}
                      <div className={`absolute top-0 left-0 w-1 h-full ${
                        flag.severity === "High" ? "bg-rose-500" : flag.severity === "Medium" ? "bg-amber-500" : "bg-slate-500"
                      }`}></div>

                      <div className="flex justify-between items-start pl-1.5 sm:pl-2 gap-2">
                        <span className="text-xs font-bold text-foreground flex items-center">
                          <AlertTriangle className={`h-3.5 w-3.5 sm:h-4 sm:w-4 mr-1.5 shrink-0 ${
                            flag.severity === "High" ? "text-rose-500" : flag.severity === "Medium" ? "text-amber-500" : "text-slate-500"
                          }`} />
                          <span className="truncate">{flag.title}</span>
                        </span>
                        
                        <span className={`text-[8px] sm:text-[9px] font-bold uppercase px-1.5 sm:px-2 py-0.5 rounded-full border shrink-0 ${
                          flag.severity === "High"
                            ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                            : flag.severity === "Medium"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                              : "bg-slate-500/10 text-slate-400 border-slate-500/20"
                        }`}>
                          {flag.severity} Alert
                        </span>
                      </div>

                      <p className="text-[10px] sm:text-[11px] text-muted-foreground leading-relaxed pl-1.5 sm:pl-2">
                        {flag.description}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}