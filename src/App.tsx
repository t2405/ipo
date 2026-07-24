import React, { useState, useEffect, useRef } from "react";
import Sidebar from "./components/Sidebar";
import DashboardOverview from "./components/DashboardOverview";
import IpoDiscovery from "./components/IpoDiscovery";
import AllotmentTracker from "./components/AllotmentTracker";
import ListingDayAI from "./components/ListingDayAI";
import PortfolioHoldings from "./components/PortfolioHoldings";
import AiArena from "./components/AiArena";
import RhpAnalyzer from "./components/RhpAnalyzer";
import NewsAnalyzer from "./components/NewsAnalyzer";
import SocialAnalyzer from "./components/SocialAnalyzer";
import MarketIntelligence from "./components/MarketIntelligence";
import PushAlertsHub from "./components/PushAlertsHub";
import FloatingChatbot from "./components/FloatingChatbot";
import OnboardingTour from "./components/OnboardingTour";
import AuthModal from "./components/AuthModal";
import AdminCenter from "./components/AdminCenter";
import ResearchHub from "./components/ResearchHub";
import { IPO, Application, PortfolioHolding } from "./types";
import { Sparkles, Calendar, RefreshCw, Sun, Moon } from "lucide-react";

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [darkMode, setDarkMode] = useState(true);
  const [ipos, setIpos] = useState<IPO[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioHolding[]>([]);
  const portfolioRef = useRef<PortfolioHolding[]>([]);

  useEffect(() => {
    portfolioRef.current = portfolio;
  }, [portfolio]);

  const [notifications, setNotifications] = useState<any[]>([]);
  const [news, setNews] = useState<any[]>([]);
  const fetchNews = async () => {
    try {
      const res = await fetch('/api/news');
      if (res.ok) {
        const data = await res.json();
        setNews(data.map((item: any) => ({
          ...item,
          newsLink: item.link || item.url || ""
        })));
      }
    } catch (e) {
      console.error('Failed to load news', e);
    }
  };
  const [loading, setLoading] = useState(true);

  // Authentication session states
  const [user, setUser] = useState<any>(() => {
    try {
      const saved = localStorage.getItem("iposense_user");
      return saved ? JSON.parse(saved) : null;
    } catch (_) {
      return null;
    }
  });
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // Watchlist state backed by PostgreSQL
  const [watchlist, setWatchlist] = useState<string[]>([]);
const getAccessToken = () =>
  localStorage.getItem("iposense_access_token") || "";

const getCsrfToken = async () => {
  const cached = sessionStorage.getItem("iposense_csrf_token");
  if (cached) return cached;

  const res = await fetch("/api/auth/csrf-token");
  const data = await res.json();

  sessionStorage.setItem("iposense_csrf_token", data.csrfToken);
  return data.csrfToken;
};

const apiFetch = async (url: string, options: RequestInit = {}) => {
  const headers = new Headers(options.headers || {});

  const token = getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const method = (options.method || "GET").toUpperCase();

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrf = await getCsrfToken();
    headers.set("X-CSRF-Token", csrf);
  }

  return fetch(url, {
    ...options,
    headers,
  });
};

  const fetchWatchlist = async () => {
    try {
      const res = await apiFetch("/api/watchlist")
      if (res.ok) {
        const data = await res.json();
        setWatchlist(data);
      }
    } catch (e) {
      console.error("Failed to load watchlist from PostgreSQL database:", e);
    }
  };

  const handleToggleWatchlist = async (ipoSymbol: string) => {
    const isWatchlisted = watchlist.includes(ipoSymbol);
    setWatchlist(prev => isWatchlisted ? prev.filter(s => s !== ipoSymbol) : [...prev, ipoSymbol]);

    try {
      const endpoint = isWatchlisted ? "/api/watchlist/remove" : "/api/watchlist";
      await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ipoSymbol })
      });
    } catch (e) {
      console.error("Failed to synchronize watchlist action to database:", e);
    }
  };

 

  // Loaders
  const fetchIpos = async () => {
    try {
      const res = await fetch("/api/ipos");
      if (!res.ok) {
        throw new Error(`API returned non-200 status: ${res.status}`);
      }

      const data = await res.json();

      const normalizedIpos = data.map((ipo: any) => ({
        ...ipo,
        companyName: ipo.companyName || ipo.name,
        price: ipo.price || ipo.priceBand,
        gmp: ipo.gmp ?? 0,
        aiScore: ipo.aiScore ?? 75,
        aiConfidence: ipo.aiConfidence ?? 80,
        riskScore: ipo.riskScore ?? 50,
        recommendation: ipo.recommendation || "MODERATE",
        subscriptionOverall: ipo.subscriptionOverall ?? 0,
        industry: ipo.industry || "Technology",
        strengths: ipo.strengths || [],
        risks: ipo.risks || [],
        financials: ipo.financials || []
      }));

      setIpos(normalizedIpos);
    } catch (e) {
      console.error("Failed to load IPO indexes:", e);
      setIpos([]);
    }
  };

  const fetchNotifications = async () => {
    try {
      const res = await apiFetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        setNotifications(prev => {
          // Play a friendly notification alert tone if we detect new announcements!
          if (prev.length > 0 && data.length > prev.length) {
            try {
              const audio = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-200.wav");
              audio.volume = 0.40;
              audio.play().catch(() => {});
            } catch (_) {}
          }
          return data;
        });
      }
    } catch (e) {
      console.error("Failed to load notifications", e);
    }
  };

  const fetchApplications = async () => {
    try {
      const res = await apiFetch("/api/applications");
      if (res.ok) {
        const data = await res.json();
        setApplications(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

const fetchPortfolio = async () => {
  try {
const portfolioRes = await apiFetch("/api/portfolio")
if (!portfolioRes.ok) return;


const response = await portfolioRes.json();
    const holdings = Array.isArray(response)
      ? response
      : response?.holdings ?? response?.data ?? response?.items ?? [];

    if (!Array.isArray(holdings) || holdings.length === 0) {
      setPortfolio([]);
      portfolioRef.current = [];
      return;
    }

    const normalizedHoldings = holdings.map((h: any) => ({
      ...h,
      quantity: Number(h.quantity ?? h.shares ?? 0),
      avgCost: Number(h.avgCost ?? h.averagePrice ?? h.avg_price ?? 0),
      currentPrice: Number(h.currentPrice ?? h.current_price ?? h.avgCost ?? 0),
    }));

    portfolioRef.current = normalizedHoldings;
    setPortfolio(normalizedHoldings);

const symbols = normalizedHoldings
  .map((h: any) => h.symbol)
  .filter(Boolean)
  .join(",");
    if (!symbols) return;

    const liveRes = await fetch(`/api/groww/holdings/live?symbols=${encodeURIComponent(symbols)}`);
    if (!liveRes.ok) return;

    const responseJson = await liveRes.json();
    const liveData = Array.isArray(responseJson)
      ? responseJson
      : responseJson?.data?.content || responseJson?.data || responseJson?.holdings || [];

    setPortfolio(prev =>
      prev.map(h => {
        const live = liveData.find((x: any) =>
          x.symbol === h.symbol ||
          x.nseScripCode === h.symbol ||
          x.ticker === h.symbol
        );

        const latestPrice = Number(live?.latestPrice ?? live?.ltp ?? live?.lastPrice ?? live?.price);

        return {
          ...h,
          quantity: Number(h.quantity || 0),
          avgCost: Number(h.avgCost || 0),
          currentPrice: Number.isFinite(latestPrice) && latestPrice > 0
            ? latestPrice
            : Number(h.currentPrice || h.avgCost || 0),
        };
      })
    );
  } catch (e) {
    console.error("Failed to load portfolio", e);
  }
};

  const handleAddHolding = async (
    ipoId: string,
    avgCost: number,
    quantity: number
  ) => {
    const growwRes = await apiFetch(`/api/groww/holding/${encodeURIComponent(ipoId)}`)

    let symbol = ipoId;
    let companyName = ipoId;

    if (growwRes.ok) {
      const groww = await growwRes.json();
      symbol =
        groww?.nseScripCode ||
        groww?.symbol ||
        groww?.ticker ||
        ipoId;

      companyName =
        groww?.companyName ||
        groww?.company_short_name ||
        groww?.title ||
        groww?.name ||
        ipoId;
    } else {
      const ipo = ipos.find(i => i.id === ipoId || i.symbol === ipoId || i.name === ipoId);
      if (ipo) {
        symbol = ipo.symbol;
        companyName = ipo.companyName || ipo.name;
      }
    }

    const holding = {
      id: crypto.randomUUID(),
      ipoId,
      symbol,
      companyName,
      quantity,
      avgCost,
      currentPrice: avgCost,
    } as PortfolioHolding;

    const portfolioRes = await apiFetch("/api/portfolio", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ipoId,
        symbol,
        companyName,
        avgCost,
        quantity,
        currentPrice: avgCost,
      }),
    });

    if (!portfolioRes.ok) {
      const error = await portfolioRes.text();
      throw new Error(error || "Failed to save portfolio holding");
    }

    console.log("Holding added", holding);

    await apiFetch("/api/portfolio/history/record", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ipoId,
        symbol,
        companyName,
        quantity,
        avgCost,
        currentPrice: avgCost,
      }),
    });

    await fetchPortfolio();
  };

  const handleDeleteHolding = async (id: number | string) => {
    const res = await apiFetch(`/api/portfolio/${id}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(error || "Failed to delete holding");
    }

    await fetchPortfolio();
  };

  const handleClearNotifications = async () => {
    try {
      const res = await apiFetch("/api/notifications/clear", { method: "POST" });
      if (res.ok) {
        setNotifications([]);
      }
    } catch (e) {
      console.error("Failed to clear notifications", e);
    }
  };

  const handleNseSync = async () => {
    try {
      const res = await apiFetch("/api/applications/nse-sync", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setApplications(data.applications);
        setNotifications(data.notifications);
        if (data.ipos) {
          setIpos(data.ipos);
        }
        return true;
      }
    } catch (e) {
      console.error("NSE sync failed", e);
    }
    return false;
  };

  const handleSignOut = async () => {
    localStorage.removeItem("iposense_access_token");
    localStorage.removeItem("iposense_refresh_token");
    localStorage.removeItem("iposense_user");
    setUser(null);
    setActiveTab("dashboard");
    window.dispatchEvent(new Event("iposense_auth_changed"));
  };

  useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      const allowedOrigins = [
        "http://localhost:3001",
        "http://localhost:5173",
        window.location.origin,
      ];

      if (!allowedOrigins.includes(event.origin)) return;

      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        const payload = event.data;

        if (payload.accessToken) {
          localStorage.setItem("iposense_access_token", payload.accessToken);
        }
        if (payload.refreshToken) {
          localStorage.setItem("iposense_refresh_token", payload.refreshToken);
        }
        if (payload.user) {
          localStorage.setItem("iposense_user", JSON.stringify(payload.user));
          setUser(payload.user);
        }

        setIsAuthModalOpen(false);
        window.dispatchEvent(new Event("iposense_auth_changed"));
      }
    };

    window.addEventListener("message", handleOAuthMessage);
    const handleAuthChange = () => {
      try {
        const saved = localStorage.getItem("iposense_user");
        if (saved) {
          setUser(JSON.parse(saved));
        } else {
          setUser(null);
        }
      } catch (_) {
        setUser(null);
      }
    };

    window.addEventListener("iposense_auth_changed", handleAuthChange);

    (async () => {
      setLoading(true);
      try {
        await Promise.all([
          fetchApplications(),
          fetchPortfolio(),
          fetchNotifications(),
          fetchWatchlist(),
          fetchNews(),
        ]);
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      window.removeEventListener("iposense_auth_changed", handleAuthChange);
      window.removeEventListener("message", handleOAuthMessage);
    };
  }, []);

  useEffect(() => {
    // Fetch non-user-specific IPO general catalog
    fetchIpos();

    // Establish real-time Server-Sent Events (SSE) connection
    const eventSource = new EventSource("/api/sse/live-stream");
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "GMP_TICK") {
          // Incrementally update only the specific IPO's grey market premium (GMP)
          setIpos(prev => prev.map(ipo => {
            if (ipo.symbol === data.ipoSymbol) {
              return { ...ipo, gmp: data.gmp };
            }
            return ipo;
          }));
          
          // Pull new database-backed notifications triggered by background celery worker
          fetchNotifications();
        }
      } catch (err) {
        console.error("Failed to parse SSE event payload:", err);
      }
    };

    // Active automatic polling for allotments, alerts, and portfolios as backup
    const timer = setInterval(() => {
      fetchNotifications();
      fetchNews();
      fetchApplications();
      console.log("Polling tick", new Date().toISOString());
      fetchPortfolio();
    }, 2000);

    return () => {
      clearInterval(timer);
      eventSource.close();
    };
  }, []);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  // Application tracker handler
  const handleTrackApplication = async (app: {
    ipoId: string;
    pan: string;
    appNumber: string;
    broker: string;
    category: 'RETAIL' | 'HNI' | 'EMPLOYEE' | 'SHAREHOLDER';
    lots: number;
    investmentAmount: number;
    upiId: string;
  }) => {
    try {
      const res = await apiFetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(app)
      });
      if (res.ok) {
        await fetchApplications();
      } else {
        const err = await res.json();
        throw new Error(err.error || "Failed to record application");
      }
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  // Total Portfolio value calculation
  const portfolioValue = portfolio.reduce((sum, h) => sum + (h.currentPrice * h.quantity), 0);

  return (
    <div className={darkMode ? "dark text-foreground bg-background min-h-screen" : "text-foreground bg-background min-h-screen"}>
      <div className="flex h-screen overflow-hidden">
        
        {/* Sidebar */}
        <Sidebar 
          activeTab={activeTab} 
          setActiveTab={setActiveTab} 
          darkMode={darkMode} 
          setDarkMode={setDarkMode} 
          user={user}
          onSignInClick={() => setIsAuthModalOpen(true)}
          onSignOutClick={handleSignOut}
        />

        {/* Workspace Container */}
        <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
          
          {/* Global Header */}
          <header className="h-16 border-b border-border bg-card px-3 md:px-8 flex justify-between items-center shrink-0">
            <div className="flex items-center space-x-3 text-xs">
              <div className="flex items-center space-x-1 text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span className="font-mono text-[10px] md:text-xs">
                  {new Date().toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric"
                  })}
                </span>
              </div>
            </div>

            <div className="ml-auto flex items-center space-x-2 md:space-x-4 text-xs font-mono">
              <span className="hidden md:inline text-muted-foreground">Server Connection Status:</span>
              <span className="font-bold text-emerald-500">OPTIMAL</span>
              
              <div className="hidden sm:block h-4 w-px bg-border"></div>
              
              {/* Premium Theme Switcher toggle */}
              <button
                onClick={() => setDarkMode(!darkMode)}
                className="flex items-center space-x-1 px-2 md:px-3 py-1.5 rounded-xl border border-border bg-muted/40 hover:bg-muted text-foreground transition-all duration-200 cursor-pointer"
                title={darkMode ? "Switch to Light Theme" : "Switch to Dark Theme"}
                id="header-theme-toggle"
              >
                {darkMode ? (
                  <>
                    <Sun className="h-3.5 w-3.5 text-amber-500" />
                    <span className="hidden md:inline text-[11px] font-sans font-medium">Light Mode</span>
                  </>
                ) : (
                  <>
                    <Moon className="h-3.5 w-3.5 text-indigo-500" />
                    <span className="hidden md:inline text-[11px] font-sans font-medium">Dark Mode</span>
                  </>
                )}
              </button>
            </div>
          </header>
 
          {/* Main Dashboard Panel workspace content */}
          <main className="flex-1 overflow-y-auto p-8 bg-background scrollbar-thin">
            {loading ? (
              <div className="h-full flex flex-col items-center justify-center space-y-3">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary"></div>
                <span className="text-xs font-mono text-muted-foreground animate-pulse">Synchronizing multi-source financial indexes...</span>
              </div>
            ) : (
              <>
                {activeTab === "admin" && (
                  <AdminCenter 
                    onNseSync={handleNseSync}
                  />
                )}
                {activeTab === "research" && (
                  <ResearchHub ipos={ipos} />
                )}
                {activeTab === "dashboard" && (
                  <DashboardOverview 
                    ipos={ipos} 
                    onNavigate={setActiveTab} 
                    applicationsCount={applications.length}
                    portfolioValue={portfolioValue || 142500}
                    notifications={notifications}
                    onClearNotifications={handleClearNotifications}
                  />
                )}
                {activeTab === "discovery" && (
                  <IpoDiscovery 
                    ipos={ipos} 
                    watchlist={watchlist}
                    onToggleWatchlist={handleToggleWatchlist}
                    onTrackApplication={handleTrackApplication} 
                    user={user}
                  />
                )}
                {activeTab === "tracker" && (
                  <AllotmentTracker 
                    applications={applications} 
                    ipos={ipos} 
                    onRefreshList={fetchApplications}
                    onNseSync={handleNseSync}
                  />
                )}
                {activeTab === "listing" && (
                  <ListingDayAI />
                )}
                {activeTab === "portfolio" && (
                  <PortfolioHoldings
                    holdings={portfolio}
                    ipos={ipos}
                    watchlist={watchlist}
                    onToggleWatchlist={handleToggleWatchlist}
                    onAddHolding={handleAddHolding}
                    onDeleteHolding={handleDeleteHolding}
                  />
                )}
                {activeTab === "arena" && (
                  <AiArena ipos={ipos} />
                )}
                {activeTab === "rhp-analyzer" && (
                  <RhpAnalyzer />
                )}
                {activeTab === "news-analyzer" && (
                  <NewsAnalyzer />
                )}
                {activeTab === "social-analyzer" && (
                  <SocialAnalyzer />
                )}
                {activeTab === "market-intelligence" && (
                  <MarketIntelligence />
                )}
                {activeTab === "notifications" && (
                  <PushAlertsHub onNotificationTrigger={fetchNotifications} />
                )}
              </>
            )}
          </main>

        </div>
      </div>

      {/* Persistent Floating Chatbot */}
      <FloatingChatbot />

      {/* Auth Modal for cloud user sessions */}
      <AuthModal 
        isOpen={isAuthModalOpen} 
        onClose={() => setIsAuthModalOpen(false)} 
      />

      {/* Interactive Guided Onboarding Tour Overlay */}
      <OnboardingTour activeTab={activeTab} setActiveTab={setActiveTab} />
    </div>
  );
}