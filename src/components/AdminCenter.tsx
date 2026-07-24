import React, { useState, useEffect } from "react";
import { 
  ShieldCheck, 
  Users, 
  Activity, 
  Terminal, 
  RefreshCw, 
  Settings, 
  CheckCircle2, 
  AlertCircle,
  Bell,
  Cpu,
  Database,
  Radio,
  Loader2,
  Clock,
  Globe,
  Coins,
  FileText,
  TrendingUp,
  Edit2,
  Check
} from "lucide-react";

interface UserRecord {
  id: number;
  uid: string;
  email: string;
  role: string;
  createdAt: string;
}

interface AuditLogRecord {
  id: number;
  userId: number | null;
  action: string;
  details: string;
  ipAddress: string | null;
  createdAt: string;
}

interface ApiUsageLogRecord {
  id: number;
  userId: number | null;
  endpoint: string;
  provider: string;
  tokensUsed: number;
  responseTimeMs: number | null;
  statusCode: number | null;
  createdAt: string;
}

interface MarketDataRecord {
  id: number;
  dataKey: string;
  dataValue: string;
  changePercent: string | null;
  updatedAt: string;
}

interface AdminCenterProps {
  onNseSync: () => Promise<boolean>;
}

export default function AdminCenter({ 
  onNseSync,
}: AdminCenterProps) {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [logs, setLogs] = useState<string[]>([
    "Initializing Secure Admin Console...",
    "System status: ONLINE",
    "PostgreSQL Database pool initialized with 10 connections.",
    "Celery beat worker scheduled for 12-second allotment audits."
  ]);

  // Sub-tabs
  const [subTab, setSubTab] = useState<"users" | "audits" | "api_logs" | "market_data" | "security">("users");

  // New state lists
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [apiLogs, setApiLogs] = useState<ApiUsageLogRecord[]>([]);
  const [marketRecords, setMarketRecords] = useState<MarketDataRecord[]>([]);
  const [loadingAudits, setLoadingAudits] = useState(false);
  const [loadingApiLogs, setLoadingApiLogs] = useState(false);
  const [loadingMarket, setLoadingMarket] = useState(false);

  // Security dashboard states
  interface SecurityConfig {
    maskedSecrets: Record<string, string>;
    csrfStrictMode: boolean;
    activeCsrfTokensCount: number;
    blacklistedTokensCount: number;
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
    rateLimitStrictMaxRequests: number;
  }

  interface RateLimitLogRecord {
    id: string;
    ip: string;
    timestamp: string;
    path: string;
    method: string;
    status: "allowed" | "blocked";
  }

  const [securityConfig, setSecurityConfig] = useState<SecurityConfig | null>(null);
  const [rateLimitLogs, setRateLimitLogs] = useState<RateLimitLogRecord[]>([]);
  const [loadingSecurity, setLoadingSecurity] = useState(false);
  const [selectedSecretKey, setSelectedSecretKey] = useState<string>("");
  const [newSecretValue, setNewSecretValue] = useState("");

  // Market inline editing
  const [editingMarketId, setEditingMarketId] = useState<number | null>(null);
  const [editMarketValue, setEditMarketValue] = useState("");
  const [editMarketChange, setEditMarketChange] = useState("");

  const addLog = (text: string) => {
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${text}`, ...prev.slice(0, 49)]);
  };

  const fetchSecurityData = async () => {
    setLoadingSecurity(true);
    try {
      const [configRes, logsRes] = await Promise.all([
        fetch("/api/admin/security/secrets"),
        fetch("/api/admin/security/rate-limit-logs")
      ]);
      
      if (configRes.ok) {
        const configData = await configRes.json();
        setSecurityConfig(configData);
      }
      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setRateLimitLogs(logsData);
      }
      addLog("Retrieved dynamic keys registry, CSRF tokens cache, and rate limits logs.");
    } catch (err: any) {
      addLog(`Error fetching security status: ${err.message}`);
    } finally {
      setLoadingSecurity(false);
    }
  };

  const handleRotateSecret = async () => {
    if (!selectedSecretKey || !newSecretValue.trim()) {
      setMessage({ type: "error", text: "Please select a target configuration key and input a valid value." });
      return;
    }

    setLoadingSecurity(true);
    try {
      const res = await fetch("/api/admin/security/secrets/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: selectedSecretKey, value: newSecretValue })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message });
        setSecurityConfig(prev => prev ? { ...prev, maskedSecrets: data.maskedSecrets } : null);
        addLog(`Key rotated successfully: ${selectedSecretKey}`);
        setNewSecretValue("");
        setTimeout(() => setMessage(null), 3000);
      } else {
        throw new Error(data.error || "Secret rotation processing failed.");
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
      addLog(`Error rotating secret '${selectedSecretKey}': ${err.message}`);
    } finally {
      setLoadingSecurity(false);
    }
  };

  const handleRevokeAllSessions = async () => {
    if (!window.confirm("CRITICAL ACTION: This rotates the JWT Refresh Secret and blacklists ALL outstanding sessions. All Analysts and Investors will be instantly logged out. Proceed?")) {
      return;
    }

    setLoadingSecurity(true);
    try {
      const res = await fetch("/api/admin/security/revoke-refresh-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message });
        addLog("Emergency Session Expulsion complete: rotated refresh token signing key.");
        await fetchSecurityData();
        setTimeout(() => setMessage(null), 4000);
      } else {
        throw new Error(data.error || "Revocation failed.");
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
      addLog(`Error executing emergency expulsion: ${err.message}`);
    } finally {
      setLoadingSecurity(false);
    }
  };

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data);
        addLog("Successfully refreshed database users register.");
      } else {
        throw new Error("Forbidden or error fetching user catalog.");
      }
    } catch (err: any) {
      addLog(`Error: Failed to fetch users register: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const fetchAudits = async () => {
    setLoadingAudits(true);
    try {
      const res = await fetch("/api/admin/audit-logs");
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data.reverse()); // latest first
        addLog("Loaded system audit trails successfully.");
      }
    } catch (err: any) {
      addLog(`Error loading audits: ${err.message}`);
    } finally {
      setLoadingAudits(false);
    }
  };

  const fetchApiLogs = async () => {
    setLoadingApiLogs(true);
    try {
      const res = await fetch("/api/admin/api-usage-logs");
      if (res.ok) {
        const data = await res.json();
        setApiLogs(data.reverse()); // latest first
        addLog("Loaded API Usage metric reports successfully.");
      }
    } catch (err: any) {
      addLog(`Error loading API logs: ${err.message}`);
    } finally {
      setLoadingApiLogs(false);
    }
  };

  const fetchMarket = async () => {
    setLoadingMarket(true);
    try {
      const res = await fetch("/api/market-data");
      if (res.ok) {
        const data = await res.json();
        setMarketRecords(data);
        addLog("Retrieved active indices market tables.");
      }
    } catch (err: any) {
      addLog(`Error loading market variables: ${err.message}`);
    } finally {
      setLoadingMarket(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    if (subTab === "users") fetchUsers();
    if (subTab === "audits") fetchAudits();
    if (subTab === "api_logs") fetchApiLogs();
    if (subTab === "market_data") fetchMarket();
    if (subTab === "security") fetchSecurityData();
  }, [subTab]);

  const handleRoleChange = async (userId: number, newRole: string) => {
    try {
      const res = await fetch("/api/admin/change-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, targetRole: newRole })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message });
        addLog(`Role migrated: User ID #${userId} transitioned to ${newRole}`);
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u));
        setTimeout(() => setMessage(null), 3000);
      } else {
        throw new Error(data.error || "Role update failed");
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
      addLog(`Error: Role migration failed for User ID #${userId}: ${err.message}`);
    }
  };

  const handleUpdateMarket = async (record: MarketDataRecord) => {
    try {
      const res = await fetch("/api/market-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataKey: record.dataKey,
          dataValue: editMarketValue,
          changePercent: editMarketChange
        })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: `Market parameter ${record.dataKey} successfully updated!` });
        addLog(`Market modified: Updated ${record.dataKey} -> ${editMarketValue} (${editMarketChange})`);
        setEditingMarketId(null);
        fetchMarket();
        setTimeout(() => setMessage(null), 3000);
      } else {
        throw new Error(data.error || "Index value update aborted");
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message });
    }
  };

  const handleSyncClick = async () => {
    setSyncing(true);
    addLog("Triggering manual NSE Allotment Guard Check...");
    try {
      const success = await onNseSync();
      if (success) {
        setMessage({ type: "success", text: "Successfully synchronized with National Stock Exchange databases!" });
        addLog("NSE Sync Complete. Processed 4 allotments and updated portfolio positions.");
      } else {
        throw new Error("NSE Response timeout");
      }
    } catch (err: any) {
      setMessage({ type: "error", text: `NSE Sync Failed: ${err.message}` });
      addLog(`Error: Allotment sync aborted: ${err.message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const handleTestTrigger = async (type: "gmp-surge" | "allot-status") => {
    addLog(`Dispatching test broadcast: ${type === "gmp-surge" ? "GMP SURGED ALERTS" : "ALLOTMENT DISPATCH"}`);
    try {
      const endpoint = type === "gmp-surge" ? "/api/notifications/test-send" : "/api/notifications/test-status-trigger";
      const res = await fetch(endpoint, { method: "POST" });
      if (res.ok) {
        setMessage({ type: "success", text: `Triggered test broadcast successfully!` });
        addLog(`Broadcast success. Transmitted 4 alert dispatches via Push/SMS/Email vectors.`);
      } else {
        throw new Error("Non-200 callback status.");
      }
    } catch (err: any) {
      addLog(`Error: Broadcast trigger aborted: ${err.message}`);
    } finally {
      setTimeout(() => setMessage(null), 3000);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 px-2 sm:px-4 py-2" id="admin-center-root">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-red-500/10 via-rose-500/5 to-transparent border border-red-500/20 rounded-xl sm:rounded-2xl p-4 sm:p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full bg-red-500/15 text-red-400 border border-red-500/25 text-[10px] font-semibold uppercase tracking-wider">
            <ShieldCheck className="h-3 w-3 mr-1" /> Admin Panel Active
          </div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">Platform Control Room</h2>
          <p className="text-xs sm:text-sm text-gray-400">Trigger background tasks, audit rate limit variables, inspect audit logs and system API telemetry directly.</p>
        </div>
      </div>

      {/* Info Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-card border border-border rounded-xl p-3 sm:p-4 flex items-center space-x-3 shadow-sm">
          <div className="p-2 sm:p-2.5 bg-indigo-500/15 border border-indigo-500/20 rounded-xl text-indigo-400 shrink-0">
            <Cpu className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] uppercase font-mono text-gray-500 truncate">Service Eng.</div>
            <div className="text-xs sm:text-sm font-bold text-white truncate">Express + Vite</div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-3 sm:p-4 flex items-center space-x-3 shadow-sm">
          <div className="p-2 sm:p-2.5 bg-emerald-500/15 border border-emerald-500/20 rounded-xl text-emerald-400 shrink-0">
            <Database className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] uppercase font-mono text-gray-500 truncate">Postgres Pool</div>
            <div className="text-xs sm:text-sm font-bold text-white truncate">10 Active (Pool)</div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-3 sm:p-4 flex items-center space-x-3 shadow-sm">
          <div className="p-2 sm:p-2.5 bg-violet-500/15 border border-violet-500/20 rounded-xl text-violet-400 shrink-0">
            <Radio className="h-4 w-4 sm:h-5 sm:w-5 animate-pulse" />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] uppercase font-mono text-gray-500 truncate">Event Stream</div>
            <div className="text-xs sm:text-sm font-bold text-white truncate">SSE Active</div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-3 sm:p-4 flex items-center space-x-3 shadow-sm">
          <div className="p-2 sm:p-2.5 bg-rose-500/15 border border-rose-500/20 rounded-xl text-rose-400 shrink-0">
            <Activity className="h-4 w-4 sm:h-5 sm:w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] uppercase font-mono text-gray-500 truncate">Audit Status</div>
            <div className="text-xs sm:text-sm font-bold text-white truncate">12s Beats Active</div>
          </div>
        </div>
      </div>

      {/* Sub Tab Navigation */}
      <div className="flex border-b border-border space-x-1 sm:space-x-2 overflow-x-auto pb-px no-scrollbar">
        <button
          onClick={() => setSubTab("users")}
          className={`px-3 sm:px-4 py-2 text-xs font-bold transition-all border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === "users" 
              ? "border-primary text-primary" 
              : "border-transparent text-gray-400 hover:text-white"
          }`}
        >
          <div className="flex items-center space-x-1.5">
            <Users className="h-3.5 w-3.5" />
            <span>User Management</span>
          </div>
        </button>

        <button
          onClick={() => setSubTab("audits")}
          className={`px-3 sm:px-4 py-2 text-xs font-bold transition-all border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === "audits" 
              ? "border-primary text-primary" 
              : "border-transparent text-gray-400 hover:text-white"
          }`}
        >
          <div className="flex items-center space-x-1.5">
            <Globe className="h-3.5 w-3.5" />
            <span>Audit Trails</span>
          </div>
        </button>

        <button
          onClick={() => setSubTab("api_logs")}
          className={`px-3 sm:px-4 py-2 text-xs font-bold transition-all border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === "api_logs" 
              ? "border-primary text-primary" 
              : "border-transparent text-gray-400 hover:text-white"
          }`}
        >
          <div className="flex items-center space-x-1.5">
            <Activity className="h-3.5 w-3.5" />
            <span>API Usage Stats</span>
          </div>
        </button>

        <button
          onClick={() => setSubTab("market_data")}
          className={`px-3 sm:px-4 py-2 text-xs font-bold transition-all border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === "market_data" 
              ? "border-primary text-primary" 
              : "border-transparent text-gray-400 hover:text-white"
          }`}
        >
          <div className="flex items-center space-x-1.5">
            <Coins className="h-3.5 w-3.5" />
            <span>Market Data Tables</span>
          </div>
        </button>

        <button
          onClick={() => setSubTab("security")}
          className={`px-3 sm:px-4 py-2 text-xs font-bold transition-all border-b-2 cursor-pointer whitespace-nowrap shrink-0 ${
            subTab === "security" 
              ? "border-primary text-primary" 
              : "border-transparent text-gray-400 hover:text-white"
          }`}
        >
          <div className="flex items-center space-x-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Security & Secrets</span>
          </div>
        </button>
      </div>

      {/* Live Message Center */}
      {message && (
        <div className={`p-3 sm:p-4 rounded-xl border flex items-start space-x-2 text-xs sm:text-sm ${
          message.type === "success" 
            ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" 
            : "bg-destructive/10 border-destructive/20 text-destructive-foreground"
        }`}>
          {message.type === "success" ? <CheckCircle2 className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" /> : <AlertCircle className="h-4 w-4 sm:h-5 sm:w-5 shrink-0" />}
          <span className="break-words">{message.text}</span>
        </div>
      )}

      {/* Main Grid: Rendered view and system tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        
        {/* Left/Middle Col: Active Tab View */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-6">
          
          {subTab === "users" && (
            <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
              <div className="flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <Users className="h-4 w-4 sm:h-4.5 sm:w-4.5 text-primary shrink-0" />
                  <h3 className="text-xs sm:text-sm font-bold text-gray-200">Registered Users Register (Postgres)</h3>
                </div>
                <button 
                  onClick={fetchUsers}
                  disabled={loading}
                  className="p-1.5 rounded-lg border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer shrink-0"
                  title="Refresh register list"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                </button>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                  <table className="w-full text-left border-collapse text-xs min-w-[500px]">
                    <thead>
                      <tr className="border-b border-border pb-2 text-gray-500">
                        <th className="py-2.5 font-semibold">ID</th>
                        <th className="py-2.5 font-semibold">Email</th>
                        <th className="py-2.5 font-semibold">Registered Role</th>
                        <th className="py-2.5 font-semibold text-right">Transition Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((usr) => (
                        <tr key={usr.id} className="border-b border-border hover:bg-muted/30 transition-all">
                          <td className="py-3 font-mono text-gray-400">#{usr.id}</td>
                          <td className="py-3 text-white truncate max-w-[120px] sm:max-w-[150px]">{usr.email}</td>
                          <td className="py-3">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider whitespace-nowrap ${
                              usr.role === "ADMINISTRATOR" 
                                ? "bg-red-500/15 text-red-400 border border-red-500/10" 
                                : usr.role === "RESEARCH_ANALYST"
                                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/10"
                                  : "bg-primary/15 text-primary border border-primary/10"
                            }`}>
                              {usr.role}
                            </span>
                          </td>
                          <td className="py-3 text-right">
                            <select
                              value={usr.role}
                              onChange={(e) => handleRoleChange(usr.id, e.target.value)}
                              className="bg-background border border-border rounded-lg text-[10px] font-semibold px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary text-gray-200 cursor-pointer"
                            >
                              <option value="INVESTOR">Investor</option>
                              <option value="RESEARCH_ANALYST">Research Analyst</option>
                              <option value="ADMINISTRATOR">Administrator</option>
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {subTab === "audits" && (
            <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
              <div className="flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <FileText className="h-4 w-4 sm:h-4.5 sm:w-4.5 text-rose-400 shrink-0" />
                  <h3 className="text-xs sm:text-sm font-bold text-gray-200">System Security Audit Trail (Postgres)</h3>
                </div>
                <button 
                  onClick={fetchAudits}
                  disabled={loadingAudits}
                  className="p-1.5 rounded-lg border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer shrink-0"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingAudits ? "animate-spin" : ""}`} />
                </button>
              </div>

              {loadingAudits ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : auditLogs.length === 0 ? (
                <div className="text-center py-8 text-xs text-gray-500">
                  No system audits logged in PostgreSQL database yet.
                </div>
              ) : (
                <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0 max-h-[400px] overflow-y-auto">
                  <table className="w-full text-left border-collapse text-xs min-w-[550px]">
                    <thead>
                      <tr className="border-b border-border pb-2 text-gray-500 sticky top-0 bg-card">
                        <th className="py-2.5 font-semibold">Timestamp</th>
                        <th className="py-2.5 font-semibold">User ID</th>
                        <th className="py-2.5 font-semibold">Action</th>
                        <th className="py-2.5 font-semibold">IP Address</th>
                        <th className="py-2.5 font-semibold">Event Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((log) => (
                        <tr key={log.id} className="border-b border-border/50 hover:bg-muted/20 transition-all">
                          <td className="py-3 font-mono text-[10px] text-gray-500 whitespace-nowrap">
                            {new Date(log.createdAt).toLocaleTimeString()}
                          </td>
                          <td className="py-3 font-mono text-gray-400 whitespace-nowrap">
                            {log.userId ? `#${log.userId}` : "SYSTEM"}
                          </td>
                          <td className="py-3">
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/10 font-mono text-[10px] font-bold whitespace-nowrap">
                              {log.action}
                            </span>
                          </td>
                          <td className="py-3 font-mono text-gray-500 whitespace-nowrap">{log.ipAddress || "127.0.0.1"}</td>
                          <td className="py-3 text-white truncate max-w-[150px] sm:max-w-[200px]" title={log.details}>
                            {log.details}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {subTab === "api_logs" && (
            <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
              <div className="flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <Activity className="h-4 w-4 sm:h-4.5 sm:w-4.5 text-indigo-400 shrink-0" />
                  <h3 className="text-xs sm:text-sm font-bold text-gray-200">API Usage Telemetry & Groq Metrics</h3>
                </div>
                <button 
                  onClick={fetchApiLogs}
                  disabled={loadingApiLogs}
                  className="p-1.5 rounded-lg border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer shrink-0"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingApiLogs ? "animate-spin" : ""}`} />
                </button>
              </div>

              {loadingApiLogs ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : apiLogs.length === 0 ? (
                <div className="text-center py-8 text-xs text-gray-500">
                  No API calls logged in telemetry tables yet.
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Summary Bar */}
                  <div className="grid grid-cols-3 gap-2 p-3 bg-[#0b0f19] rounded-xl border border-border text-center">
                    <div>
                      <div className="text-[8px] sm:text-[9px] uppercase font-mono text-gray-500">Total API Cycles</div>
                      <div className="text-xs sm:text-sm font-bold text-white">{apiLogs.length}</div>
                    </div>
                    <div>
                      <div className="text-[8px] sm:text-[9px] uppercase font-mono text-gray-500">Avg Latency</div>
                      <div className="text-xs sm:text-sm font-bold text-emerald-400">
                        {Math.round(apiLogs.reduce((acc, curr) => acc + (curr.responseTimeMs || 0), 0) / apiLogs.length)} ms
                      </div>
                    </div>
                    <div>
                      <div className="text-[8px] sm:text-[9px] uppercase font-mono text-gray-500">Total Tokens</div>
                      <div className="text-xs sm:text-sm font-bold text-indigo-400">
                        {apiLogs.reduce((acc, curr) => acc + (curr.tokensUsed || 0), 0)}
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0 max-h-[300px] overflow-y-auto">
                    <table className="w-full text-left border-collapse text-xs min-w-[450px]">
                      <thead>
                        <tr className="border-b border-border pb-2 text-gray-500 sticky top-0 bg-card">
                          <th className="py-2.5 font-semibold">Endpoint</th>
                          <th className="py-2.5 font-semibold">Provider</th>
                          <th className="py-2.5 font-semibold">Response</th>
                          <th className="py-2.5 font-semibold">Tokens</th>
                          <th className="py-2.5 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {apiLogs.map((log) => (
                          <tr key={log.id} className="border-b border-border/50 hover:bg-muted/20 transition-all">
                            <td className="py-3 font-mono text-white text-[11px] truncate max-w-[100px] sm:max-w-[120px]" title={log.endpoint}>
                              {log.endpoint}
                            </td>
                            <td className="py-3 font-bold text-gray-300">{log.provider}</td>
                            <td className="py-3 font-mono text-emerald-400">
                              {log.responseTimeMs ? `${log.responseTimeMs}ms` : "-"}
                            </td>
                            <td className="py-3 font-mono text-indigo-400">{log.tokensUsed || 0}</td>
                            <td className="py-3">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                                log.statusCode === 200 
                                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10" 
                                  : "bg-destructive/10 text-destructive-foreground"
                              }`}>
                                {log.statusCode || 200}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {subTab === "market_data" && (
            <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
              <div className="flex justify-between items-center">
                <div className="flex items-center space-x-2">
                  <TrendingUp className="h-4 w-4 sm:h-4.5 sm:w-4.5 text-emerald-400 shrink-0" />
                  <h3 className="text-xs sm:text-sm font-bold text-gray-200">Global Indices & GMP Tables (Postgres)</h3>
                </div>
                <button 
                  onClick={fetchMarket}
                  disabled={loadingMarket}
                  className="p-1.5 rounded-lg border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer shrink-0"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingMarket ? "animate-spin" : ""}`} />
                </button>
              </div>

              {loadingMarket ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                  <table className="w-full text-left border-collapse text-xs min-w-[500px]">
                    <thead>
                      <tr className="border-b border-border pb-2 text-gray-500">
                        <th className="py-2.5 font-semibold">Index Key</th>
                        <th className="py-2.5 font-semibold">Value</th>
                        <th className="py-2.5 font-semibold">Day Change</th>
                        <th className="py-2.5 font-semibold">Updated At</th>
                        <th className="py-2.5 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {marketRecords.map((rec) => (
                        <tr key={rec.id} className="border-b border-border hover:bg-muted/30 transition-all">
                          <td className="py-3 font-mono font-bold text-primary">{rec.dataKey}</td>
                          <td className="py-3">
                            {editingMarketId === rec.id ? (
                              <input
                                type="text"
                                value={editMarketValue}
                                onChange={(e) => setEditMarketValue(e.target.value)}
                                className="bg-background border border-border rounded-lg text-xs font-semibold px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary text-white w-20 sm:w-24"
                              />
                            ) : (
                              <span className="text-white font-mono font-bold">{rec.dataValue}</span>
                            )}
                          </td>
                          <td className="py-3">
                            {editingMarketId === rec.id ? (
                              <input
                                type="text"
                                value={editMarketChange}
                                onChange={(e) => setEditMarketChange(e.target.value)}
                                className="bg-background border border-border rounded-lg text-xs font-semibold px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary text-white w-16 sm:w-20"
                              />
                            ) : (
                              <span className={`font-mono font-semibold ${
                                (rec.changePercent || "").startsWith("+") 
                                  ? "text-emerald-400" 
                                  : (rec.changePercent || "").startsWith("-")
                                    ? "text-rose-400"
                                    : "text-gray-400"
                              }`}>
                                {rec.changePercent || "0.00%"}
                              </span>
                            )}
                          </td>
                          <td className="py-3 text-gray-500 text-[10px] font-mono whitespace-nowrap">
                            {new Date(rec.updatedAt).toLocaleTimeString()}
                          </td>
                          <td className="py-3 text-right">
                            {editingMarketId === rec.id ? (
                              <div className="flex justify-end space-x-1">
                                <button
                                  onClick={() => handleUpdateMarket(rec)}
                                  className="p-1 rounded bg-emerald-500/25 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/30 transition-all cursor-pointer"
                                  title="Save index change"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={() => setEditingMarketId(null)}
                                  className="p-1 rounded border border-border hover:bg-muted text-gray-400 hover:text-white transition-all cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  setEditingMarketId(rec.id);
                                  setEditMarketValue(rec.dataValue);
                                  setEditMarketChange(rec.changePercent || "");
                                }}
                                className="p-1 rounded border border-border hover:bg-muted text-muted-foreground hover:text-white transition-all cursor-pointer"
                                title="Edit Index value"
                              >
                                <Edit2 className="h-3 w-3" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {subTab === "security" && (
            <div className="space-y-4 sm:space-y-6">
              {/* Top Summary Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-3.5 sm:p-4 flex items-center space-x-3.5">
                  <div className="p-2.5 sm:p-3 bg-blue-500/10 rounded-xl text-blue-400 shrink-0">
                    <ShieldCheck className="h-5 w-5 sm:h-6 sm:w-6" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-gray-500 font-bold truncate">CSRF Defense</p>
                    <p className="text-base sm:text-lg font-extrabold text-white truncate">Active (Double-Submit)</p>
                    <p className="text-[10px] sm:text-xs text-emerald-400 font-medium truncate">Verified Custom Header Engine</p>
                  </div>
                </div>

                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-3.5 sm:p-4 flex items-center space-x-3.5">
                  <div className="p-2.5 sm:p-3 bg-amber-500/10 rounded-xl text-amber-400 shrink-0">
                    <RefreshCw className="h-5 w-5 sm:h-6 sm:w-6" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-gray-500 font-bold truncate">Refresh Token Rotation</p>
                    <p className="text-base sm:text-lg font-extrabold text-white truncate">Rotated & Blacklisted</p>
                    <p className="text-[10px] sm:text-xs text-gray-400 font-medium truncate">{(securityConfig && securityConfig.blacklistedTokensCount) || 0} expired keys invalidated</p>
                  </div>
                </div>

                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-3.5 sm:p-4 flex items-center space-x-3.5">
                  <div className="p-2.5 sm:p-3 bg-purple-500/10 rounded-xl text-purple-400 shrink-0">
                    <Activity className="h-5 w-5 sm:h-6 sm:w-6" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-gray-500 font-bold truncate">Active CSRF Sessions</p>
                    <p className="text-base sm:text-lg font-extrabold text-white truncate">{(securityConfig && securityConfig.activeCsrfTokensCount) || 0} Handshakes</p>
                    <p className="text-[10px] sm:text-xs text-purple-400 font-medium truncate">Valid session headers cache</p>
                  </div>
                </div>
              </div>

              {/* Secrets Manager & Key Rotation */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">
                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
                  <div className="flex items-center space-x-2">
                    <Settings className="h-4.5 w-4.5 text-primary shrink-0" />
                    <h3 className="text-xs sm:text-sm font-bold text-gray-200">Dynamic Secrets Manager & Key Rotation</h3>
                  </div>

                  <p className="text-xs text-gray-400 leading-relaxed">
                    Credentials and encryption keys are retrieved dynamically from memory. Rotating sensitive keys immediately updates active systems without requiring server reboots.
                  </p>

                  <div className="p-3 sm:p-4 bg-muted/40 border border-border rounded-xl space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1.5">Select Key to Rotate</label>
                        <select
                          value={selectedSecretKey}
                          onChange={(e) => setSelectedSecretKey(e.target.value)}
                          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-primary"
                        >
                          <option value="">-- Choose Key --</option>
                          {securityConfig && Object.keys(securityConfig.maskedSecrets).map(key => (
                            <option key={key} value={key}>{key}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1.5">New Key/Value Configuration</label>
                        <input
                          type="password"
                          placeholder="••••••••••••••••"
                          value={newSecretValue}
                          onChange={(e) => setNewSecretValue(e.target.value)}
                          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-primary"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end pt-1">
                      <button
                        onClick={handleRotateSecret}
                        disabled={loadingSecurity || !selectedSecretKey || !newSecretValue}
                        className="w-full sm:w-auto px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold rounded-lg transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-1.5"
                      >
                        <RefreshCw className={`h-3 w-3 ${loadingSecurity ? "animate-spin" : ""}`} />
                        <span>Rotate Security Key</span>
                      </button>
                    </div>
                  </div>

                  {/* Secrets Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-border pb-2 text-gray-500">
                          <th className="py-2 font-semibold">Environment Key</th>
                          <th className="py-2 font-semibold text-right">Masked Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {securityConfig && Object.entries(securityConfig.maskedSecrets).map(([key, value]) => (
                          <tr key={key} className="border-b border-border/40 hover:bg-muted/10 transition-all">
                            <td className="py-2.5 font-mono text-[11px] text-gray-300 font-semibold">{key}</td>
                            <td className="py-2.5 text-right font-mono text-[11px] text-gray-500">{value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Emergency Session Revocation & CSRF */}
                <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-5 shadow-sm">
                  <div className="flex items-center space-x-2">
                    <AlertCircle className="h-4.5 w-4.5 text-destructive shrink-0" />
                    <h3 className="text-xs sm:text-sm font-bold text-gray-200">Emergency Global Session Revocation</h3>
                  </div>

                  <div className="p-3 sm:p-4 bg-destructive/5 border border-destructive/20 rounded-xl space-y-3">
                    <p className="text-xs text-destructive-foreground/90 font-medium">
                      CRITICAL: If you suspect a user account breach, dynamic token key compromise, or malicious session takeover:
                    </p>
                    <p className="text-xs text-gray-400 leading-relaxed">
                      Executing an emergency session revocation rotates the secret key used for signing refresh tokens instantly. All active refresh tokens across every browser and account will instantly fail verification, purging unauthorized persistent sessions and securing the server environment.
                    </p>
                    <div className="pt-2">
                      <button
                        onClick={handleRevokeAllSessions}
                        disabled={loadingSecurity}
                        className="w-full py-2.5 bg-destructive hover:bg-destructive/95 text-destructive-foreground text-xs font-extrabold rounded-lg transition-all cursor-pointer flex items-center justify-center space-x-2 shadow-sm shadow-destructive/10"
                      >
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span>Execute Emergency Session Expulsion</span>
                      </button>
                    </div>
                  </div>

                  {/* Rate Limiting Configuration Parameters */}
                  <div className="space-y-3 pt-1">
                    <div className="flex items-center space-x-2">
                      <Terminal className="h-4.5 w-4.5 text-purple-400 shrink-0" />
                      <h3 className="text-xs sm:text-sm font-bold text-gray-200">Rate Limiting System Specs</h3>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
                      <div className="bg-muted/40 p-3 rounded-xl border border-border/80">
                        <p className="text-[9px] uppercase tracking-wider text-gray-500 font-bold">Sliding Window</p>
                        <p className="text-xs sm:text-sm font-black text-white mt-0.5">
                          {securityConfig ? securityConfig.rateLimitWindowMs / 1000 / 60 : 15} Min
                        </p>
                        <span className="text-[9px] text-gray-400 font-mono">
                          {securityConfig?.rateLimitWindowMs || 900000} ms
                        </span>
                      </div>

                      <div className="bg-muted/40 p-3 rounded-xl border border-border/80">
                        <p className="text-[9px] uppercase tracking-wider text-gray-500 font-bold">Standard Limit</p>
                        <p className="text-xs sm:text-sm font-black text-white mt-0.5">
                          {securityConfig && securityConfig.rateLimitMaxRequests >= 1000000000000 ? "Unlimited" : securityConfig?.rateLimitMaxRequests || "Unlimited"} Req
                        </p>
                        <span className="text-[9px] text-gray-400">Standard API routes</span>
                      </div>

                      <div className="bg-muted/40 p-3 rounded-xl border border-border/80">
                        <p className="text-[9px] uppercase tracking-wider text-gray-500 font-bold">Strict Limit</p>
                        <p className="text-xs sm:text-sm font-black text-white mt-0.5">
                          {securityConfig && securityConfig.rateLimitStrictMaxRequests >= 1000000000000 ? "Unlimited" : securityConfig?.rateLimitStrictMaxRequests || "Unlimited"} Req
                        </p>
                        <span className="text-[9px] text-gray-400">Auth, admin, AI routes</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Rate Limiting Logs Dashboard */}
              <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
                <div className="flex justify-between items-center">
                  <div className="flex items-center space-x-2">
                    <Activity className="h-4.5 w-4.5 text-purple-400 shrink-0" />
                    <h3 className="text-xs sm:text-sm font-bold text-gray-200">Real-Time IP Traffic & Rate Limiting Blocks</h3>
                  </div>
                  <button
                    onClick={fetchSecurityData}
                    disabled={loadingSecurity}
                    className="p-1.5 rounded-lg border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer shrink-0"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${loadingSecurity ? "animate-spin" : ""}`} />
                  </button>
                </div>

                <p className="text-xs text-gray-400 leading-relaxed">
                  Below is the live-stream audit of incoming API requests tracked by the IP Rate Limiter. Request status is dynamically logged in real-time.
                </p>

                {rateLimitLogs.length === 0 ? (
                  <div className="text-center py-8 border border-dashed border-border/60 rounded-xl">
                    <p className="text-xs text-gray-500">No recent rate limiter traffic logs captured.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                    <table className="w-full text-left border-collapse text-xs min-w-[500px]">
                      <thead>
                        <tr className="border-b border-border pb-2 text-gray-500">
                          <th className="py-2.5 font-semibold">Requester IP</th>
                          <th className="py-2.5 font-semibold">Method</th>
                          <th className="py-2.5 font-semibold">Endpoint Route</th>
                          <th className="py-2.5 font-semibold">Timestamp</th>
                          <th className="py-2.5 font-semibold text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rateLimitLogs.map((log) => (
                          <tr key={log.id} className="border-b border-border/40 hover:bg-muted/10 transition-all font-mono">
                            <td className="py-2.5 text-gray-300 font-semibold whitespace-nowrap">{log.ip}</td>
                            <td className="py-2.5">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                log.method === "GET" ? "bg-blue-500/10 text-blue-400" :
                                log.method === "POST" ? "bg-emerald-500/10 text-emerald-400" :
                                "bg-amber-500/10 text-amber-400"
                              }`}>
                                {log.method}
                              </span>
                            </td>
                            <td className="py-2.5 text-gray-400 max-w-[120px] sm:max-w-xs truncate" title={log.path}>
                              {log.path}
                            </td>
                            <td className="py-2.5 text-gray-500 whitespace-nowrap">
                              {new Date(log.timestamp).toLocaleTimeString()}
                            </td>
                            <td className="py-2.5 text-right font-sans">
                              {log.status === "allowed" ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/10 whitespace-nowrap">
                                  ● Allowed
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-destructive/10 text-destructive-foreground border border-destructive/20 animate-pulse whitespace-nowrap">
                                  ● Blocked
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Right Col: Tasks & Controls */}
        <div className="space-y-4 sm:space-y-6">
          
          {/* Action Hub */}
          <div className="bg-card border border-border rounded-xl sm:rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
            <h3 className="text-xs sm:text-sm font-bold text-gray-200">Trigger Audit Task Routines</h3>
            <div className="space-y-2.5">
              
              {/* Sync Trigger */}
              <button
                onClick={handleSyncClick}
                disabled={syncing}
                className="w-full py-2 px-3 bg-primary text-primary-foreground hover:bg-primary/95 text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition-all cursor-pointer disabled:opacity-50"
              >
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 shrink-0" />}
                <span>Trigger NSE Allotment Audit</span>
              </button>

              {/* Test alerts broadcasts */}
              <button
                onClick={() => handleTestTrigger("gmp-surge")}
                className="w-full py-2 px-3 bg-muted hover:bg-muted/80 text-foreground text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition-all border border-border cursor-pointer"
              >
                <Bell className="h-4 w-4 text-violet-400 shrink-0" />
                <span>Simulate GMP Surge Alert</span>
              </button>

              <button
                onClick={() => handleTestTrigger("allot-status")}
                className="w-full py-2 px-3 bg-muted hover:bg-muted/80 text-foreground text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition-all border border-border cursor-pointer"
              >
                <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                <span>Simulate Allotment Guard Check</span>
              </button>

            </div>
          </div>

          {/* System Terminal Console */}
          <div className="bg-[#0b0f19] border border-border rounded-xl sm:rounded-2xl p-3.5 sm:p-4 space-y-2 shadow-sm font-mono text-[10px]">
            <div className="flex items-center space-x-1.5 border-b border-border/40 pb-2 mb-2 text-gray-500">
              <Terminal className="h-3 w-3 text-red-500 shrink-0" />
              <span className="font-bold">SYSTEM BROADCAST TERMINAL LOGS</span>
            </div>
            
            <div className="space-y-1.5 h-[140px] sm:h-[160px] overflow-y-auto pr-1 select-none">
              {logs.map((log, index) => (
                <div key={index} className="text-gray-400 truncate">
                  <span className="text-red-400">▶</span> {log}
                </div>
              ))}
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}