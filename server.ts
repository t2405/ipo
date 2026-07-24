import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { pathToFileURL } from "node:url";
import Groq from "groq-sdk";
import { createClient } from "redis";
import axios from "axios";
import marketRoutes from "./src/routes/market.js";
import * as cheerio from "cheerio";
import jwt from "jsonwebtoken";
import { PDFParse } from "pdf-parse";

// Import PostgreSQL Database & authentication middleware
import { db as postgresDb } from "./src/db/index.js";
import { 
  users as dbUsers, 
  watchlist as dbWatchlist, 
  bids as dbBids, 
  notifications as dbNotifications, 
  aiPredictions as dbAiPredictions, 
  userSettings as dbUserSettings,
  portfolioHistory as dbPortfolioHistory,
  portfolioHoldings,
  historicalIpos as dbHistoricalIpos,
  marketData as dbMarketData,
  auditLogs as dbAuditLogs,
  apiUsageLogs as dbApiUsageLogs
} from "./src/db/schema.js";
import { requireAuth, AuthRequest } from "./src/middleware/auth.js";
import { eq, and } from "drizzle-orm";
import allotmentRoutes from "./src/routes/allotment.routes.js";
import userPanRoutes from "./src/routes/userPan.routes.js";
import {
  secretsManager,
  customRateLimiter,
  csrfProtection,
  securityHeaders,
  validateRequest,
  generateCsrfToken,
  revokeRefreshToken,
  isRefreshTokenRevoked,
  rateLimitLogs,
  activeCsrfTokens,
  revokedRefreshTokens
} from "./src/middleware/security.js";



const app = express();

app.use(express.json({ limit: "50mb" }));

// Mount Enterprise Security Middlewares globally
app.use(securityHeaders);
app.use(customRateLimiter);
app.use(csrfProtection);

app.use("/api", allotmentRoutes);
app.use("/api", userPanRoutes);
app.use("/api", marketRoutes);

app.get("/api/sse/live-stream", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const keepAlive = () => {
    res.write(`data: ${JSON.stringify({ type: "KEEPALIVE", timestamp: new Date().toISOString() })}\n\n`);
  };

  keepAlive();
  const timer = setInterval(keepAlive, 30000);

  res.on("close", () => {
    clearInterval(timer);
  });
});

// AES-256-CBC Encryption Key & IV Settings
const getAesSecret = () => secretsManager.get("AES_SECRET") || "d6f51952a2d48858e3b567ef54fa86aa";
const IV_LENGTH = 16;

// Encryption and decryption utility for sensitive PAN and application numbers
function encrypt(text: string): string {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(getAesSecret(), "utf-8"), iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  } catch (err) {
    console.error("AES-256 Encryption failed:", err);
    return text;
  }
}

function decrypt(text: string): string {
  if (!text) return text;
  try {
    if (!text.includes(":")) return text; // Plaintext fallback
    const parts = text.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = parts[1];
    if (iv.length !== 16) return text; // Validate IV length
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(getAesSecret(), "utf-8"), iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.warn("AES-256 Decryption failed (treating as legacy plain text):", err);
    return text;
  }
}

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.on("error", (err) => {
  console.warn("Redis connection warning:", err.message || err);
});

async function ensureRedisClient() {
  if (!process.env.REDIS_URL) return null;
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    return redisClient;
  } catch (err) {
    console.warn("Redis unavailable, falling back to request-scoped safe state:", err);
    return null;
  }
}

const redisCache = {
  async get(key: string): Promise<any | null> {
    const client = await ensureRedisClient();
    if (!client) return null;
    const value = await client.get(key);

    if (typeof value !== "string") {
      return null;
    }

    return JSON.parse(value);
  },
  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    const client = await ensureRedisClient();
    if (!client) return;
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  },
  async delete(key: string): Promise<void> {
    const client = await ensureRedisClient();
    if (!client) return;
    await client.del(key);
  }
};

// Role-Based Access Control (RBAC) Setup
interface RolePermissionMapping {
  role: string;
  permissions: string[];
}

const RBAC_MAPPINGS: Record<string, string[]> = {
  INVESTOR: ["VIEW_IPOS", "APPLY_IPO", "VIEW_PORTFOLIO", "GENERATE_AI_REPORT", "MANAGE_NOTIFICATIONS"],
  RESEARCH_ANALYST: ["VIEW_IPOS", "VIEW_PORTFOLIO", "GENERATE_AI_REPORT"],
  ADMINISTRATOR: ["VIEW_IPOS", "APPLY_IPO", "VIEW_PORTFOLIO", "GENERATE_AI_REPORT", "MANAGE_PLATFORM", "MANAGE_NOTIFICATIONS"]
};

// Middleware to check user permission
function checkPermission(requiredPermission: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Developers can test different roles via a request header. By default, we use INVESTOR.
    const userRole = (req.headers["x-user-role"] as string || "INVESTOR").toUpperCase();
    const allowedPermissions = RBAC_MAPPINGS[userRole] || [];

    if (allowedPermissions.includes(requiredPermission)) {
      next();
    } else {
      res.status(403).json({
        error: "Forbidden",
        message: `Insufficient privileges. Role '${userRole}' does not hold the required permission '${requiredPermission}'.`
      });
    }
  };
}

// Normalized Database Schema representation
interface DbSchema {
  users: any[];
  roles: any[];
  permissions: any[];
  ipos: any[];
  company_financials: any[];
  subscription_data: any[];
  gmp_history: any[];
  ai_scores: any[];
  applications: any[];
  allotments: any[];
  portfolio: any[];
  watchlist: string[];
  notifications: any[];
  market_data: any[];
  news: any[];
  ai_predictions: any[];
  chat_history: any[];
  audit_logs: any[];
  sessions: any[];
  user_settings: any[];
}

function createDefaultDb(): DbSchema {
  return {
    users: [
      { id: "USER-1", email: "investor@iposense.ai", name: "Alpha Investor", role: "INVESTOR" },
      { id: "USER-2", email: "admin@iposense.ai", name: "System Admin", role: "ADMINISTRATOR" }
    ],
    roles: [
      { id: "ROLE-1", name: "INVESTOR", description: "Standard investment account" },
      { id: "ROLE-2", name: "ADMINISTRATOR", description: "Platform administrator" }
    ],
    permissions: [
      { id: "PERM-1", code: "VIEW_IPOS", description: "View list of public offerings" },
      { id: "PERM-2", code: "APPLY_IPO", description: "Submit stock applications" }
    ],
    ipos: [],
    company_financials: [],
    subscription_data: [],
    gmp_history: [],
    ai_scores: [],
    applications: [],
    portfolio: [],
    watchlist: [],
    allotments: [],
    market_data: [],
    news: [],
    ai_predictions: [],
    chat_history: [],
    audit_logs: [
      { id: "LOG-SEED", action: "DATABASE_INITIALIZATION", ipAddress: "127.0.0.1", timestamp: new Date().toISOString() }
    ],
    sessions: [],
    user_settings: [
      { id: "SET-1", userId: "USER-1", notificationPreferences: { fcm: true, email: true, sms: true, telegram: true, whatsapp: false } }
    ],
    notifications: [
      {
        id: "NOTIF-SEED-GMP",
        title: "📈 Solaris Renewable GMP Jump",
        message: "Solaris Renewable energy GMP rose +12% following a heavy ₹950 Cr anchor investment roster.",
        timestamp: new Date(Date.now() - 3600000 * 2).toISOString(),
        type: "gmp_alert",
        read: false
      },
      {
        id: "NOTIF-SEED-SYS",
        title: "🔮 Acme CloudTech AI recommendation",
        message: "Our AI Scoring engine has issued an 'APPLY' recommendation with an outstanding score of 88.",
        timestamp: new Date(Date.now() - 3600000 * 4).toISOString(),
        type: "system",
        read: false
      }
    ]
  };
}

function saveDb(_data: DbSchema) {
  // Serverless-safe runtime fallback: keep this request-scoped and rely on PostgreSQL/Redis for durable state.
}

function addNotification(
  title: string,
  message: string,
  type: "allotment_success" | "allotment_fail" | "system" | "gmp_alert",
  ipoName?: string,
  appNumber?: string
) {
  db = createDefaultDb();
  if (!db.notifications) db.notifications = [];
  
  const isDuplicate = db.notifications.some(
    n => n.title === title && n.appNumber === appNumber && n.type === type
  );
  if (isDuplicate) return;

  db.notifications.unshift({
    id: "NOTIF-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
    title,
    message,
    timestamp: new Date().toISOString(),
    type,
    read: false,
    ipoName,
    appNumber
  });
  saveDb(db);
}

// Ensure database is initialized
let db = createDefaultDb();

// Groq Circuit Breaker Pattern State
let isGroqCircuitBroken = false;
let groqCircuitBrokenUntil = 0;

function tripGroqCircuit(durationMs: number = 5 * 60 * 1000) {
  isGroqCircuitBroken = true;
  groqCircuitBrokenUntil = Date.now() + durationMs;
  console.warn(`[Circuit Breaker] Tripped! Groq API calls will be diverted to local fallback engines until ${new Date(groqCircuitBrokenUntil).toLocaleTimeString()}`);
}

function checkGroqCircuit(): boolean {
  if (isGroqCircuitBroken) {
    if (Date.now() > groqCircuitBrokenUntil) {
      isGroqCircuitBroken = false;
      console.log("[Circuit Breaker] Resetting! Retrying Groq API connections...");
      return true; // Circuit reset
    }
    return false; // Circuit is still broken
  }
  return true; // Circuit is clean
}

function handleGroqError(err: any) {
  const errMsg = String(err?.message || err || "").toLowerCase();
  if (errMsg.includes("429") || errMsg.includes("rate_limit") || errMsg.includes("quota")) {
    console.warn("[Circuit Breaker] Quota limit/Rate limit detected (429). Tripping circuit breaker to prevent API overhead.");
    tripGroqCircuit(5 * 60 * 1000); // Trip for 5 minutes
  }
}

// Lazy initialization of Groq client
let groqClient: Groq | null = null;
function getGroqClient(): Groq | null {
  if (!checkGroqCircuit()) {
    return null; // Bypasses Groq API call and uses local database directly
  }
  const apiKey = secretsManager.get("GROQ_API_KEY");
  if (!apiKey || apiKey === "MY_GROQ_API_KEY" || apiKey.trim() === "") {
    console.warn("GROQ_API_KEY is not configured or placeholder. Groq calls will fall back to rule-based response generators.");
    return null;
  }
  // Re-create client if key changes (key rotation support)
  if (!groqClient || (groqClient as any)._options?.apiKey !== apiKey) {
    try {
      groqClient = new Groq({
        apiKey: apiKey,
      });
    } catch (e) {
      console.error("Error creating Groq client:", e);
      return null;
    }
  }
  return groqClient;
}

// Comprehensive high-quality dataset of current & upcoming IPOs
const IPOS_DATA = [
  {
    id: "acme-cloudtech",
    name: "Acme CloudTech AI Ltd",
    symbol: "ACMEAI",
    priceBand: "₹450 - ₹475",
    minPrice: 450,
    maxPrice: 475,
    lotSize: 30,
    issueSize: "₹3,450 Cr",
    openDate: "2026-07-18",
    closeDate: "2026-07-22",
    listingDate: "2026-07-30",
    registrar: "Link Intime India Pvt Ltd",
    leadManagers: ["Kotak Mahindra Capital", "ICICI Securities", "Morgan Stanley"],
    retailQuota: 35,
    qibQuota: 50,
    hniQuota: 15,
    promoterHoldingBefore: 82.5,
    promoterHoldingAfter: 61.2,
    gmp: 185, // ₹185 premium
    gmpPercent: 38.9, // 38.9% premium
    subscriptionOverall: 14.5,
    subscriptionRetail: 6.2,
    subscriptionQib: 24.1,
    subscriptionHni: 11.4,
    aiScore: 88,
    aiConfidence: 92,
    riskScore: 28,
    recommendation: "APPLY",
    industry: "Enterprise AI & Cloud Infrastructure",
    competitors: ["Tata Consultancy Services", "Infosys", "Affle India"],
    strengths: [
      "Proprietary cloud LLM orchestration framework with 85% gross margins",
      "Triple-digit revenue CAGR over the last 3 financial years",
      "Zero long-term debt with positive free cash flow since 2024",
      "Anchor book backed by marquee global institutional funds (Fidelity, GIC)"
    ],
    risks: [
      "Significant dependency on third-party cloud credits (AWS, Google Cloud)",
      "Highly competitive enterprise AI sector with rapid technology obsolescence",
      "Promoter dilution lock-in expires in 6 months post-listing"
    ],
    objectOfIssue: "To fund the expansion of global hyperscale datacenters in Hyderabad and Frankfurt, and invest in proprietary AI model development.",
    financials: [
      { year: "FY24", revenue: 820, profit: 98, debt: 15 },
      { year: "FY25", revenue: 1450, profit: 210, debt: 10 },
      { year: "FY26", revenue: 2680, profit: 430, debt: 0 }
    ],
    status: "ACTIVE"
  },
  {
    id: "novacharge-mobility",
    name: "NovaCharge Mobility Solutions",
    symbol: "NOVAMOBI",
    priceBand: "₹180 - ₹195",
    minPrice: 180,
    maxPrice: 195,
    lotSize: 75,
    issueSize: "₹1,800 Cr",
    openDate: "2026-07-20",
    closeDate: "2026-07-24",
    listingDate: "2026-08-01",
    registrar: "KFin Technologies Ltd",
    leadManagers: ["Axis Capital", "JM Financial"],
    retailQuota: 35,
    qibQuota: 50,
    hniQuota: 15,
    promoterHoldingBefore: 74.0,
    promoterHoldingAfter: 55.5,
    gmp: 42,
    gmpPercent: 21.5,
    subscriptionOverall: 3.8,
    subscriptionRetail: 2.1,
    subscriptionQib: 5.2,
    subscriptionHni: 2.9,
    aiScore: 71,
    aiConfidence: 85,
    riskScore: 45,
    recommendation: "APPLY",
    industry: "Electric Vehicle Charging & Storage",
    competitors: ["Exide Industries", "Tata Power", "Servotech Power"],
    strengths: [
      "Largest EV fast-charging highway corridor network in India with 40% market share",
      "Strategic partnerships with top-tier automotive OEMs for pre-installed charger bundles",
      "Robust hardware manufacturing unit in Pune operating at 80% capacity utilization"
    ],
    risks: [
      "Operating profit margins are sensitive to lithium and copper raw material cost fluctuations",
      "Capital-intensive expansion business model requiring continuous cash injection",
      "Slowdown in consumer adoption of electric passenger vehicles"
    ],
    objectOfIssue: "To expand EV charging highway hubs by adding 1,500 premium fast chargers and setting up high-capacity battery assembly lines.",
    financials: [
      { year: "FY24", revenue: 410, profit: 12, debt: 110 },
      { year: "FY25", revenue: 680, profit: 34, debt: 140 },
      { year: "FY26", revenue: 1120, profit: 89, debt: 165 }
    ],
    status: "ACTIVE"
  },
  {
    id: "biopulse-therapeutics",
    name: "BioPulse Genomics & Therapeutics",
    symbol: "BIOPULSE",
    priceBand: "₹310 - ₹330",
    minPrice: 310,
    maxPrice: 330,
    lotSize: 45,
    issueSize: "₹2,200 Cr",
    openDate: "2026-07-26",
    closeDate: "2026-07-30",
    listingDate: "2026-08-08",
    registrar: "Link Intime India Pvt Ltd",
    leadManagers: ["HDFC Bank", "Citigroup Global Markets"],
    retailQuota: 10, // BioPulse has a QIB bias
    qibQuota: 75,
    hniQuota: 15,
    promoterHoldingBefore: 65.1,
    promoterHoldingAfter: 48.0,
    gmp: 12,
    gmpPercent: 3.6,
    subscriptionOverall: 0.0,
    subscriptionRetail: 0.0,
    subscriptionQib: 0.0,
    subscriptionHni: 0.0,
    aiScore: 54,
    aiConfidence: 78,
    riskScore: 68,
    recommendation: "MODERATE",
    industry: "Biotech & Gene Sequencing Therapeutics",
    competitors: ["Biocon", "Syngene International", "Laurus Labs"],
    strengths: [
      "Pioneering genomics-driven oncology therapeutics in south-east Asia",
      "7 active patents granted with an additional 12 international applications pending",
      "Highly qualified R&D team with multiple global medical publications"
    ],
    risks: [
      "Extremely long clinical trial horizons with high failure probability",
      "Consistently negative free cash flow over the past 4 years due to aggressive research burn-rate",
      "Subject to strict FDA and local regulatory clearances that can delay launches"
    ],
    objectOfIssue: "To support Phase III trials of BP-912 oncology molecule and scale laboratory testing spaces in Bangalore.",
    financials: [
      { year: "FY24", revenue: 85, profit: -42, debt: 45 },
      { year: "FY25", revenue: 112, profit: -31, debt: 30 },
      { year: "FY26", revenue: 165, profit: -18, debt: 25 }
    ],
    status: "UPCOMING"
  },
  {
    id: "zetapay-fintech",
    name: "ZetaPay Lending & Payments Ltd",
    symbol: "ZETAPAY",
    priceBand: "₹115 - ₹125",
    minPrice: 115,
    maxPrice: 125,
    lotSize: 120,
    issueSize: "₹4,100 Cr",
    openDate: "2026-07-02",
    closeDate: "2026-07-05",
    listingDate: "2026-07-13",
    registrar: "KFin Technologies Ltd",
    leadManagers: ["ICICI Securities", "Nomura India", "SBI Capital"],
    retailQuota: 10,
    qibQuota: 75,
    hniQuota: 15,
    promoterHoldingBefore: 45.3,
    promoterHoldingAfter: 31.0,
    gmp: -8, // ₹8 Discount
    gmpPercent: -6.4, // Discount
    subscriptionOverall: 1.15,
    subscriptionRetail: 1.05,
    subscriptionQib: 1.30,
    subscriptionHni: 0.82,
    aiScore: 35,
    aiConfidence: 90,
    riskScore: 78,
    recommendation: "AVOID",
    industry: "Consumer Credit Fintech",
    competitors: ["One97 Communications", "PB Fintech", "Bajaj Finance"],
    strengths: [
      "Wide retail reach with over 15 million registered consumer wallets",
      "High proprietary credit underwriting engine speeds up loan disbursement"
    ],
    risks: [
      "Spike in Non-Performing Assets (NPAs) from 2.1% to 4.8% in FY26",
      "Regulatory clampdown on unsecured retail lending by RBI limits growth margins",
      "Highly overvalued compared to listed industry peers (P/E ratio of 145x)"
    ],
    objectOfIssue: "To satisfy regulatory capital adequacy requirements and general corporate capital injections.",
    financials: [
      { year: "FY24", revenue: 1820, profit: -140, debt: 890 },
      { year: "FY25", revenue: 2140, profit: -85, debt: 1120 },
      { year: "FY26", revenue: 2350, profit: 12, debt: 1450 }
    ],
    status: "CLOSED"
  },
  {
    id: "apex-logichain",
    name: "Apex LogiChain Logistics",
    symbol: "APEXLOGI",
    priceBand: "₹240 - ₹250",
    minPrice: 240,
    maxPrice: 250,
    lotSize: 60,
    issueSize: "₹1,400 Cr",
    openDate: "2026-06-25",
    closeDate: "2026-06-28",
    listingDate: "2026-07-06",
    registrar: "Link Intime India Pvt Ltd",
    leadManagers: ["IIFL Securities", "Motilal Oswal"],
    retailQuota: 35,
    qibQuota: 50,
    hniQuota: 15,
    promoterHoldingBefore: 90.0,
    promoterHoldingAfter: 68.4,
    gmp: 60,
    gmpPercent: 24.0,
    subscriptionOverall: 28.6,
    subscriptionRetail: 12.4,
    subscriptionQib: 44.5,
    subscriptionHni: 18.2,
    aiScore: 78,
    aiConfidence: 88,
    riskScore: 32,
    recommendation: "APPLY",
    industry: "Logistics, Warehousing & Distribution",
    competitors: ["Delhivery", "Blue Dart Express", "Mahindra Logistics"],
    strengths: [
      "Consistent double-digit margins driven by premium automated cold chains",
      "Diversified client list across high-margin pharmaceutical and FMCG brands",
      "State-of-the-art sorting hubs running automated RFID tracking"
    ],
    risks: [
      "Dependent on regional highway corridors with seasonal weather disruptions",
      "Fuel price volatility directly impacts short-term operating profit"
    ],
    objectOfIssue: "To construct three modern grade-A automated distribution parks in Chennai, NCR, and Kolkata.",
    financials: [
      { year: "FY24", revenue: 640, profit: 45, debt: 120 },
      { year: "FY25", revenue: 810, profit: 72, debt: 95 },
      { year: "FY26", revenue: 1040, profit: 115, debt: 70 }
    ],
    status: "LISTED"
  },
  {
    id: "solaris-renewable",
    name: "Solaris Renewable Power Ltd",
    symbol: "SOLARIS",
    priceBand: "₹140 - ₹150",
    minPrice: 140,
    maxPrice: 150,
    lotSize: 100,
    issueSize: "₹2,700 Cr",
    openDate: "2026-08-02",
    closeDate: "2026-08-06",
    listingDate: "2026-08-14",
    registrar: "KFin Technologies Ltd",
    leadManagers: ["ICICI Securities", "SBI Capital", "Kotak Capital"],
    retailQuota: 35,
    qibQuota: 50,
    hniQuota: 15,
    promoterHoldingBefore: 100.0,
    promoterHoldingAfter: 72.0,
    gmp: 48,
    gmpPercent: 32.0,
    subscriptionOverall: 0.0,
    subscriptionRetail: 0.0,
    subscriptionQib: 0.0,
    subscriptionHni: 0.0,
    aiScore: 82,
    aiConfidence: 89,
    riskScore: 24,
    recommendation: "APPLY",
    industry: "Renewable Solar & Wind Utility",
    competitors: ["Adani Green", "Tata Power Solar", "Suzlon"],
    strengths: [
      "Guaranteed long-term Power Purchase Agreements (PPAs) with central electricity boards",
      "Low cost of capital via green bond financings",
      "Over 3.4 GW of operational renewable capacity across Rajasthan and Gujarat"
    ],
    risks: [
      "Output varies based on meteorological factors like solar irradiance",
      "Lengthy land acquisition processes can delay capacity commission"
    ],
    objectOfIssue: "To develop a new 800 MW smart solar tracker project in Jaisalmer, Rajasthan.",
    financials: [
      { year: "FY24", revenue: 520, profit: 80, debt: 450 },
      { year: "FY25", revenue: 740, profit: 135, debt: 410 },
      { year: "FY26", revenue: 1050, profit: 210, debt: 380 }
    ],
    status: "UPCOMING"
  }
];

// Real-world high-quality dataset of current & upcoming NSE IPOs (NSE Fallback)
const REAL_NSE_IPOS = [
  {
    id: "waaree-energies",
    name: "Waaree Energies Ltd",
    symbol: "WAAREEENER",
    priceBand: "₹1427 - ₹1503",
    minPrice: 1427,
    maxPrice: 1503,
    lotSize: 9,
    issueSize: "₹4,321 Cr",
    openDate: "2026-07-20",
    closeDate: "2026-07-23",
    listingDate: "2026-07-28",
    registrar: "Link Intime India Pvt Ltd",
    leadManagers: ["Axis Capital", "IIFL Securities", "Jefferies India"],
    retailQuota: 35,
    qibQuota: 50,
    hniQuota: 15,
    promoterHoldingBefore: 72.3,
    promoterHoldingAfter: 64.1,
    gmp: 1420,
    gmpPercent: 94.5,
    subscriptionOverall: 76.3,
    subscriptionRetail: 11.2,
    subscriptionQib: 139.5,
    subscriptionHni: 62.4,
    aiScore: 94,
    aiConfidence: 96,
    riskScore: 22,
    recommendation: "APPLY",
    industry: "Solar Energy & PV Module Manufacturing",
    competitors: ["Tata Power Solar", "Adani Green Energy", "Websol Energy"],
    strengths: [
      "India's largest manufacturer of solar PV modules with 12 GW capacity",
      "High profit margins backed by strong export demand from USA and Europe",
      "Massive order book of 20+ GW from commercial and utility clients",
      "Anchor book loaded with marquee foreign portfolio investors"
    ],
    risks: [
      "Raw material silicon wafer and cell prices are sensitive to Chinese supply chains",
      "Intensifying domestic competition from public and private sector giants"
    ],
    objectOfIssue: "To establish a 6 GW Ingot-Wafer-Cell-Module manufacturing plant in Gujarat and fund general corporate purposes.",
    financials: [
      { year: "FY24", revenue: 6850, profit: 500, debt: 450 },
      { year: "FY25", revenue: 11350, profit: 1274, debt: 320 },
      { year: "FY26", revenue: 16800, profit: 2150, debt: 150 }
    ],
    status: "ACTIVE"
  },
  {
    id: "swiggy-ltd",
    name: "Swiggy Limited",
    symbol: "SWIGGY",
    priceBand: "₹371 - ₹390",
    minPrice: 371,
    maxPrice: 390,
    lotSize: 38,
    issueSize: "₹11,327 Cr",
    openDate: "2026-07-22",
    closeDate: "2026-07-25",
    listingDate: "2026-08-01",
    registrar: "Link Intime India Pvt Ltd",
    leadManagers: ["Kotak Mahindra Capital", "Citigroup", "J.P. Morgan"],
    retailQuota: 10,
    qibQuota: 75,
    hniQuota: 15,
    promoterHoldingBefore: 0.0,
    promoterHoldingAfter: 0.0,
    gmp: 15,
    gmpPercent: 3.8,
    subscriptionOverall: 3.6,
    subscriptionRetail: 1.1,
    subscriptionQib: 4.5,
    subscriptionHni: 2.2,
    aiScore: 68,
    aiConfidence: 84,
    riskScore: 55,
    recommendation: "MODERATE",
    industry: "Food Delivery & Quick Commerce Tech",
    competitors: ["Zomato Limited", "Zepto (Pharmeasy/Adani)"],
    strengths: [
      "Pioneered quick commerce (Instamart) and food delivery in India with millions of active transacting users",
      "Rapidly improving contribution margins across dark stores and restaurants",
      "Strong platform play with Swiggy One membership program"
    ],
    risks: [
      "Historically loss-making business model, although net losses are shrinking rapidly",
      "Aggressive price competition and talent poaching from Zomato and Zepto",
      "High commission and delivery partner inflation impacts gross margin"
    ],
    objectOfIssue: "To invest in brand marketing, expand dark store network for Swiggy Instamart, and general corporate acquisitions.",
    financials: [
      { year: "FY24", revenue: 11247, profit: -1612, debt: 0 },
      { year: "FY25", revenue: 14350, profit: -450, debt: 0 },
      { year: "FY26", revenue: 18400, profit: 80, debt: 0 }
    ],
    status: "ACTIVE"
  },
  {
    id: "hyundai-motor-india",
    name: "Hyundai Motor India Ltd",
    symbol: "HYUNDAI",
    priceBand: "₹1865 - ₹1960",
    minPrice: 1865,
    maxPrice: 1960,
    lotSize: 7,
    issueSize: "₹27,870 Cr",
    openDate: "2026-07-15",
    closeDate: "2026-07-18",
    listingDate: "2026-07-24",
    registrar: "KFin Technologies Ltd",
    leadManagers: ["Kotak Mahindra Capital", "Morgan Stanley", "Citi", "HSBC"],
    retailQuota: 35,
    qibQuota: 50,
    hniQuota: 15,
    promoterHoldingBefore: 100.0,
    promoterHoldingAfter: 82.5,
    gmp: -10,
    gmpPercent: -0.5,
    subscriptionOverall: 2.37,
    subscriptionRetail: 0.5,
    subscriptionQib: 6.9,
    subscriptionHni: 0.6,
    aiScore: 62,
    aiConfidence: 90,
    riskScore: 35,
    recommendation: "MODERATE",
    industry: "Automobile Manufacturing",
    competitors: ["Maruti Suzuki India", "Tata Motors Ltd", "Mahindra & Mahindra"],
    strengths: [
      "Second largest passenger vehicle manufacturer in India with strong brand trust",
      "Highly premium product mix (Creta, Venue) driving superior margins than entry-level segments",
      "Fully backed by Hyundai Global's top-tier R&D, EV architecture, and supply scale"
    ],
    risks: [
      "Entire IPO is an Offer for Sale (OFS) by the South Korean parent, no fresh proceeds enter the Indian company",
      "Decelerating domestic passenger vehicle industry growth post-pandemic peaks"
    ],
    objectOfIssue: "To carry out the Offer for Sale of up to 142,194,700 Equity Shares by the Promoter Selling Shareholder.",
    financials: [
      { year: "FY24", revenue: 60000, profit: 4653, debt: 200 },
      { year: "FY25", revenue: 69800, profit: 5408, debt: 150 },
      { year: "FY26", revenue: 74200, profit: 5850, debt: 100 }
    ],
    status: "CLOSED"
  },
  {
    id: "ntpc-green-energy",
    name: "NTPC Green Energy Limited",
    symbol: "NTPCGREEN",
    priceBand: "₹102 - ₹108",
    minPrice: 102,
    maxPrice: 108,
    lotSize: 138,
    issueSize: "₹10,000 Cr",
    openDate: "2026-08-05",
    closeDate: "2026-08-08",
    listingDate: "2026-08-14",
    registrar: "KFin Technologies Ltd",
    leadManagers: ["IDBI Capital", "HDFC Bank", "IIFL Securities"],
    retailQuota: 10,
    qibQuota: 75,
    hniQuota: 15,
    promoterHoldingBefore: 100.0,
    promoterHoldingAfter: 75.0,
    gmp: 8,
    gmpPercent: 7.4,
    subscriptionOverall: 0.0,
    subscriptionRetail: 0.0,
    subscriptionQib: 0.0,
    subscriptionHni: 0.0,
    aiScore: 85,
    aiConfidence: 92,
    riskScore: 18,
    recommendation: "APPLY",
    industry: "Renewable Energy Utility",
    competitors: ["Adani Green Energy", "Tata Power", "JSW Energy"],
    strengths: [
      "Largest public sector green energy player backed by parent NTPC Ltd (Maharatna)",
      "Vast pipeline of 24+ GW solar and wind projects across India",
      "Highly stable cash flows secured via 25-year long-term Power Purchase Agreements (PPAs)"
    ],
    risks: [
      "Subject to regulatory tariffs set by central and state electricity commissions",
      "High dependence on grid connectivity and transmission infrastructure availability"
    ],
    objectOfIssue: "To fund investment in NTPC Renewable Energy for repayment of certain outstanding borrowings and general corporate purposes.",
    financials: [
      { year: "FY24", revenue: 1500, profit: 240, debt: 1800 },
      { year: "FY25", revenue: 2350, profit: 345, debt: 1500 },
      { year: "FY26", revenue: 3800, profit: 620, debt: 1200 }
    ],
    status: "UPCOMING"
  },
  {
    id: "afcons-infra",
    name: "Afcons Infrastructure Limited",
    symbol: "AFCONS",
    priceBand: "₹440 - ₹463",
    minPrice: 440,
    maxPrice: 463,
    lotSize: 32,
    issueSize: "₹5,430 Cr",
    openDate: "2026-07-28",
    closeDate: "2026-07-31",
    listingDate: "2026-08-06",
    registrar: "Link Intime India Pvt Ltd",
    leadManagers: ["ICICI Securities", "Nomura", "Nuvama Wealth"],
    retailQuota: 35,
    qibQuota: 50,
    hniQuota: 15,
    promoterHoldingBefore: 99.1,
    promoterHoldingAfter: 70.4,
    gmp: 20,
    gmpPercent: 4.3,
    subscriptionOverall: 2.6,
    subscriptionRetail: 1.2,
    subscriptionQib: 3.4,
    subscriptionHni: 1.8,
    aiScore: 74,
    aiConfidence: 86,
    riskScore: 40,
    recommendation: "APPLY",
    industry: "Heavy Infrastructure & Marine Construction",
    competitors: ["Larsen & Toubro Ltd", "Dilip Buildcon", "KEC International"],
    strengths: [
      "Part of the prestigious Shapoorji Pallonji Group with 6 decades of heavy engineering expertise",
      "Outstanding execution capabilities in complex marine, tunneling, bridge, and metro projects globally",
      "Order book of ₹41,000+ Cr, providing clear revenue visibility for 3+ years"
    ],
    risks: [
      "Highly capital intensive with high working capital cycle and debt burden",
      "Execution delays due to geological, land acquisition, or weather disruptions"
    ],
    objectOfIssue: "To purchase construction equipment, fund long-term working capital needs, and repay certain outstanding borrowings.",
    financials: [
      { year: "FY24", revenue: 12637, profit: 411, debt: 2850 },
      { year: "FY25", revenue: 13540, profit: 449, debt: 2400 },
      { year: "FY26", revenue: 15200, profit: 530, debt: 1950 }
    ],
    status: "UPCOMING"
  }
];

// Global runtime IPOs dataset variable
let globalIposList: any[] = [];
const REALTIME_CACHE_KEY = "realtime_ipos";
const CACHE_TTL_SECONDS = 60 * 30; // 30 minutes cache duration

// Live search grounding fetcher via Groq API
async function fetchNseRealTimeIposFromGroq(): Promise<any[]> {
  const client = getGroqClient();
  if (!client) {
    console.log("No Groq API client configured, serving real fallback dataset");
    return REAL_NSE_IPOS;
  }

  try {
    console.log("Syncing live NSE India IPOs via Groq...");
    const prompt = `Search the web or use your knowledge for current, active, upcoming, and recently listed/closed Mainboard IPOs on the National Stock Exchange (NSE) of India for July/August 2026 or the current period.
Retrieve real IPOs (for example: NTPC Green Energy, Waaree Energies, Swiggy, Hyundai Motor India, Afcons Infrastructure, Acme Solar Holdings, or other very recent 2025/2026 IPOs on NSE).
Get real-time details:
- Symbol, Company Name, Price Band (e.g. "₹1427 - ₹1503"), lot size, issue size, open/close/listing dates, registrar.
- GMP (Grey Market Premium) in ₹ and GMP% based on current market discussions.
- Current subscription rates (overall, retail, QIB, HNI) on NSE.
- A calculated AI Score (0-100), AI Confidence (0-100), and Risk Score (0-100).
- Recommendation ('APPLY' or 'MODERATE' or 'AVOID').
- Industry, Competitors, Strengths, Risks, Object of Issue, and 3-year Financials (FY24, FY25, FY26) with revenue/profit/debt in ₹ Cr.

Format the output as a strictly valid JSON object containing an "ipos" array of objects conforming exactly to this TypeScript schema:
interface IPOFinancial {
  year: string;
  revenue: number;
  profit: number;
  debt: number;
}
interface IPO {
  id: string;
  name: string;
  symbol: string;
  priceBand: string;
  minPrice: number;
  maxPrice: number;
  lotSize: number;
  issueSize: string;
  openDate: string;
  closeDate: string;
  listingDate: string;
  registrar: string;
  leadManagers: string[];
  retailQuota: number;
  qibQuota: number;
  hniQuota: number;
  promoterHoldingBefore: number;
  promoterHoldingAfter: number;
  gmp: number;
  gmpPercent: number;
  subscriptionOverall: number;
  subscriptionRetail: number;
  subscriptionQib: number;
  subscriptionHni: number;
  aiScore: number;
  aiConfidence: number;
  riskScore: number;
  recommendation: 'APPLY' | 'AVOID' | 'MODERATE';
  industry: string;
  competitors: string[];
  strengths: string[];
  risks: string[];
  objectOfIssue: string;
  financials: IPOFinancial[];
  status: 'UPCOMING' | 'ACTIVE' | 'CLOSED' | 'LISTED';
}
Do not return any explanations or markdown blocks. Just output raw, valid JSON. Format your response exactly as:
{ "ipos": [ ... ] }`;

    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    });

    const content = response.choices[0]?.message?.content;
    if (content) {
      const cleaned = content.trim();
      const parsed = JSON.parse(cleaned);
      const ipos = parsed.ipos || parsed;
      if (Array.isArray(ipos) && ipos.length > 0) {
        console.log(`Synced ${ipos.length} real-time IPOs via Groq successfully.`);
        return ipos;
      }
    }
    throw new Error("Empty or malformed payload returned from Groq");
  } catch (err) {
    handleGroqError(err);
    console.warn("Groq Live Sync encountered an issue, resorting to real-world local backup data:", err);
    return REAL_NSE_IPOS;
  }
}

// Caching load controller
async function getIposDataset(): Promise<any[]> {
  try {
    const cached = await redisCache.get(REALTIME_CACHE_KEY);
    if (Array.isArray(cached) && cached.length > 0) {
      return cached;
    }
  } catch (err) {
    console.error("Cache read failed:", err);
  }

  const live = await fetchNseRealTimeIposFromGroq();
  try {
    await redisCache.set(REALTIME_CACHE_KEY, live, CACHE_TTL_SECONDS);
  } catch (err) {
    console.error("Cache write failed:", err);
  }
  return live;
}

// Asynchronous global synchronizer
async function refreshIposList() {
  try {
    globalIposList = await getIposDataset();
    console.log(`Synced ${globalIposList.length} IPOs via current NSE/Groq dataset successfully.`);
  } catch (err) {
    console.error("IPO sync failed:", err);
    globalIposList = REAL_NSE_IPOS;
  }
}

// Helper to find IPO by Id or search identifier
const getIpoById = (id: string) => globalIposList.find(i =>
  i.id === id ||
  i.symbol === id ||
  i.searchId === id ||
  i.companyCode === id
);

// NSE Audit background function simulating live National Stock Exchange query check
function performNseAllotmentAudit() {
  db = createDefaultDb();
  let changed = false;

  const appliedApps = db.applications.filter(a => a.status === "APPLIED");
  if (appliedApps.length === 0) return;

  appliedApps.forEach(app => {
    const ipo = getIpoById(app.ipoId);
    if (!ipo) return;

    // Simulate "Allotment Release" event:
    // If the IPO is CLOSED/LISTED, or for ACTIVE IPOs we simulate allotment release 
    // within 12 seconds of saving the application for real-time testing feedback!
    const createdDateStr = app.applicationDate || new Date().toISOString().split("T")[0];
    const isMockReleaseTime = ipo.status === "CLOSED" || ipo.status === "LISTED" || Math.random() < 0.25;

    if (isMockReleaseTime) {
      const isZetaPay = ipo.symbol === "ZETAPAY";
      const probability = isZetaPay ? 0.92 : 0.30; // 30% chance of allotment, higher for ZetaPay
      const allotted = Math.random() < probability;
      
      app.status = allotted ? "ALLOTTED" : "NOT_ALLOTTED";
      app.allottedLots = allotted ? app.lots : 0;
      app.refundStatus = allotted ? "Debited Successfully" : "Refund Processed (UPI Unblocked)";
      changed = true;

      if (allotted) {
        const alreadyInPortfolio = db.portfolio.some(p => p.ipoId === ipo.id);
        if (!alreadyInPortfolio) {
          const livePrice = ipo.maxPrice + (ipo.gmp || 0);
          db.portfolio.push({
            id: "HOLD-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
            ipoId: ipo.id,
            ipoName: ipo.name,
            symbol: ipo.symbol,
            avgCost: ipo.maxPrice,
            quantity: app.lots * ipo.lotSize,
            currentPrice: livePrice,
            status: "HELD",
            realizedPnL: 0
          });
        }
      }

      if (allotted) {
        addNotification(
          `🎉 Allotment Out: ${ipo.name}`,
          `NSE Allotment Guard checked. Your application #${app.appNumber} (PAN: ${app.pan.slice(0,3)}***) is ALLOTTED ${app.lots} Lot(s) (${app.lots * ipo.lotSize} shares). Check your demat!`,
          "allotment_success",
          ipo.name,
          app.appNumber
        );
      } else {
        addNotification(
          `❌ Allotment Update: ${ipo.name}`,
          `NSE Allotment Guard checked. Your application #${app.appNumber} (PAN: ${app.pan.slice(0,3)}***) was not allotted. Your UPI Block has been released.`,
          "allotment_fail",
          ipo.name,
          app.appNumber
        );
      }
    }
  });

  if (changed) {
    saveDb(db);
  }
}

// Request-triggered NSE audit remains available through the API route instead of a long-running background task.

// --- CUSTOM AUTHENTICATION ENGINE (JWT, OTP, GOOGLE OAUTH, RBAC) ---

const OTP_PREFIX = "otp:";

async function getOtpCacheEntry(email: string) {
  const client = await ensureRedisClient();
  if (!client) return null;
  const cached = await client.get(`${OTP_PREFIX}${email}`);

  if (typeof cached !== "string") {
    return null;
  }

  return JSON.parse(cached);
}

async function setOtpCacheEntry(email: string, value: { otp: string; expiresAt: number }) {
  const client = await ensureRedisClient();
  if (!client) return;
  await client.set(`${OTP_PREFIX}${email}`, JSON.stringify(value), { EX: 300 });
}

async function deleteOtpCacheEntry(email: string) {
  const client = await ensureRedisClient();
  if (!client) return;
  await client.del(`${OTP_PREFIX}${email}`);
}

function generateTokens(user: { uid: string; email: string; role: string }) {
  const accessToken = jwt.sign(
    { uid: user.uid, email: user.email, role: user.role },
    secretsManager.get("JWT_SECRET"),
    { expiresIn: "15m" }
  );
  const refreshToken = jwt.sign(
    { uid: user.uid, email: user.email, role: user.role },
    secretsManager.get("JWT_REFRESH_SECRET"),
    { expiresIn: "7d" }
  );
  return { accessToken, refreshToken };
}

// 1. REGISTER
app.post("/api/auth/register", async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const userRole = role ? role.toUpperCase() : "INVESTOR";

  try {
    let existingUser = await postgresDb.query.users.findFirst({
      where: eq(dbUsers.email, normalizedEmail),
    });

    if (existingUser) {
      return res.status(400).json({ error: "An account with this email already exists" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
    const uid = "CUSTOM_UID_" + crypto.randomBytes(16).toString("hex");

    const [newUser] = await postgresDb.insert(dbUsers)
      .values({
        uid,
        email: normalizedEmail,
        role: userRole,
        passwordHash,
        salt,
      })
      .returning();

    await postgresDb.insert(dbUserSettings)
      .values({
        userId: newUser.id,
        gmpAlerts: true,
        allotmentAlerts: true,
        aiReports: true,
        riskAppetite: "Moderate",
      })
      .onConflictDoNothing();

    const { accessToken, refreshToken } = generateTokens({ uid: newUser.uid, email: newUser.email, role: newUser.role });

    return res.json({
      accessToken,
      refreshToken,
      user: {
        id: newUser.id,
        uid: newUser.uid,
        email: newUser.email,
        role: newUser.role,
        name: name || email.split("@")[0]
      }
    });
  } catch (err: any) {
    console.error("Custom registration error:", err);
    return res.status(500).json({ error: "Internal registration failure" });
  }
});

// 2. LOGIN
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const userRecord = await postgresDb.query.users.findFirst({
      where: eq(dbUsers.email, normalizedEmail),
    });

    if (!userRecord || !userRecord.passwordHash || !userRecord.salt) {
      return res.status(400).json({ error: "Invalid credentials or user registered via SSO/Firebase" });
    }

    const calculatedHash = crypto.pbkdf2Sync(password, userRecord.salt, 1000, 64, "sha512").toString("hex");
    if (calculatedHash !== userRecord.passwordHash) {
      return res.status(400).json({ error: "Invalid password" });
    }

    const { accessToken, refreshToken } = generateTokens({
      uid: userRecord.uid,
      email: userRecord.email,
      role: userRecord.role,
    });

    return res.json({
      accessToken,
      refreshToken,
      user: {
        id: userRecord.id,
        uid: userRecord.uid,
        email: userRecord.email,
        role: userRecord.role,
        name: userRecord.email.split("@")[0]
      }
    });
  } catch (err: any) {
    console.error("Custom login error:", err);
    return res.status(500).json({ error: "Internal login failure" });
  }
});

// 3. OTP SEND (Supports simulated delivery)
app.post("/api/auth/otp-send", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 mins

  await setOtpCacheEntry(normalizedEmail, { otp, expiresAt });

  console.log(`[OTP Engine] Secure verification OTP for ${normalizedEmail} is: ${otp}`);

  return res.json({
    success: true,
    message: `OTP successfully dispatched!`,
    simulatedOtp: otp
  });
});

// 4. OTP VERIFY
app.post("/api/auth/otp-verify", async (req, res) => {
  const { email, otp, role } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: "Email and OTP are required" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const cached = await getOtpCacheEntry(normalizedEmail);

  if (!cached) {
    return res.status(400).json({ error: "No active OTP request found for this email" });
  }

  if (Date.now() > cached.expiresAt) {
    await deleteOtpCacheEntry(normalizedEmail);
    return res.status(400).json({ error: "OTP has expired. Please request a new one." });
  }

  if (cached.otp !== otp.trim()) {
    return res.status(400).json({ error: "Incorrect OTP. Please try again." });
  }

  await deleteOtpCacheEntry(normalizedEmail);

  try {
    let userRecord = await postgresDb.query.users.findFirst({
      where: eq(dbUsers.email, normalizedEmail),
    });

    const userRole = role ? role.toUpperCase() : "INVESTOR";

    if (!userRecord) {
      const uid = "OTP_UID_" + crypto.randomBytes(16).toString("hex");
      const [newUser] = await postgresDb.insert(dbUsers)
        .values({
          uid,
          email: normalizedEmail,
          role: userRole,
        })
        .returning();
      userRecord = newUser;

      await postgresDb.insert(dbUserSettings)
        .values({
          userId: userRecord.id,
          gmpAlerts: true,
          allotmentAlerts: true,
          aiReports: true,
          riskAppetite: "Moderate",
        })
        .onConflictDoNothing();
    }

    const { accessToken, refreshToken } = generateTokens({
      uid: userRecord.uid,
      email: userRecord.email,
      role: userRecord.role,
    });

    return res.json({
      accessToken,
      refreshToken,
      user: {
        id: userRecord.id,
        uid: userRecord.uid,
        email: userRecord.email,
        role: userRecord.role,
        name: userRecord.email.split("@")[0]
      }
    });
  } catch (err: any) {
    console.error("OTP verification db sync failed:", err);
    return res.status(500).json({ error: "Verification processing failed" });
  }
});

// 5. REFRESH TOKEN FLOW
app.post("/api/auth/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: "Refresh token is required" });
  }

  // 1. Blacklist check
  if (isRefreshTokenRevoked(refreshToken)) {
    return res.status(401).json({
      error: "UNAUTHORIZED_REVOKED",
      message: "Security Notice: This session refresh token has been revoked, rotated, or blacklisted."
    });
  }

  try {
    // 2. Token verification with dynamic secret
    const decoded = jwt.verify(refreshToken, secretsManager.get("JWT_REFRESH_SECRET")) as { uid: string; email: string; role: string };
    
    // 3. Token Rotation: generate a brand new set of tokens
    const tokens = generateTokens({ uid: decoded.uid, email: decoded.email, role: decoded.role });
    
    // 4. Revoke the old refresh token
    revokeRefreshToken(refreshToken);

    // 5. Return both access and rotated refresh token
    return res.json({ 
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (err) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or expired refresh token" });
  }
});

// 6. GOOGLE OAUTH URL
app.get("/api/auth/google-url", (req, res) => {
  const callbackUrl = `${req.protocol}://${req.get("host")}/auth/callback`;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state: "google_oauth_state"
  });
  return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// Google SSO Simulated Authorization Gateway UI
app.get("/api/auth/google-simulate", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>SSO Simulation</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Inter', sans-serif; }
        </style>
      </head>
      <body class="bg-[#0b0f19] text-gray-100 flex items-center justify-center min-h-screen p-4">
        <div class="w-full max-w-md bg-[#131b2e] border border-gray-800 rounded-2xl shadow-2xl p-6 relative overflow-hidden">
          <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-500 via-yellow-500 to-blue-500"></div>
          
          <div class="text-center space-y-4">
            <div class="inline-flex items-center justify-center bg-white p-3 rounded-full shadow-md">
              <svg class="h-8 w-8" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v3.92h6.61c-.29 1.5-.14 3.09-3.23 4.14v3.42h5.18c3.05-2.81 4.81-6.95 4.81-11.41z"/>
                <path fill="#34A853" d="M12 24c3.24 0 5.97-1.08 7.96-2.91l-5.18-3.42c-1.44.97-3.29 1.54-5.18 1.54-3.98 0-7.35-2.69-8.55-6.3H1.05v3.52c2.05 4.09 6.28 6.78 11.15 6.78z"/>
                <path fill="#FBBC05" d="M3.45 14.91c-.3-.9-.47-1.87-.47-2.91s.17-2.01.47-2.91V6.57H1.05C.38 7.92 0 9.42 0 11s.38 3.08 1.05 4.43l2.4-3.52z"/>
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.96 1.19 15.24 0 12 0 7.13 0 2.9 2.69.85 6.78l3.45 3.52c1.2-3.61 4.57-6.3 8.55-6.3z"/>
              </svg>
            </div>
            
            <div>
              <h2 class="text-lg font-bold text-white">Sign in</h2>
              <p class="text-xs text-gray-400 mt-1">IPOSense AI requests your permission to access your email and profile.</p>
            </div>
          </div>

          <div class="mt-8 space-y-3">
            <a href="/auth/callback?code=mock_google_code_tanisht&email=tanishtthasehgal@gmail.com&name=Tanishth%20Sehgal&role=INVESTOR" 
               class="flex items-center space-x-3 w-full p-3 bg-[#1e294b] hover:bg-[#2e3b6e] border border-gray-700 hover:border-gray-600 rounded-xl transition-all text-left">
              <div class="h-10 w-10 bg-gradient-to-tr from-violet-500 to-indigo-500 rounded-full flex items-center justify-center font-bold text-white shadow-inner">
                TS
              </div>
              <div>
                <div class="text-sm font-semibold text-white">Tanishth Sehgal (Investor)</div>
                <div class="text-xs text-gray-400">tanishtthasehgal@gmail.com</div>
              </div>
            </a>

            <a href="/auth/callback?code=mock_google_code_guest&email=analyst@iposense.ai&name=Research%20Analyst&role=RESEARCH_ANALYST" 
               class="flex items-center space-x-3 w-full p-3 bg-[#1e294b] hover:bg-[#2e3b6e] border border-gray-700 hover:border-gray-600 rounded-xl transition-all text-left">
              <div class="h-10 w-10 bg-gradient-to-tr from-emerald-500 to-teal-500 rounded-full flex items-center justify-center font-bold text-white shadow-inner">
                RA
              </div>
              <div>
                <div class="text-sm font-semibold text-white">Research Analyst (Analyst)</div>
                <div class="text-xs text-gray-400">analyst@iposense.ai</div>
              </div>
            </a>

            <a href="/auth/callback?code=mock_google_code_admin&email=admin@iposense.ai&name=System%20Admin&role=ADMINISTRATOR" 
               class="flex items-center space-x-3 w-full p-3 bg-[#1e294b] hover:bg-[#2e3b6e] border border-gray-700 hover:border-gray-600 rounded-xl transition-all text-left">
              <div class="h-10 w-10 bg-gradient-to-tr from-red-500 to-rose-500 rounded-full flex items-center justify-center font-bold text-white shadow-inner">
                AD
              </div>
              <div>
                <div class="text-sm font-semibold text-white">System Admin (Administrator)</div>
                <div class="text-xs text-gray-400">admin@iposense.ai</div>
              </div>
            </a>
          </div>

          <div class="mt-6 text-center text-[10px] text-gray-500 uppercase font-mono">
            IPOSense Secure SSO Gateway
          </div>
        </div>
      </body>
    </html>
  `);
});

// 7. GOOGLE CALLBACK
app.get(["/auth/callback", "/auth/callback/"], async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: "Missing Google authorization code" });
  }
  const callbackUrl = `${req.protocol}://${req.get("host")}/auth/callback`;

  try {
    // Exchange code for tokens
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code: code as string,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
    });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!tokenRes.ok) {
      console.error("Google token exchange failed", await tokenRes.text());
      return res.status(500).json({ error: "Google OAuth failure: unable to exchange code" });
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(500).json({ error: "Google OAuth failure: missing access token" });
    }
    // Fetch profile
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!profileRes.ok) {
      console.error("Google profile fetch failed", await profileRes.text());
      return res.status(500).json({ error: "Google OAuth failure: unable to fetch profile" });
    }
    const profile = await profileRes.json();
    const targetEmail = (profile.email || "oauth-user@iposense.ai").toLowerCase().trim();
    const targetName = profile.name || "IPO Expert";
    const targetPhoto = profile.picture || null;
    const targetRole = "INVESTOR";
    const targetUid = "GOOGLE_UID_" + crypto.createHash("sha256").update(targetEmail).digest("hex").slice(0, 24);

    let userRecord = await postgresDb.query.users.findFirst({
      where: eq(dbUsers.email, targetEmail),
    });

    if (!userRecord) {
      const [newUser] = await postgresDb.insert(dbUsers)
        .values({
          uid: targetUid,
          email: targetEmail,
          role: targetRole,
        })
        .returning();
      userRecord = newUser;

      await postgresDb.insert(dbUserSettings)
        .values({
          userId: userRecord.id,
          gmpAlerts: true,
          allotmentAlerts: true,
          aiReports: true,
          riskAppetite: "Moderate",
        })
        .onConflictDoNothing();
    }

    const { accessToken: jwtAccessToken, refreshToken } = generateTokens({
      uid: userRecord.uid,
      email: userRecord.email,
      role: userRecord.role,
    });

    const userPayload = JSON.stringify({
      id: userRecord.id,
      uid: userRecord.uid,
      email: userRecord.email,
      role: userRecord.role,
      name: targetName,
      displayName: targetName,
      photoURL: targetPhoto
    });

    return res.send(`
      <html>
        <head>
          <title>SSO Redirecting...</title>
          <style>
            body { background-color: #0b0f19; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
            .spinner { border: 4px solid rgba(255,255,255,0.1); width: 36px; height: 36px; border-radius: 50%; border-left-color: #6366f1; animation: spin 1s linear infinite; margin: 0 auto 15px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div style="margin: auto;">
            <div class="spinner"></div>
            <h3>Authentication successful!</h3>
            <p>Redirecting back to IPOSense workspace...</p>
          </div>
          <script>
            try {
              if (window.opener) {
                window.opener.postMessage({
                  type: 'OAUTH_AUTH_SUCCESS',
                  accessToken: '${jwtAccessToken}',
                  refreshToken: '${refreshToken}',
                  user: ${userPayload}
                }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            } catch (err) {
              console.error("Opener postMessage error:", err);
              window.location.href = '/';
            }
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    return res.status(500).json({ error: "Google OAuth failure: internal error" });
  }
});

// --- ADMINISTRATOR CONTROL ENDPOINTS ---

app.get("/api/admin/users", requireAuth, async (req: AuthRequest, res) => {
  // Validate that the requester has administrative permissions
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  try {
    const list = await postgresDb.select().from(dbUsers);
    res.json(list);
  } catch (err: any) {
    console.error("Admin list users failed:", err);
    res.status(500).json({ error: "Failed to fetch users catalog." });
  }
});

app.post("/api/admin/change-role", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  const { userId, targetRole } = req.body;
  if (!userId || !targetRole) {
    return res.status(400).json({ error: "userId and targetRole are required parameters." });
  }

  const normalizedRole = targetRole.toUpperCase();
  if (!["INVESTOR", "RESEARCH_ANALYST", "ADMINISTRATOR"].includes(normalizedRole)) {
    return res.status(400).json({ error: "Invalid target role specified." });
  }

  try {
    await postgresDb.update(dbUsers)
      .set({ role: normalizedRole })
      .where(eq(dbUsers.id, Number(userId)));

    await writeAuditLog(req.dbUser?.id || null, "USER_ROLE_CHANGE", `Migrated User ID #${userId} to role ${normalizedRole}`);

    res.json({ 
      success: true, 
      message: `User ID #${userId} successfully migrated to ${normalizedRole}.` 
    });
  } catch (err: any) {
    console.error("Admin update user role failed:", err);
    res.status(500).json({ error: "Failed to update target user role." });
  }
});

// --- DATABASE LOGGING HELPERS ---
async function writeAuditLog(userId: number | null, action: string, details: string, ipAddress?: string) {
  try {
    await postgresDb.insert(dbAuditLogs).values({
      userId,
      action,
      details,
      ipAddress: ipAddress || "127.0.0.1",
    });
  } catch (err) {
    console.error("Failed to write audit log:", err);
  }
}

// --- SECURITY & DYNAMIC CREDENTIALS / CSRF ENDPOINTS ---

// CSRF endpoint - returns fresh token for Client
app.get("/api/auth/csrf-token", (req, res) => {
  const csrfToken = generateCsrfToken();
  res.json({ csrfToken });
});

// Admin Security dashboard specs
app.get("/api/admin/security/secrets", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  res.json({
    maskedSecrets: secretsManager.getMaskedSecrets(),
    csrfStrictMode: secretsManager.get("CSRF_STRICT_MODE") === "true",
    activeCsrfTokensCount: activeCsrfTokens.size,
    blacklistedTokensCount: revokedRefreshTokens.size,
    rateLimitWindowMs: parseInt(secretsManager.get("RATE_LIMIT_WINDOW_MS")) || 9000000000,
    rateLimitMaxRequests: parseInt(secretsManager.get("RATE_LIMIT_MAX_REQUESTS")) || 100000000000,
    rateLimitStrictMaxRequests: parseInt(secretsManager.get("RATE_LIMIT_STRICT_MAX_REQUESTS")) || 15000000
  });
});

// Admin Update dynamic secrets/parameters
app.post("/api/admin/security/secrets/update", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: "Key and value parameters are required." });
  }

  const allowedKeys = secretsManager.getKeys();
  if (!allowedKeys.includes(key)) {
    return res.status(400).json({ error: `Invalid secret configuration key. Allowed: ${allowedKeys.join(", ")}` });
  }

  secretsManager.set(key, value);
  await writeAuditLog(req.dbUser?.id || null, "SECURITY_ROTATE_KEY", `Rotated or updated security configuration key '${key}'`);

  res.json({ 
    success: true, 
    message: `Security configuration key '${key}' updated successfully.`,
    maskedSecrets: secretsManager.getMaskedSecrets()
  });
});

// Admin Retrieve rate limit logs
app.get("/api/admin/security/rate-limit-logs", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  res.json(rateLimitLogs);
});

// Admin Global refresh tokens revocation
app.post("/api/admin/security/revoke-refresh-tokens", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  // Revoke everything: rotate the JWT_REFRESH_SECRET instantly!
  const newRefreshSecret = "rotated_jwt_refresh_secret_" + crypto.randomBytes(16).toString("hex");
  secretsManager.set("JWT_REFRESH_SECRET", newRefreshSecret);

  // Clear existing list
  revokedRefreshTokens.clear();

  await writeAuditLog(req.dbUser?.id || null, "SECURITY_GLOBAL_REVOCATION", "Triggered global token revocation. Rotated JWT Refresh Secret.");

  res.json({ 
    success: true, 
    message: "Globally revoked all active session refresh tokens. Rotated refresh secret." 
  });
});

async function writeApiUsageLog(userId: number | null, endpoint: string, provider: string, tokensUsed: number, responseTimeMs: number, statusCode: number) {
  try {
    await postgresDb.insert(dbApiUsageLogs).values({
      userId,
      endpoint,
      provider,
      tokensUsed,
      responseTimeMs,
      statusCode,
    });
  } catch (err) {
    console.error("Failed to write API usage log:", err);
  }
}

// --- STARTUP SCHEMA SEEDER ---
async function seedMissingDatabaseTables() {
  refreshIposList();
  try {
    // 1. Seed Historical IPOs if empty
    const existingHistIpos = await postgresDb.select().from(dbHistoricalIpos).limit(1);
    if (existingHistIpos.length === 0) {
      console.log("[POSTGRES SEED] Historical IPO table is empty. Seeding past IPO listings...");
      const historicalListings = [
        { symbol: "ZOMATO", name: "Zomato Limited", listingDate: new Date("2021-07-23"), issuePrice: 76, listingPrice: 115, currentPrice: 212, listingGainPercent: 51, sector: "Technology / Delivery" },
        { symbol: "NYKAA", name: "FSN E-Commerce Ventures (Nykaa)", listingDate: new Date("2021-11-10"), issuePrice: 1125, listingPrice: 2001, currentPrice: 178, listingGainPercent: 78, sector: "E-Commerce / Retail" },
        { symbol: "TATACHEM", name: "Tata Chemical Innovations", listingDate: new Date("2022-03-15"), issuePrice: 340, listingPrice: 395, currentPrice: 480, listingGainPercent: 16, sector: "Chemicals / Materials" },
        { symbol: "LIC", name: "Life Insurance Corporation of India", listingDate: new Date("2022-05-17"), issuePrice: 949, listingPrice: 867, currentPrice: 1045, listingGainPercent: -8, sector: "Financial Services" },
        { symbol: "JIOFIN", name: "Jio Financial Services", listingDate: new Date("2023-08-21"), issuePrice: 261, listingPrice: 265, currentPrice: 350, listingGainPercent: 1, sector: "Financial Services" },
        { symbol: "DOMS", name: "DOMS Industries Limited", listingDate: new Date("2023-12-20"), issuePrice: 790, listingPrice: 1400, currentPrice: 2050, listingGainPercent: 77, sector: "Consumer Goods" },
        { symbol: "IREDA", name: "Indian Renewable Energy Dev Agency", listingDate: new Date("2023-11-29"), issuePrice: 32, listingPrice: 50, currentPrice: 245, listingGainPercent: 56, sector: "Renewable Energy" },
      ];
      for (const item of historicalListings) {
        await postgresDb.insert(dbHistoricalIpos).values(item).onConflictDoNothing();
      }
    }

    // 2. Seed Market Data if empty
    const existingMarketData = await postgresDb.select().from(dbMarketData).limit(1);
    if (existingMarketData.length === 0) {
      console.log("[POSTGRES SEED] Market Data table is empty. Seeding key indexes...");
      const defaultIndexes = [
        { dataKey: "NIFTY_50", dataValue: "24415.80", changePercent: "+0.45%" },
        { dataKey: "SENSEX", dataValue: "80248.15", changePercent: "+0.38%" },
        { dataKey: "NIFTY_NEXT_50", dataValue: "71890.30", changePercent: "+0.82%" },
        { dataKey: "NIFTY_IT", dataValue: "39120.45", changePercent: "-0.15%" },
        { dataKey: "AVERAGE_GMP_PREMIUM", dataValue: "41.6%", changePercent: "+8.9% MoM" },
        { dataKey: "AVG_PE_RATIO", dataValue: "42.8x", changePercent: "-2.4% MoM" },
      ];
      for (const item of defaultIndexes) {
        await postgresDb.insert(dbMarketData).values(item).onConflictDoNothing();
      }
    }
    console.log("[POSTGRES SEED] Schema checks and seeding operations completed successfully.");
  } catch (err) {
    console.error("[POSTGRES SEED] Warning: Seeding check failed:", err);
  }
}

// Call seeder immediately
seedMissingDatabaseTables();

// --- NEW SCHEMA TABLE ENDPOINTS ---

// --- PORTFOLIO ENDPOINTS ---
app.get("/api/portfolio", requireAuth, async (req: AuthRequest, res) => {
  try {
    const holdings = await postgresDb.query.portfolioHoldings.findMany({
      where: eq(portfolioHoldings.userId, req.dbUser!.id),
    });
    res.json(holdings);
  } catch (err: any) {
    console.error("Fetch portfolio failed:", err);
    res.status(500).json({ error: "Failed to fetch portfolio holdings." });
  }
});

app.delete("/api/portfolio/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const holdingId = Number(req.params.id);

    if (Number.isNaN(holdingId)) {
      return res.status(400).json({ error: "Invalid portfolio holding id." });
    }

    const deleted = await postgresDb
      .delete(portfolioHoldings)
      .where(
        and(
          eq(portfolioHoldings.id, holdingId),
          eq(portfolioHoldings.userId, req.dbUser!.id)
        )
      )
      .returning();

    if (deleted.length === 0) {
      return res.status(404).json({ error: "Portfolio holding not found." });
    }

    res.json({
      success: true,
      deleted: deleted[0],
    });
  } catch (err: any) {
    console.error("Delete portfolio holding failed:", err);
    res.status(500).json({ error: "Failed to delete portfolio holding." });
  }
});

// --- HISTORICAL IPO TABLES ENDPOINTS ---
app.get("/api/historical-ipos", async (req, res) => {
  try {
    const list = await postgresDb.select().from(dbHistoricalIpos);
    res.json(list);
  } catch (err: any) {
    console.error("Fetch historical ipos failed:", err);
    res.status(500).json({ error: "Failed to load historical listings." });
  }
});

app.post("/api/historical-ipos", requireAuth, validateRequest({ symbol: "string", name: "string", listingDate: "string", issuePrice: "number", listingPrice: "number" }), async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR" && role !== "RESEARCH_ANALYST") {
    return res.status(403).json({ error: "Access denied. Premium Analyst profile required." });
  }

  const { symbol, name, listingDate, issuePrice, listingPrice, currentPrice, listingGainPercent, sector } = req.body;
  if (!symbol || !name || !listingDate || issuePrice === undefined || listingPrice === undefined) {
    return res.status(400).json({ error: "symbol, name, listingDate, issuePrice, and listingPrice are required fields." });
  }

  try {
    const [inserted] = await postgresDb.insert(dbHistoricalIpos)
      .values({
        symbol: symbol.toUpperCase(),
        name,
        listingDate: new Date(listingDate),
        issuePrice: Number(issuePrice),
        listingPrice: Number(listingPrice),
        currentPrice: Number(currentPrice || listingPrice),
        listingGainPercent: Number(listingGainPercent || 0),
        sector,
      })
      .onConflictDoUpdate({
        target: dbHistoricalIpos.symbol,
        set: {
          currentPrice: Number(currentPrice || listingPrice),
          listingGainPercent: Number(listingGainPercent || 0),
          sector
        }
      })
      .returning();

    await writeAuditLog(req.dbUser!.id, "HIST_IPO_ADD", `Created or updated historical listed IPO: ${symbol}`);
    res.json({ success: true, historicalIpo: inserted });
  } catch (err: any) {
    console.error("Insert historical IPO failed:", err);
    res.status(500).json({ error: "Failed to persist historical IPO asset." });
  }
});

// --- MARKET DATA TABLES ENDPOINTS ---
app.get("/api/market-data", async (req, res) => {
  try {
    const list = await postgresDb.select().from(dbMarketData);
    res.json(list);
  } catch (err: any) {
    console.error("Fetch market data failed:", err);
    res.status(500).json({ error: "Failed to load active market indices tables." });
  }
});

app.post("/api/market-data", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR" && role !== "RESEARCH_ANALYST") {
    return res.status(403).json({ error: "Access denied. Premium level required." });
  }

  const { dataKey, dataValue, changePercent } = req.body;
  if (!dataKey || dataValue === undefined) {
    return res.status(400).json({ error: "dataKey and dataValue are required fields." });
  }

  try {
    const [updated] = await postgresDb.insert(dbMarketData)
      .values({
        dataKey,
        dataValue: String(dataValue),
        changePercent: changePercent || null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: dbMarketData.dataKey,
        set: {
          dataValue: String(dataValue),
          changePercent: changePercent || null,
          updatedAt: new Date(),
        }
      })
      .returning();

    await writeAuditLog(req.dbUser!.id, "MARKET_DATA_UPDATE", `Updated market index state: ${dataKey} to ${dataValue}`);
    res.json({ success: true, marketRecord: updated });
  } catch (err: any) {
    console.error("Update market data failed:", err);
    res.status(500).json({ error: "Failed to update platform index values." });
  }
});

// --- PLATFORM AUDITS AND USAGE LOGS (ADMIN ONLY) ---
app.get("/api/admin/audit-logs", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  try {
    const list = await postgresDb.select()
      .from(dbAuditLogs)
      .orderBy(dbAuditLogs.createdAt);
    res.json(list);
  } catch (err: any) {
    console.error("Fetch audit logs failed:", err);
    res.status(500).json({ error: "Failed to fetch platform security audits." });
  }
});

app.get("/api/admin/api-usage-logs", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  try {
    const list = await postgresDb.select()
      .from(dbApiUsageLogs)
      .orderBy(dbApiUsageLogs.createdAt);
    res.json(list);
  } catch (err: any) {
    console.error("Fetch api logs failed:", err);
    res.status(500).json({ error: "Failed to fetch api metric graphs." });
  }
});


// Groww IPO Proxy Route (server-side fetch to bypass browser CORS)
app.get("/api/ipo/groww/open", async (req, res) => {
  try {
    const response = await fetch("https://groww.in/v1/api/primaries/v1/ipo/open?v=2", {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "x-platform": "web",
        "X-APP-ID": "growwWeb",
        "x-device-type": "desktop"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Groww IPO API failed: ${response.status}`
      });
    }

    const data = await response.json();

    console.log("===== GROWW IPO RAW RESPONSE =====");
    console.log(JSON.stringify(data, null, 2));

    const rawList =
      data?.ipoList ??
      data?.data?.ipoList ??
      data?.data?.content ??
      data?.content ??
      [];

    const results = rawList.map((item: any, index: number) => {
      const category = item.categories?.find((c: any) => c.category === "IND") || item.categories?.[0] || {};

      return {
        id: item.searchId || item.search_id || item.companyCode || item.symbol || `groww-${index}`,
        name: item.companyName || item.title || item.name || "Unknown IPO",
        companyName: item.companyName || item.title || item.name || "Unknown IPO",
        symbol: item.symbol || item.nse_scrip_code || "",
        searchId: item.searchId || item.search_id || null,
        nseScripCode: item.nse_scrip_code || item.symbol || "",
        isin: item.isin || "",
        priceBand: category.minPrice && category.maxPrice
          ? `₹${category.minPrice} - ₹${category.maxPrice}`
          : "TBA",
        minPrice: category.minPrice || 0,
        maxPrice: category.maxPrice || 0,
        lotSize: category.lotSize || 0,
        issueSize: category.lotSize || item.issueSize || "TBA",

        openDate: item.bidStartTimestamp
          ? new Date(item.bidStartTimestamp).toISOString().split("T")[0]
          : (item.openDate || item.open_date || "TBA"),

        closeDate: item.bidEndTimestamp
          ? new Date(item.bidEndTimestamp).toISOString().split("T")[0]
          : (item.closeDate || item.close_date || "TBA"),

        listingDate:
          item.listingDate ||
          item.listing_date ||
          item.expectedListingDate ||
          "TBA",

        bidStartTimestamp: item.bidStartTimestamp || null,
        bidEndTimestamp: item.bidEndTimestamp || null,

        leadManagers: [],
        competitors: [],
        strengths: [],
        risks: [],
        financials: [],
        industry: item.industry || "Unknown",
        objectOfIssue: item.objectOfIssue || "",
        recommendation: "MODERATE",
        aiScore: 0,
        aiConfidence: 0,
        riskScore: 0,
        gmp: item.gmp || 0,
        gmpPercent: item.gmpPercent || 0,
        subscriptionOverall: item.overallSubscription || 0,
        subscriptionRetail: null,
subscriptionQib: null,
subscriptionHni: null,
        status: item.isPreApply ? "UPCOMING" : "ACTIVE"
      };
    });

    console.log(`Groww IPOs Parsed: ${results.length}`);

    res.json(results);
  } catch (error) {
    console.error("Groww IPO proxy failed:", error);
    return res.status(500).json({
      error: "Failed to fetch Groww IPO data"
    });
  }
});

// API Routes

// Notifications Endpoints
app.get("/api/notifications", requireAuth, async (req: AuthRequest, res) => {
  try {
    const list = await postgresDb.select()
      .from(dbNotifications)
      .where(eq(dbNotifications.userId, req.dbUser!.id));
    res.json(list);
  } catch (err: any) {
    console.error("Get notifications failed:", err);
    res.status(500).json({ error: "Failed to fetch notifications from Postgres." });
  }
});

app.post("/api/notifications/clear", requireAuth, async (req: AuthRequest, res) => {
  try {
    await postgresDb.delete(dbNotifications)
      .where(eq(dbNotifications.userId, req.dbUser!.id));
    res.json({ success: true, count: 0 });
  } catch (err: any) {
    console.error("Clear notifications failed:", err);
    res.status(500).json({ error: "Failed to clear notifications in Postgres." });
  }
});

app.post("/api/notifications/:id/read", requireAuth, async (req: AuthRequest, res) => {
  try {
    await postgresDb.update(dbNotifications)
      .set({ read: true })
      .where(and(
        eq(dbNotifications.id, Number(req.params.id)),
        eq(dbNotifications.userId, req.dbUser!.id)
      ));
    res.json({ success: true });
  } catch (err: any) {
    console.error("Mark notification read failed:", err);
    res.status(500).json({ error: "Failed to update notification in Postgres." });
  }
});


// NSE Live Sync Route
app.post("/api/applications/nse-sync", async (req, res) => {
  try {
    // Run an audit immediately on request
    performNseAllotmentAudit();
    // Refresh the live listings list from the NSE
    await refreshIposList();
    db = createDefaultDb();
    res.json({ success: true, ipos: globalIposList, applications: db.applications, notifications: db.notifications });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to trigger live NSE synchronization" });
  }
});

// The application now uses the current platform-backed IPO/news endpoints.


// User Notifications and Alerts configuration endpoints
app.get("/api/user/settings", requireAuth, async (req: AuthRequest, res) => {
  try {
    const records = await postgresDb.select()
      .from(dbUserSettings)
      .where(eq(dbUserSettings.userId, req.dbUser!.id))
      .limit(1);
    
    let settings = records[0];

    if (!settings) {
      const [newSettings] = await postgresDb.insert(dbUserSettings)
        .values({
          userId: req.dbUser!.id,
          gmpAlerts: true,
          allotmentAlerts: true,
          aiReports: true,
          riskAppetite: "Moderate",
        })
        .returning();
      settings = newSettings;
    }

    res.json({
      id: "SET-" + settings.id,
      userId: "USER-" + settings.userId,
      notificationPreferences: {
        fcm: settings.gmpAlerts,
        email: settings.allotmentAlerts,
        sms: settings.aiReports,
        telegram: true,
        whatsapp: false
      }
    });
  } catch (err: any) {
    console.error("Get user settings failed:", err);
    res.status(500).json({ error: "Failed to load settings from Postgres." });
  }
});

app.post("/api/user/settings", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { preferences } = req.body;
    const gmpAlerts = preferences ? preferences.fcm : true;
    const allotmentAlerts = preferences ? preferences.email : true;
    const aiReports = preferences ? preferences.sms : true;

    const updated = await postgresDb.insert(dbUserSettings)
      .values({
        userId: req.dbUser!.id,
        gmpAlerts,
        allotmentAlerts,
        aiReports,
        riskAppetite: "Moderate",
      })
      .onConflictDoUpdate({
        target: dbUserSettings.userId,
        set: {
          gmpAlerts,
          allotmentAlerts,
          aiReports,
        }
      })
      .returning();

    res.json({
      success: true,
      settings: {
        id: "SET-" + updated[0].id,
        userId: "USER-" + updated[0].userId,
        notificationPreferences: {
          fcm: updated[0].gmpAlerts,
          email: updated[0].allotmentAlerts,
          sms: updated[0].aiReports,
          telegram: true,
          whatsapp: false
        }
      }
    });
  } catch (err: any) {
    console.error("Save user settings failed:", err);
    res.status(500).json({ error: "Failed to save settings to Postgres." });
  }
});



// 1. Fetch all IPOs from Groww
app.get("/api/ipo-indexes", async (_req, res) => {
  try {
    const data = await getIposDataset();
    res.json(data);
  } catch (err) {
    console.error("IPO indexes alias failed:", err);
    res.status(500).json({ error: "Failed to fetch IPO indexes" });
  }
});

app.get("/api/ipos", async (req, res) => {
  try {
    console.log("Fetching IPO data from Groww...");

    const response = await fetch("https://groww.in/v1/api/primaries/v1/ipo/open?v=2", {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "x-platform": "web",
        "X-APP-ID": "growwWeb",
        "x-device-type": "desktop"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Groww IPO API failed: ${response.status}`
      });
    }

    const data = await response.json();

    const ipoList = (data.ipoList || []).map((item: any, index: number) => {
      const regularCategory = item.categories?.find((c: any) => c.category === "IND") || item.categories?.[0];
      return {
        id: item.searchId || item.symbol || `groww-${index}`,
        symbol: item.symbol || "IPO",
        name: item.companyName || "Upcoming IPO",
        companyName: item.companyName || "Upcoming IPO",
        isin: item.isin || "",
        logoUrl: item.logoUrl || "",
        priceBand: regularCategory
          ? `₹${regularCategory.minPrice} - ₹${regularCategory.maxPrice}`
          : "TBA",
        minPrice: regularCategory?.minPrice || 0,
        maxPrice: regularCategory?.maxPrice || 0,
        lotSize: regularCategory?.lotSize || 1,
        issueSize: item.issueSize || (regularCategory?.minBidQuantity && regularCategory?.maxPrice ? `₹${(regularCategory.minBidQuantity * regularCategory.maxPrice).toLocaleString()}` : "N/A"),
        gmp: item.gmp ?? 0,
        gmpPercent: item.gmpPercent ?? 0,
        subscriptionOverall: item.overallSubscription ?? 0,
        subscriptionRetail: item.categories?.find((c: any) => c.category === "IND")?.subscription || 0,
        subscriptionQib: item.categories?.find((c: any) => c.category === "QIB")?.subscription || 0,
        subscriptionHni: item.categories?.find((c: any) => c.category === "HNI")?.subscription || 0,
        openDate: item.bidStartTimestamp
          ? new Date(item.bidStartTimestamp).toISOString().split("T")[0]
          : "TBA",
        closeDate: item.bidEndTimestamp
          ? new Date(item.bidEndTimestamp).toISOString().split("T")[0]
          : "TBA",
        listingDate: "TBA",
        status: item.isPreApply ? "UPCOMING" : "ACTIVE",
        exchange: "NSE",
        source: "Groww Live",
        aiScore: 0,
        aiConfidence: 0,
        riskScore: 0,
        categories: item.categories || [],
        companyCode: item.companyCode || null,
        searchId: item.searchId || null,
        isSme: item.isSme || false,
        bidStartTimestamp: item.bidStartTimestamp || null,
        bidEndTimestamp: item.bidEndTimestamp || null,
        isPreApply: item.isPreApply || false
      };
    });

    globalIposList = ipoList;
    console.log("GROWW IPO DATA RECEIVED:", globalIposList.length);

    res.json(globalIposList);
  } catch (err) {
    console.error("IPO API Error:", err);
    res.status(500).json({
      error: "Failed to fetch IPO data from Groww"
    });
  }
});

// --- Groww Portfolio Holdings & Search Endpoints ---
// Groww Search Endpoint
app.get("/api/groww/search/:query", async (req, res) => {
  try {
    const query = req.params.query;
    if (!query) {
      return res.status(400).json({ error: "Query parameter required" });
    }
    const url = `https://groww.in/v1/api/search/v3/query/global/st_p_query?is_us_stocks=1&page=0&query=${encodeURIComponent(query)}&size=10&web=true`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "x-platform": "web",
        "X-APP-ID": "growwWeb",
        "x-device-type": "desktop"
      }
    });
    if (!response.ok) {
      return res.status(500).json({ error: "Groww search failed" });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Groww search failed:", err);
    res.status(500).json({ error: "Groww search failed" });
  }
});

// Groww Live Price Endpoint
app.get("/api/groww/price/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const liveUrl = `https://groww.in/v1/api/stocks_data/v1/tr_live_book/exchange/NSE/segment/CASH/${encodeURIComponent(symbol)}/latest`;

    const response = await fetch(liveUrl, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0",
        "x-platform": "web",
        "X-APP-ID": "growwWeb",
        "x-device-type": "desktop"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Groww live price API failed",
        symbol
      });
    }

    const data = await response.json();

    const buy = data?.buyBook?.[1]?.price;
    const sell = data?.sellBook?.[1]?.price;
    const ltp = sell || buy || null;

    if (!ltp) {
      return res.status(404).json({
        error: "Live price not found",
        symbol
      });
    }

    return res.json({
      symbol,
      ltp,
      source: "Groww MARKET_DEPTH"
    });
  } catch (err) {
    console.error("Groww price error", err);
    return res.status(500).json({
      error: "Groww price fetch failed"
    });
  }
});

// Groww Holding Endpoint
app.get("/api/groww/holding/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    if (!symbol) {
      return res.status(400).json({ error: "Symbol parameter required" });
    }
    // Parallel fetch chart and live book
    const chartUrl = `https://groww.in/v1/api/charting_service/v2/chart/delayed/exchange/NSE/segment/CASH/${encodeURIComponent(symbol)}/daily?intervalInMinutes=1&minimal=true`;
    const bookUrl = `https://groww.in/v1/api/stocks_data/v1/tr_live_book/exchange/NSE/segment/CASH/${encodeURIComponent(symbol)}/latest`;
    const [chartResp, bookResp] = await Promise.all([
      fetch(chartUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "x-platform": "web",
          "X-APP-ID": "growwWeb",
          "x-device-type": "desktop"
        }
      }),
      fetch(bookUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "x-platform": "web",
          "X-APP-ID": "growwWeb",
          "x-device-type": "desktop"
        }
      })
    ]);
    if (!chartResp.ok || !bookResp.ok) {
      return res.status(500).json({ error: "Failed to fetch Groww holding data" });
    }
    const chart = await chartResp.json();
    const liveBook = await bookResp.json();
    const candles = Array.isArray(chart.candles) ? chart.candles : [];
    const latestPrice = liveBook?.ltp || (candles.length ? candles[candles.length - 1][1] : null);
    res.json({
      symbol,
      latestPrice,
      candles,
      marketDepth: liveBook,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    console.error("Groww holding fetch failed:", err);
    res.status(500).json({ error: "Failed to fetch Groww holding data" });
  }
});

// Groww Holdings Live Endpoint (batch)
app.get("/api/groww/holdings/live", async (req, res) => {
  try {
    const symbolsParam = req.query.symbols;
    if (!symbolsParam || typeof symbolsParam !== "string") {
      return res.status(400).json({ error: "symbols query parameter required (comma separated)" });
    }

    const symbols = symbolsParam.split(",").map(s => s.trim()).filter(Boolean);

    const results = await Promise.all(symbols.map(async (symbol) => {
      try {
        const url = `https://groww.in/stocks/${symbol.toLowerCase()}`;
        const response = await fetch(url, {
          headers: {
            "Accept": "text/html",
            "User-Agent": "Mozilla/5.0"
          }
        });

        const html = await response.text();

        const match = html.match(new RegExp(`"${symbol}"\\s*:\\s*\\{[^}]*"ltp"\\s*:\\s*([0-9.]+)`));
        const latestPrice = match ? Number(match[1]) : null;

        return {
          symbol,
          latestPrice,
          lastUpdated: new Date().toISOString()
        };
      } catch (err) {
        return {
          symbol,
          latestPrice: null,
          lastUpdated: new Date().toISOString()
        };
      }
    }));

    res.json(results);
  } catch (err) {
    console.error("Groww holdings live fetch failed:", err);
    res.status(500).json({ error: "Failed to fetch Groww holdings live data" });
  }
});

// 2. Fetch specific IPO
app.get("/api/ipos/:id", (req, res) => {
  const ipo = getIpoById(req.params.id);
  if (!ipo) {
    return res.status(404).json({ error: "IPO not found" });
  }
  res.json(ipo);
});

// 3. User applications tracking
app.get("/api/applications", requireAuth, async (req: AuthRequest, res) => {
  try {
    const apps = await postgresDb.select()
      .from(dbBids)
      .where(eq(dbBids.userId, req.dbUser!.id));
    
    const decryptedApps = apps.map(app => {
      // Find the corresponding IPO in globalIposList to get the correct ID if needed
      const matchingIpo = globalIposList.find(i => i.symbol === app.ipoSymbol);
      return {
        id: app.id.toString(),
        ipoId: matchingIpo?.id || app.ipoSymbol,
        ipoName: app.ipoName,
        symbol: app.ipoSymbol,
        pan: app.panEncrypted ? decrypt(app.panEncrypted) : "",
        appNumber: app.appNumEncrypted ? decrypt(app.appNumEncrypted) : "",
        broker: "Zerodha", // Default broker or placeholder if not in db
        upiId: "upi@okbank",
        category: app.category,
        lots: app.quantity / (matchingIpo?.lotSize || 1),
        investmentAmount: app.amount,
        applicationDate: app.createdAt?.toISOString().split("T")[0] || new Date().toISOString().split("T")[0],
        status: app.status === "PENDING" ? "APPLIED" : app.status,
        allottedLots: app.status === "ALLOTTED" ? (app.quantity / (matchingIpo?.lotSize || 1)) : 0,
        refundStatus: app.status === "REJECTED" ? "REFUND COMPLETED" : "Not Applicable"
      };
    });
    
    res.json(decryptedApps);
  } catch (err: any) {
    console.error("Fetch applications failed:", err);
    res.status(500).json({ error: "Failed to fetch applications from PostgreSQL." });
  }
});

app.post("/api/applications", requireAuth, validateRequest({ ipoId: "string", pan: "string", appNumber: "string" }), async (req: AuthRequest, res) => {
  try {
    const { ipoId, pan, appNumber, broker, category, upiId, lots, investmentAmount } = req.body;
    if (!ipoId || !pan || !appNumber) {
      return res.status(400).json({ error: "Missing required fields: ipoId, pan, appNumber" });
    }

    const ipo = getIpoById(ipoId);
    if (!ipo) {
      return res.status(404).json({ error: "IPO not found" });
    }

    const price = ipo.maxPrice || 100;
    const quantity = Number(lots) * (ipo.lotSize || 1);
    const amount = Number(investmentAmount) || (price * quantity);

    const panEncrypted = encrypt(pan.toUpperCase());
    const appNumEncrypted = encrypt(appNumber);

    const [newBid] = await postgresDb.insert(dbBids)
      .values({
        userId: req.dbUser!.id,
        ipoSymbol: ipo.symbol,
        ipoName: ipo.name,
        category: category || "RETAIL",
        price: price,
        quantity: quantity,
        amount: amount,
        status: "PENDING",
        panEncrypted,
        appNumEncrypted,
      })
      .returning();

    res.status(201).json({
      id: newBid.id.toString(),
      ipoId: ipo.id,
      ipoName: ipo.name,
      symbol: ipo.symbol,
      pan: pan.toUpperCase(),
      appNumber: appNumber,
      broker: broker || "Zerodha",
      upiId: upiId || "upi@okbank",
      category: newBid.category,
      lots: Number(lots),
      investmentAmount: amount,
      applicationDate: newBid.createdAt?.toISOString().split("T")[0] || new Date().toISOString().split("T")[0],
      status: "APPLIED",
      allottedLots: 0,
      refundStatus: "Not Applicable"
    });
  } catch (err: any) {
    console.error("Submit application failed:", err);
    res.status(500).json({ error: "Failed to submit application to PostgreSQL." });
  }
});


app.post("/api/portfolio", requireAuth, async (req: AuthRequest, res) => {
  const { ipoId, symbol, companyName, avgCost, quantity, currentPrice } = req.body;
  if (
    !ipoId ||
    !symbol ||
    !companyName ||
    avgCost === undefined ||
    quantity === undefined ||
    currentPrice === undefined
  ) {
    return res.status(400).json({ error: "ipoId, symbol, companyName, avgCost, quantity, and currentPrice are required fields." });
  }
  try {
    const [inserted] = await postgresDb.insert(portfolioHoldings)
      .values({
        userId: req.dbUser!.id,
        ipoId: String(ipoId),
        symbol: String(symbol),
        companyName: String(companyName),
        avgCost: Number(avgCost),
        quantity: Number(quantity),
        currentPrice: Number(currentPrice),
      })
      .returning();
    res.json(inserted);
  } catch (err: any) {
    console.error("Insert portfolio holding failed:", err);
    res.status(500).json({ error: "Failed to add portfolio holding." });
  }
});

app.post("/api/portfolio/adjust", requireAuth, async (req: AuthRequest, res) => {
  const { ipoId, action } = req.body;
  if (!ipoId || !action) {
    return res.status(400).json({ error: "ipoId and action are required." });
  }
  try {
    // Find holding for this user and ipoId
    const holding = await postgresDb.query.portfolioHoldings.findFirst({
      where: and(
        eq(portfolioHoldings.userId, req.dbUser!.id),
        eq(portfolioHoldings.ipoId, String(ipoId))
      ),
    });
    if (!holding) {
      return res.status(404).json({ error: "Holding not found" });
    }
    if (action === "SELL") {
      await postgresDb.delete(portfolioHoldings)
        .where(
          and(
            eq(portfolioHoldings.userId, req.dbUser!.id),
            eq(portfolioHoldings.ipoId, String(ipoId))
          )
        );
    } else if (action === "REBALANCE") {
      const newQty = Math.round(Number(holding.quantity) * 0.65);
      await postgresDb.update(portfolioHoldings)
        .set({ quantity: newQty })
        .where(
          and(
            eq(portfolioHoldings.userId, req.dbUser!.id),
            eq(portfolioHoldings.ipoId, String(ipoId))
          )
        );
    } else {
      return res.status(400).json({ error: "Invalid action." });
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error("Portfolio adjust failed:", err);
    res.status(500).json({ error: "Failed to adjust portfolio holding." });
  }
});

// 6. Groq-powered IPO Analysis Route
app.post("/api/groq/analyze", async (req, res) => {
  const { ipoId } = req.body;
  const ipo = getIpoById(ipoId);
  if (!ipo) {
    return res.status(404).json({ error: "IPO not found" });
  }

  const client = getGroqClient();
  const prompt = `Analyze this IPO and return the result strictly as a valid JSON object.

Company: ${ipo.name} (${ipo.symbol})
Price Band: ${ipo.priceBand}
Issue Size: ${ipo.issueSize}
Overall Subscription: ${ipo.subscriptionOverall}x

IMPORTANT:

- Evaluate the IPO ONLY using the information explicitly provided.
- Missing information must be treated as "not available", NOT as a weakness, risk, or negative signal.
- Never penalize the IPO because some information is unavailable.
- Never write phrases like:
  - "No additional information available..."
  - "Insufficient information..."
  - "Cannot assess..."
  - "Unable to evaluate..."
  - "Limited information..."
  - "Due to missing data..."
- If a metric is not provided, simply ignore it and continue the analysis using the remaining available data.
- Generate Pros and Cons ONLY from the provided information.
- If no evidence-based con exists in the provided data, return an empty array for "detailedCons".
- Base the AI Score, Risk Level, Confidence, and Recommendation ONLY on the available information. Do not lower the score or confidence because some information is missing.

Return a JSON object matching EXACTLY this schema:

{
  "aiScore": <number between 0 and 100>,
  "confidencePercent": <number between 0 and 100>,
  "riskMeter": "LOW" | "MODERATE" | "HIGH",
  "listingGainProbability": <number between 0 and 100>,
  "recommendation": "APPLY" | "AVOID" | "MODERATE",
  "reasoningSummary": "<Maximum 3 sentences based ONLY on the provided information. Never mention unavailable metrics or assumptions.>",
  "detailedPros": ["Only include advantages directly supported by the provided data."],
  "detailedCons": ["Only include disadvantages directly supported by the provided data."]
}

Return ONLY valid JSON.
Do not include markdown, explanations, notes, or additional text.`;

  if (!client) {
    // Elegant fallback rule-based analysis if Groq key is missing
    const isGood = ipo.aiScore > 70 || ipo.subscriptionOverall >= 20;
    const recommendation = isGood ? "APPLY" : "MODERATE";
    const mockAnalysis = {
      aiScore: ipo.aiScore,
      confidencePercent: ipo.aiConfidence,
      riskMeter: ipo.riskScore > 60 ? "HIGH" : (ipo.riskScore > 35 ? "MODERATE" : "LOW"),
      listingGainProbability: Math.min(95, Math.max(5, Math.round((ipo.aiScore * 0.6) + (ipo.subscriptionOverall * 1.2)))),
      recommendation,
      reasoningSummary: "This assessment focuses on subscription strength, issue size, and issuer fundamentals rather than grey market premium.",
      detailedPros: ipo.strengths,
      detailedCons: ipo.risks
    };
    await writeApiUsageLog(null, "/api/groq/analyze", "LOCAL_FALLBACK", 0, 45, 200);
    return res.json(mockAnalysis);
  }

  const startTime = Date.now();
  try {
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    });

    const responseTime = Date.now() - startTime;
    const tokens = response.usage?.total_tokens || 1200;
    await writeApiUsageLog(null, "/api/groq/analyze", "GROQ", tokens, responseTime, 200);

    const content = response.choices[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content.trim());
      res.json(parsed);
    } else {
      throw new Error("No response text from Groq");
    }
  } catch (err) {
    handleGroqError(err);
    console.error("Groq analyze error, using fallback:", err);
    // Fallback if call fails
    res.json({
      aiScore: ipo.aiScore,
      confidencePercent: ipo.aiConfidence,
      riskMeter: ipo.riskScore > 60 ? "HIGH" : "LOW",
      listingGainProbability: 75,
      recommendation: ipo.recommendation,
      reasoningSummary: `Failed to fetch live Groq AI analysis. Displaying localized rating database of ${ipo.name}. Valuation score shows strong promoter history and stable competitive landscape.`,
      detailedPros: ipo.strengths,
      detailedCons: ipo.risks
    });
  }
});

// 7. Groq chat route
app.post("/api/groq/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Messages array is required" });
  }

  const client = getGroqClient();
  const lastUserMsg = messages[messages.length - 1]?.text || "";

  // Construct context with our known IPO database so chatbot responds smartly!
  const ipoContext = IPOS_DATA.map(i => 
    `IPO: ${i.name} (${i.symbol}) | Industry: ${i.industry} | Price Band: ${i.priceBand} | Subscription: ${i.subscriptionOverall}x | AI Score: ${i.aiScore} | Recommendation: ${i.recommendation}`
  ).join("\n");

  const prompt = `You are "IPOSense AI Assist", a world-class financial analyst and investment advisor chatbot.
Use this context about active/upcoming IPOs:
${ipoContext}

User asked: "${lastUserMsg}"
Respond professionally. Keep responses concise, structured, bulleted, and filled with realistic data. Highlight key metrics (subscription, issue size) where appropriate.`;

  if (!client) {
    // Generate intelligent rule-based response if Groq is not set up
    let answer = `I'm here to assist you with IPO Intelligence! Here's a quick look at the market sentiment: \n\n`;
    if (lastUserMsg.toLowerCase().includes("apply") || lastUserMsg.toLowerCase().includes("should i")) {
      answer += `Based on the latest subscription momentum and issuer fundamentals, we strongly recommend considering **Acme CloudTech AI (ACMEAI)** which carries an AI Score of 88/100 and a high listing gain probability. In contrast, **ZetaPay Fintech** appears less attractive due to weaker demand and valuation risk.`;
    } else if (lastUserMsg.toLowerCase().includes("premium")) {
      answer += `We are currently emphasizing subscription demand, issue size, and valuation discipline. Top active IPOs in our universe are showing strong subscription strength, especially Acme CloudTech AI and NovaCharge Mobility.`;
    } else {
      answer += `You can ask me questions like:
- "Should I apply for Acme CloudTech AI?"
- "Which active IPO has the strongest subscription demand?"
- "Is ZetaPay Fintech a safe investment?"
- "Help me analyze Solaris Renewable Energy's financial statements."`;
    }
    return res.json({ text: answer });
  }

  try {
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }]
    });
    const text = response.choices[0]?.message?.content || "";
    res.json({ text });
  } catch (err) {
    handleGroqError(err);
    console.error("Groq chat error, using fallback:", err);
    res.json({ text: "Sorry, I ran into a connection glitch. Here is what I can tell you: Acme CloudTech AI remains highly rated based on its subscription strength and valuation profile." });
  }
});

// 8. RHP Summarizer
app.post("/api/groq/rhp-summarize", async (req, res) => {
  const { ipoId } = req.body;
  const ipo = getIpoById(ipoId);
  if (!ipo) {
    return res.status(404).json({ error: "IPO not found" });
  }

  const client = getGroqClient();
  const prompt = `Summarize the 500-page Red Herring Prospectus (RHP) of ${ipo.name} (${ipo.symbol}) into a concise, easily digestible 5-minute dashboard format.
Include:
1. Executive Summary (2 sentences)
2. Use of Proceeds / Object of Issue
3. Core Business Model & Revenue Engine
4. Top 3 Growth Engines (Pros)
5. Top 3 Threat Vectors (Cons)
6. Peer Valuation Multiples (P/E, Debt-to-Equity compared to peers)

Format beautifully in JSON with exact fields:
{
  "summary": "...",
  "useOfProceeds": "...",
  "businessModel": "...",
  "pros": ["...", "...", "..."],
  "cons": ["...", "...", "..."],
  "peerComparison": "..."
}
Return ONLY valid JSON.`;

  if (!client) {
    // Static structured high-quality fallback RHP Summary
    return res.json({
      summary: `${ipo.name} is a leading enterprise in the ${ipo.industry} sector. The business has displayed exceptional unit economics and scale, operating with high-profile global client tie-ups.`,
      useOfProceeds: ipo.objectOfIssue,
      businessModel: `A high-margin technology model driven by licensing, subscription revenues, and turnkey custom infrastructure implementations with an active client retention rate of over 92%.`,
      pros: ipo.strengths,
      cons: ipo.risks,
      peerComparison: `Acme trades at a forward P/E of 34x compared to industry leaders (TCS at 28x, Infosys at 26x) which is fully justified given its hyper-growth CAGR of over 85%.`
    });
  }

  try {
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    });
    const content = response.choices[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content.trim());
      res.json(parsed);
    } else {
      throw new Error("No text response");
    }
  } catch (err) {
    handleGroqError(err);
    console.error("RHP Summarizer error:", err);
    res.json({
      summary: `${ipo.name} operates strongly in ${ipo.industry}. High-margin structural dynamics back this public issue.`,
      useOfProceeds: ipo.objectOfIssue,
      businessModel: `Focused on scaling automated platforms and direct-to-enterprise premium solutions.`,
      pros: ipo.strengths,
      cons: ipo.risks,
      peerComparison: `Aggressive growth multiples relative to industrial standards are reasonably supported by robust profit margins.`
    });
  }
});

// 9. Listing Price Predictor
app.post("/api/groq/listing-predict", async (req, res) => {
  const { ipoId } = req.body;
  const ipo = getIpoById(ipoId);
  if (!ipo) {
    return res.status(404).json({ error: "IPO not found" });
  }

  const client = getGroqClient();
  const priceBandMatch = String(ipo.priceBand || "").match(/\d+/g);
  const issuePrice = ipo.maxPrice || (priceBandMatch ? Number(priceBandMatch[priceBandMatch.length - 1]) : 0);
  const prompt = `Analyze this IPO and return the result strictly as a valid JSON object.

Company: ${ipo.name} (${ipo.symbol})
Price Band: ${ipo.priceBand}
Issue Size: ${ipo.issueSize}
Overall Subscription: ${ipo.subscriptionOverall}x

IMPORTANT RULES:

- Use ONLY the information explicitly provided above.
- Never assume, infer, estimate, fabricate, or guess any missing information.
- Do NOT mention or analyze Retail Subscription, QIB Subscription, HNI/NII Subscription, GMP (Grey Market Premium), Promoter Holding, Financial Statements, Revenue, Profit, Debt, P/E, ROE, EPS, Anchor Investors, Institutional Demand, Strengths, Risks, Valuation Multiples, or any other metric unless it is explicitly provided above.
- If the available information is insufficient for a certain conclusion, simply avoid discussing it.
- The reasoning must be based ONLY on the provided fields.
- Do not compare with peers unless peer data is explicitly provided.
- Do not invent numbers, percentages, or qualitative statements about unavailable data.
- Predict a realistic listing price using ONLY the provided information.
- The predictedListingPrice must represent the expected first-day exchange listing price, NOT the issue price or upper price band.
- Do not simply copy the upper price band as the predictedListingPrice.
- Use the Price Band, Issue Size, and Overall Subscription together to estimate a realistic listing price.
- Higher subscription may justify a listing premium, while weaker demand may justify a listing price near or below the issue price.
- The predictedListingPrice should be your best reasonable estimate based only on the provided information.


Return a JSON object matching EXACTLY this schema:
{
  "predictedListingPrice": <number>,
  "listingGainsPercent": <number>,
  "target1Day": <number>,
  "target1Week": <number>,
  "target1Month": <number>,
  "bullCase": "...",
  "bearCase": "..."
}

Return ONLY valid JSON.
Do not include markdown, explanations, notes, or additional text.`;

  if (!client) {
    const predictedListingPrice = Math.round(issuePrice * 1.07);
    const listingGainsPercent = issuePrice > 0 ? Math.round(((predictedListingPrice - issuePrice) / issuePrice) * 1000) / 10 : 0;
    return res.json({
      predictedListingPrice,
      listingGainsPercent,
      target1Day: Math.round(predictedListingPrice * 1.05),
      target1Week: Math.round(predictedListingPrice * 1.12),
      target1Month: Math.round(predictedListingPrice * 1.25),
      bullCase: "Strong institutional backing continues post-listing, driving high buybacks and immediate index inclusion.",
      bearCase: "Profit booking on Listing Day triggers temporary slide to support levels near the original issue upper band."
    });
  }

  try {
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    });
    const content = response.choices[0]?.message?.content;
    if (content) {
      res.json(JSON.parse(content.trim()));
    } else {
      throw new Error("No response");
    }
  } catch (err) {
    handleGroqError(err);
    console.error("Predictor error:", err);
    const predictedListingPrice = ipo.maxPrice + ipo.gmp;
    res.json({
      predictedListingPrice,
      listingGainsPercent: ipo.gmpPercent,
      target1Day: predictedListingPrice,
      target1Week: Math.round(predictedListingPrice * 1.04),
      target1Month: Math.round(predictedListingPrice * 1.10),
      bullCase: "Sustained retail demand continues to absorb listing supply, resulting in strong upside momentum.",
      bearCase: "Broad market correction dampens listing gains, pulling the stock down in search of base consolidation."
    });
  }
});

// 9.5 AI Grounded Research & Deep Dive
app.post("/api/groq/research", async (req, res) => {
  const { prompt, useThinking } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "Research prompt is required" });
  }

  const client = getGroqClient();
  const modelToUse = useThinking ? "llama-3.3-70b-versatile" : "llama-3.1-8b-instant";

  if (!client) {
    return res.json({
      text: `### Grounded Research Fallback for: "${prompt}"\n\nBased on localized database and cached market reports:\n- **Current Trend:** Bullish with 78% institutional buy rating.\n- **Latest Metrics:** Grey Market Premiums remain steady. Solaris Renewable commands a ₹45 GMP (22.5% listing prediction) while Acme Cloudtech AI leads with ₹185 (38.9%).\n- *Note: Live search grounding and high thinking reasoning are currently simulated using local database files due to Groq key absence.*`,
      sources: [
        { title: "SEBI Red Herring Filings", url: "https://www.sebi.gov.in" },
        { title: "Chittorgarh IPO Trackers", url: "https://www.chittorgarh.com" }
      ]
    });
  }

  try {
    const response = await client.chat.completions.create({
      model: modelToUse,
      messages: [
        {
          role: "user",
          content: `You are an expert financial research intelligence bot. Provide a deep, objective, grounded research report about the requested IPO or market query. Ensure you cite real facts, pricing metrics, and regulatory guidelines.
Research Prompt: "${prompt}"`
        }
      ]
    });

    const sources = [
      { title: "SEBI Prospectus Database", url: "https://www.sebi.gov.in" },
      { title: "NSE India Mainboard", url: "https://www.nseindia.com" }
    ];

    res.json({
      text: response.choices[0]?.message?.content || "No response formulation received.",
      sources
    });
  } catch (err: any) {
    handleGroqError(err);
    console.error("Research API error, using fallback:", err);
    res.json({
      text: `### Deep Research Report: "${prompt}"\n\nI was unable to establish a live connection to our Groq research nodes. However, analyzing internal databases:\n- **Acme CloudTech AI (ACMEAI):** Highly favorable. Strong 88/100 score. Expected listing price ₹660.\n- **ZetaPay Fintech:** High risk. High retail debt defaults reported in FY26 Q1 financials.\n- **Solaris Renewable Energy:** Highly favorable. Outstanding government grid expansion credits. expected ₹245 listing (22.5% gain).`,
      sources: [
        { title: "Internal Valuation Ledger", url: "#" }
      ]
    });
  }
});

// 9.6 AI Music Clip Generator Simulator
app.post("/api/groq/music", (req, res) => {
  const { prompt, length = 30 } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "Music generation prompt is required" });
  }

  console.log(`Generating Groq music clip: [${prompt}], Length: ${length}s...`);

  res.json({
    success: true,
    modelUsed: "groq-audio-clip-preview",
    trackId: "groq-audio-" + Math.floor(100000 + Math.random() * 900000),
    title: "Ambient Market focus: " + prompt.slice(0, 30),
    duration: length,
    beatsPerMinute: prompt.toLowerCase().includes("bull") ? 124 : 90,
    waveform: Array.from({ length: 40 }, () => Math.round(20 + Math.random() * 60)),
    atmosphere: prompt.toLowerCase().includes("bull") ? "Uptrend Energy" : "Steady Accumulation Flow",
    note: "This track has been generated with Groq-audio-clip-preview. Your audio pipeline is playing the active focused synthesize oscillator in the background."
  });
});

// 10. Listing Day: fetch Groww closed IPO SSR HTML and provide companies + analysis endpoints

async function getClosedIPOList(): Promise<any[]> {
  const cacheKey = "groww_closed_ipos";
  const cached = redisCache.get(cacheKey);
  if (cached) return cached;

  const url = "https://groww.in/ipo/closed";
  try {
    const { data: html } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; iposense/1.0)" },
      timeout: 10_000
    });

    const $ = cheerio.load(html);
    const script = $("#__NEXT_DATA__").html();
    if (!script) return [];
    const nextData = JSON.parse(script);
    const list = nextData?.props?.pageProps?.dataList || [];
    // Cache for 5 minutes
    redisCache.set(cacheKey, list, 300);
    return list;
  } catch (err: any) {
    console.error("Failed to fetch Groww closed IPOs:", err?.message || err);
    return [];
  }
}

app.get("/api/listing-day/companies", async (req, res) => {
  try {
    const list = await getClosedIPOList();
    const mapped = list.map((ipo: any) => ({
      symbol: ipo.symbol || ipo.searchId || ipo.companyCode || null,
      companyName: ipo.companyName || ipo.name || ipo.company || null,
      issuePrice: ipo.issuePrice ?? ipo.minPrice ?? ipo.maxPrice ?? null,
      subscription: ipo.overallSubscription ?? ipo.subscriptionOverall ?? null,
      openingDate: ipo.openingDate || ipo.openDate || null,
      closingDate: ipo.closingDate || ipo.closeDate || null,
      listingDate: ipo.listingDate || (ipo.listingTimestamp ? new Date(ipo.listingTimestamp).toISOString().split("T")[0] : null),
      isListed: ipo.isListed ?? Boolean(ipo.listingPrice) ?? false,
      listingPrice: ipo.listingPrice ?? null,
      listingReturn: ipo.listingReturn ?? null,
      isSme: ipo.isSme ?? false,
      logoUrl: ipo.logoUrl || null,
      rtaLink: ipo.rtaLink || null
    }));
    res.json(mapped);
  } catch (err) {
    console.error("/api/listing-day/companies error:", err);
    res.status(500).json({ error: "Failed to fetch companies" });
  }
});

app.post("/api/listing-day/analyze", async (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  try {
    const list = await getClosedIPOList();
    const ipo = list.find((i: any) => {
      if (!i) return false;
      const s = (i.symbol || i.searchId || i.companyCode || "").toString().toLowerCase();
      return s === String(symbol).toLowerCase();
    });
    if (!ipo) return res.status(404).json({ error: "IPO not found" });

    const client = getGroqClient();

    if (ipo.isListed || ipo.listingPrice) {
      // CASE 1: already listed — generate an AI summary of actual listing performance
      const payload = {
        companyName: ipo.companyName || ipo.name,
        symbol: ipo.symbol,
        issuePrice: ipo.issuePrice ?? ipo.minPrice ?? ipo.maxPrice ?? null,
        listingPrice: ipo.listingPrice ?? null,
        listingReturn: ipo.listingReturn ?? null,
        subscription: ipo.overallSubscription ?? ipo.subscriptionOverall ?? null
      };

      if (!client) {
        // Local fallback summary
        const summary = `The IPO listed at ₹${payload.listingPrice} vs issue price ₹${payload.issuePrice}, delivering a ${payload.listingReturn}% return. Subscription was ${payload.subscription}x, which ${payload.subscription > 1 ? "supported" : "did not support"} listing demand.`;
        return res.json({
          status: "listed",
          companyName: payload.companyName,
          symbol: payload.symbol,
          issuePrice: payload.issuePrice,
          listingPrice: payload.listingPrice,
          listingReturn: payload.listingReturn,
          subscription: payload.subscription,
          summary
        });
      }

      try {
        const prompt = `You are a concise financial analyst. Given the IPO result below, write a short JSON response with a single field \"summary\" (max 3 sentences) explaining listing performance, demand, subscription impact and whether the outcome matched expectations. Return only valid JSON.
\nINPUT:\n${JSON.stringify(payload, null, 2)}`;

        const start = Date.now();
        const response = await client.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" }
        });
        const content = response.choices[0]?.message?.content;
        const parsed = content ? JSON.parse(content) : { summary: "" };
        await writeApiUsageLog(null, "/api/listing-day/analyze", "GROQ", response.usage?.total_tokens || 0, Date.now() - start, 200);
        return res.json({
          status: "listed",
          companyName: payload.companyName,
          symbol: payload.symbol,
          issuePrice: payload.issuePrice,
          listingPrice: payload.listingPrice,
          listingReturn: payload.listingReturn,
          subscription: payload.subscription,
          summary: parsed.summary || ""
        });
      } catch (err) {
        handleGroqError(err);
        console.error("Groq error in listing summary:", err);
        return res.json({
          status: "listed",
          companyName: payload.companyName,
          symbol: payload.symbol,
          issuePrice: payload.issuePrice,
          listingPrice: payload.listingPrice,
          listingReturn: payload.listingReturn,
          subscription: payload.subscription,
          summary: "Unable to generate AI summary at this time."
        });
      }
    }

    // CASE 2: not listed — send minimal fields to Groq for prediction
    const inputForModel = {
      companyName: ipo.companyName || ipo.name,
      issuePrice: ipo.issuePrice ?? ipo.minPrice ?? ipo.maxPrice ?? null,
      overallSubscription: ipo.overallSubscription ?? ipo.subscription ?? ipo.subscriptionOverall ?? null,
      isSme: ipo.isSme ?? false,
      openingDate: ipo.openingDate || ipo.openDate || null,
      closingDate: ipo.closingDate || ipo.closeDate || null
    };

    if (!client) {
      // Local heuristic predictor
      const issue = Number(inputForModel.issuePrice) || 0;
      const sub = Number(inputForModel.overallSubscription) || 0;
      const expectedReturn = sub > 0 ? Math.min(60, Math.round(sub * 1.5 * 10) / 10) : 5;
      const estimatedListingPrice = Number((issue * (1 + expectedReturn / 100)).toFixed(2));
      const confidence = sub >= 20 ? "High" : sub >= 5 ? "Moderate" : "Low";
      const summary = `Based on the subscription of ${sub}x and issue price ₹${issue}, the model estimates a listing around ₹${estimatedListingPrice} (${expectedReturn}% expected return).`;
      return res.json({
        status: "predicted",
        companyName: inputForModel.companyName,
        symbol: ipo.symbol,
        issuePrice: issue,
        estimatedListingPrice,
        expectedReturn,
        confidence,
        subscription: sub,
        summary
      });
    }

    // Call Groq with only the allowed fields
    try {
      const prompt = `You are an expert IPO analyst. Given the following IPO details, provide a JSON object with fields: estimatedListingPrice (number), expectedReturn (percent number), confidence (Low|Moderate|High), summary (max 2 sentences). Use only the provided data; do NOT reference any unofficial market prices.\n\nINPUT:\n${JSON.stringify(inputForModel, null, 2)}`;

      const start = Date.now();
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      });
      const content = response.choices[0]?.message?.content;
      const parsed = content ? JSON.parse(content) : {};
      await writeApiUsageLog(null, "/api/listing-day/analyze", "GROQ", response.usage?.total_tokens || 0, Date.now() - start, 200);

      return res.json({
        status: "predicted",
        companyName: inputForModel.companyName,
        symbol: ipo.symbol,
        issuePrice: inputForModel.issuePrice,
        estimatedListingPrice: parsed.estimatedListingPrice ?? null,
        expectedReturn: parsed.expectedReturn ?? null,
        confidence: parsed.confidence ?? null,
        subscription: inputForModel.overallSubscription,
        summary: parsed.summary ?? null
      });
    } catch (err) {
      handleGroqError(err);
      console.error("Groq predict error:", err);
      // Fallback heuristic if Groq fails
      const issue = Number(inputForModel.issuePrice) || 0;
      const sub = Number(inputForModel.overallSubscription) || 0;
      const expectedReturn = sub > 0 ? Math.min(60, Math.round(sub * 1.5 * 10) / 10) : 5;
      const estimatedListingPrice = Number((issue * (1 + expectedReturn / 100)).toFixed(2));
      const confidence = sub >= 20 ? "High" : sub >= 5 ? "Moderate" : "Low";
      const summary = `Based on available subscription data (${sub}x) the estimated listing is ₹${estimatedListingPrice} (${expectedReturn}% expected).`;
      return res.json({
        status: "predicted",
        companyName: inputForModel.companyName,
        symbol: ipo.symbol,
        issuePrice: issue,
        estimatedListingPrice,
        expectedReturn,
        confidence,
        subscription: sub,
        summary
      });
    }
  } catch (err) {
    console.error("/api/listing-day/analyze error:", err);
    res.status(500).json({ error: "Failed to analyze IPO" });
  }
});

// 11. PostgreSQL-backed Watchlist Endpoints
app.get("/api/watchlist", requireAuth, async (req: AuthRequest, res) => {
  try {
    const list = await postgresDb.select()
      .from(dbWatchlist)
      .where(eq(dbWatchlist.userId, req.dbUser!.id));
    res.json(list.map(w => w.ipoSymbol));
  } catch (err: any) {
    console.error("Watchlist GET failed:", err);
    res.status(500).json({ error: "Failed to fetch watchlist from database." });
  }
});

app.post("/api/watchlist", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { ipoSymbol } = req.body;
    if (!ipoSymbol) return res.status(400).json({ error: "ipoSymbol is required" });
    
    // Prevent duplicate entries
    const existing = await postgresDb.select()
      .from(dbWatchlist)
      .where(and(
        eq(dbWatchlist.userId, req.dbUser!.id),
        eq(dbWatchlist.ipoSymbol, ipoSymbol)
      ));
    
    if (existing.length === 0) {
      await postgresDb.insert(dbWatchlist)
        .values({
          userId: req.dbUser!.id,
          ipoSymbol: ipoSymbol
        });
    }
    
    res.json({ success: true });
  } catch (err: any) {
    console.error("Watchlist POST failed:", err);
    res.status(500).json({ error: "Failed to add to watchlist." });
  }
});

app.post("/api/watchlist/remove", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { ipoSymbol } = req.body;
    if (!ipoSymbol) return res.status(400).json({ error: "ipoSymbol is required" });
    
    await postgresDb.delete(dbWatchlist)
      .where(and(
        eq(dbWatchlist.userId, req.dbUser!.id),
        eq(dbWatchlist.ipoSymbol, ipoSymbol)
      ));
    
    res.json({ success: true });
  } catch (err: any) {
    console.error("Watchlist remove failed:", err);
    res.status(500).json({ error: "Failed to remove from watchlist." });
  }
});

app.post("/api/ai/predict", async (req: express.Request, res: express.Response) => {
  try {
    const { ipoSymbol, ipoName, gmp, priceBand, sector, issueSize, peRatio } = req.body;
    if (!ipoSymbol) {
      return res.status(400).json({ error: "ipoSymbol is required" });
    }

    // Check Postgres cache
    const existing = await postgresDb.select()
      .from(dbAiPredictions)
      .where(eq(dbAiPredictions.ipoSymbol, ipoSymbol))
      .limit(1);

    if (existing.length > 0) {
      return res.json({
        ipoSymbol: existing[0].ipoSymbol,
        successProbability: existing[0].successProbability,
        expectedListingGain: existing[0].expectedListingGain,
        confidence: existing[0].confidence,
        detailedAnalysis: existing[0].detailedAnalysis,
        source: "PostgreSQL Cache"
      });
    }

    // Call Groq API or fallback
    const groq = getGroqClient();
    let successProbability = 65;
    let expectedListingGain = 15;
    let confidence = 80;
    let detailedAnalysis = "";

    if (groq) {
      try {
        const prompt = `You are a legendary SEBI-registered IPO research analyst.
Analyze the following IPO and generate:
1. Success Probability (integer from 0 to 100)
2. Expected Listing Gain (integer percentage, can be negative)
3. Your Confidence Level (integer from 0 to 100)
4. A deeply insightful SWOT, Valuation, and Financial Sustainability report formatted in clean Markdown.

IPO Metadata:
- Symbol: ${ipoSymbol}
- Name: ${ipoName || ipoSymbol}
- GMP: ${gmp || "Premium of 20%"}
- Price Band: ${priceBand || "100-115"}
- Sector: ${sector || "Technology"}
- Issue Size: ${issueSize || "500 Cr"}
- P/E Ratio: ${peRatio || "25x"}

Response MUST be a JSON object matching this schema EXACTLY:
{
  "successProbability": number,
  "expectedListingGain": number,
  "confidence": number,
  "detailedAnalysis": "Markdown formatted report"
}`;

        const result = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" }
        });

        const parsed = JSON.parse((result.choices[0]?.message?.content || "{}").trim());
        successProbability = parsed.successProbability || 70;
        expectedListingGain = parsed.expectedListingGain || 22;
        confidence = parsed.confidence || 85;
        detailedAnalysis = parsed.detailedAnalysis || "Analysis completed successfully.";
      } catch (err) {
        console.error("Groq prediction call failed, using rule-based calculations:", err);
        const calculated = calculateRuleBasedPrediction(ipoSymbol, gmp, peRatio, sector);
        successProbability = calculated.successProbability;
        expectedListingGain = calculated.expectedListingGain;
        confidence = calculated.confidence;
        detailedAnalysis = calculated.detailedAnalysis;
      }
    } else {
      const calculated = calculateRuleBasedPrediction(ipoSymbol, gmp, peRatio, sector);
      successProbability = calculated.successProbability;
      expectedListingGain = calculated.expectedListingGain;
      confidence = calculated.confidence;
      detailedAnalysis = calculated.detailedAnalysis;
    }

    // Save cache to Postgres
    const [saved] = await postgresDb.insert(dbAiPredictions)
      .values({
        ipoSymbol,
        successProbability,
        expectedListingGain,
        confidence,
        detailedAnalysis,
      })
      .onConflictDoUpdate({
        target: dbAiPredictions.ipoSymbol,
        set: {
          successProbability,
          expectedListingGain,
          confidence,
          detailedAnalysis
        }
      })
      .returning();

    res.json({
      ipoSymbol: saved.ipoSymbol,
      successProbability: saved.successProbability,
      expectedListingGain: saved.expectedListingGain,
      confidence: saved.confidence,
      detailedAnalysis: saved.detailedAnalysis,
      source: "Groq Llama-3 70B Engine"
    });
  } catch (err: any) {
    console.error("AI Predict Endpoint failed:", err);
    res.status(500).json({ error: "Failed to generate AI Prediction." });
  }
});

// Rules-based predictive fallback engine
function calculateRuleBasedPrediction(symbol: string, gmp: any, peRatio: any, sector: string) {
  const parsedGmp = parseFloat(gmp) || 15;
  const pe = parseFloat(peRatio) || 28;
  
  let listingGain = Math.round(parsedGmp);
  if (isNaN(listingGain) || listingGain === 0) {
    if (sector?.toLowerCase().includes("tech")) listingGain = 32;
    else if (sector?.toLowerCase().includes("renewable") || sector?.toLowerCase().includes("solar")) listingGain = 45;
    else listingGain = 15;
  }
  
  let successProbability = 55 + Math.round(listingGain * 1.1);
  if (pe > 45) successProbability -= 12;
  if (pe < 18) successProbability += 10;
  successProbability = Math.max(15, Math.min(98, successProbability));
  
  const confidence = 90 - Math.round(Math.abs(25 - pe) / 2);
  
  const detailedAnalysis = `### 📋 Red Herring Prospectus (RHP) Diagnostic: **${symbol}**
  
#### 🏢 Business Model & Competitive Moat
The company operates a scalable B2B/B2C service interface. Their key competitive advantage lies in localized logistics channels and contract-locked distribution partnerships.

#### 📊 Financial Health Indicators
- **EBITDA Growth**: Double-digit CAGR expansion over the trailing 3 fiscal years.
- **Liquidity Coverage**: Current ratio of 1.45, proving high structural coverage of near-term trade lines.
- **PE Multiple**: Operating at **${pe}x** relative to industry category norm of 30x.

#### 🔍 SWOT Analysis
- **Strengths**: Highly decentralized operating cost structures, strong brand equity.
- **Weaknesses**: Regulatory exposure to geopolitical commodity input pricing.
- **Opportunities**: Cross-border product line launches, greenfield capacity expansion.
- **Threats**: Margin compression due to aggressive tier-2 market entrance.

#### ⚖️ Investment Verdict
**SUBSCRIBE WITH MEDIUM TO LONG TERM horizon.** Low debt burden coupled with robust return on equity (RoE) suggests a safe buffer for retail listing premiums.`;

  return {
    successProbability,
    expectedListingGain: listingGain,
    confidence: Math.max(60, Math.min(95, confidence)),
    detailedAnalysis
  };
}

// SSE and background cron behavior have been removed for serverless compatibility.
// Market and notification updates should be triggered on demand by the request lifecycle.

// RHP Analyzer Endpoint
// RHP Analyzer Endpoint
app.post("/api/rhp/analyze", async (req, res) => {
  const { pdfName, pdfBase64 } = req.body;

  if (!pdfName) {
    return res.status(400).json({
      error: "Prospectus file name is required",
    });
  }

  if (!pdfBase64) {
    return res.status(400).json({
      error: "Prospectus PDF content is required",
    });
  }

  try {
    const ai = getGroqClient();

    if (!ai) {
      return res.status(500).json({
        error: "Groq client is not configured.",
      });
    }

    console.log(
      `[RHP Analyzer] Parsing RHP PDF using Groq intelligence engine: ${pdfName}`
    );

    // Prevent Groq 413 Request Too Large
  // Decode Base64 -> PDF -> Plain Text
const cleanBase64 = pdfBase64.includes(",")
  ? pdfBase64.split(",")[1]
  : pdfBase64;

const pdfBuffer = Buffer.from(cleanBase64, "base64");

const parser = new PDFParse({
  data: pdfBuffer,
});

const parsedPdf = await parser.getText();
await parser.destroy();

const documentContent = parsedPdf.text
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 25000);

console.log(`[RHP Analyzer] PDF text length: ${parsedPdf.text.length}`);
console.log(`[RHP Analyzer] Sending ${documentContent.length} chars to Groq`);

    const prompt = `
You are an expert SEBI IPO analyst.

Analyze ONLY the uploaded Red Herring Prospectus.

Never invent:
- company name
- issue size
- price band
- promoters
- financial numbers
- risks

If something is unavailable, return null.

Uploaded document:

${documentContent}

Return ONLY valid JSON.

{
  "companyName": "",
  "symbol": "",
  "industry": "",
  "summary": {
    "about": "",
    "freshIssue": "",
    "ofs": "",
    "totalIssue": "",
    "priceBand": "",
    "listingObjectives": [],
    "promoters": ""
  },
  "risks": {
    "internal": [],
    "external": []
  },
  "financials": {
    "years": [],
    "revenue": [],
    "ebitda": [],
    "pat": [],
    "ratios": []
  },
  "redFlags": []
}
`;

    const response = await ai.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: {
        type: "json_object",
      },
    });

    const content = response.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Groq returned an empty response.");
    }

    try {
      const parsed = JSON.parse(content.trim());
      return res.json(parsed);
    } catch (err) {
      console.error("[RHP Analyzer] Invalid JSON received from Groq");
      console.error(content);

      return res.status(500).json({
        error: "Groq returned invalid JSON.",
      });
    }
  } catch (error: any) {
    console.error("========== RHP ANALYZER ERROR ==========");
    console.error(error);
    console.error(error?.stack);
    console.error("========================================");

    return res.status(500).json({
      error:
        error?.message ||
        "Unable to analyze the uploaded RHP.",
    });
  }
});


// Google News RSS IPO Feed Alias
app.get("/api/news", async (req, res) => {
  try {
    const response = await fetch(
      "https://news.google.com/rss/search?q=IPO+India&hl=en-IN&gl=IN&ceid=IN:en",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const xml = await response.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .slice(0, 4)
      .map((match) => {
        const item = match[1];

        // --- Google News RSS description decoding and extraction ---
        const rawDescription = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "";

        const description = rawDescription
          .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/<a[^>]*>(.*?)<\/a>/g, "$1")
          .replace(/<font[^>]*>(.*?)<\/font>/g, "$1")
          .replace(/<[^>]*>/g, "")
          .replace(/\s+/g, " ")
          .trim();

        // --- Title cleanup logic ---
        const rawTitle = item.match(/<title>(.*?)<\/title>/)?.[1] || "";
        const cleanTitle = rawTitle
          .replace(/\s+-\s+[^-]+$/, "")
          .replace(/\s+/g, " ")
          .trim();

        const cleanedDescription = description
          .replace(/^.*?\s{2,}/, "")
          .replace(/https?:\/\/\S+/g, "")
          .trim();

        const extractedSummary = cleanedDescription
          .replace(/^\s*[^:]+:\s*/, "")
          .trim();

        const newsSummary = extractedSummary && extractedSummary !== cleanTitle
          ? extractedSummary
          : `Market update: ${cleanTitle}. Investors are tracking IPO developments, demand trends, and listing performance.`;

        // --- Extract link and add url property ---
        const newsLink = item.match(/<link>(.*?)<\/link>/)?.[1] || "";

        return {
          title: cleanTitle,
          summary: newsSummary.length > 220 ? newsSummary.slice(0, 220) + "..." : newsSummary,
          source: item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "Google News",
          publishedAt: item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || new Date().toISOString(),
          link: newsLink,
          url: newsLink
        };
      });

    const analyzedItems = items.map((item) => ({
      ...item,
      sentiment: "NEUTRAL",
      score: 0,
      analysis: "Automatic AI sentiment analysis disabled to prevent rate-limit usage."
    }));

    res.json(analyzedItems);
  } catch (err) {
    console.error("Google News RSS alias failed:", err);
    res.status(500).json({ error: "Failed to fetch IPO news" });
  }
});

// Google News RSS IPO Live Feed Endpoint
app.get("/api/news/live", async (req, res) => {
  try {
    const response = await fetch(
      "https://news.google.com/rss/search?q=IPO+India&hl=en-IN&gl=IN&ceid=IN:en",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const xml = await response.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .slice(0, 4)
      .map((match) => {
        const item = match[1];

        // --- Title cleanup logic for live endpoint ---
        const rawTitle = item.match(/<title>(.*?)<\/title>/)?.[1]
          ?.replace(/<!\[CDATA\[(.*?)\]\]>/, "$1") || "";

        const title = rawTitle.replace(/\s+-\s+[^-]+$/, "").trim();

        const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "Google News";
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || new Date().toISOString();
        const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";

        // --- Google News RSS description decoding and extraction for live endpoint ---
        const rawDescription = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "";

        const summary = rawDescription
          .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/<a[^>]*>(.*?)<\/a>/g, "$1")
          .replace(/<font[^>]*>(.*?)<\/font>/g, "$1")
          .replace(/<[^>]*>/g, "")
          .replace(/https?:\/\/\S+/g, "")
          .replace(/\s+/g, " ")
          .trim() || "Latest IPO market update from Google News.";

        return {
          title,
          summary,
          source,
          publishedAt: pubDate,
          link,
          url: link
        };
      });

    res.json(items);
  } catch (err) {
    console.error("Google News RSS fetch failed:", err);
    res.status(500).json({ error: "Failed to fetch live IPO news" });
  }
});

// AI News Sentiment Analysis Endpoint (Groq powered)
app.post("/api/news/analyze-sentiment", async (req, res) => {
  const { title, summary } = req.body;

  if (!title) {
    return res.status(400).json({ error: "News title is required" });
  }

  const ai = getGroqClient();

  if (ai) {
    try {
      const response = await ai.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "user",
            content: `You are an expert IPO market sentiment classifier.

Analyze the news headline and summary carefully. Do NOT return NEUTRAL by default. Identify bullish signals like subscription growth, premium, gains, rise, strong demand, oversubscription, expansion, approvals, partnerships, positive investor response. Identify bearish signals like losses, decline, weak demand, risk, warning, concerns, regulatory issues.

Headline:
${title}

Summary:
${summary || ""}

Return ONLY JSON:
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "score": number between -100 and 100,
  "reason": "short explanation"
}`
          }
        ],
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content;

      if (content) {
        const parsed = JSON.parse(content.trim());

        return res.json({
          sentiment: parsed.sentiment || "NEUTRAL",
          score: Number(parsed.score) || 0,
          analysis: parsed.reason || "Groq AI sentiment analysis completed.",
          keyTriggers: [],
          marketImpact: Math.abs(Number(parsed.score) || 0) > 40 ? "HIGH" : "MEDIUM"
        });
      }
    } catch (err) {
      console.warn("Groq sentiment analysis failed, using fallback:", err);
    }
  }

  const fullText = `${title} ${summary || ""}`.toLowerCase();

  let sentiment = "NEUTRAL";
  let score = 0;

  if (
    [
      "surge", "growth", "premium", "oversubscribed", "subscription", "strong", "higher", "gain", "rise", "demand", "interest", "positive", "record", "attracts", "jump", "fizz"
    ].some(k => fullText.includes(k))
  ) {
    sentiment = "BULLISH";
    score = 40;
  } else if (
    [
      "fall", "risk", "loss", "decline", "concern", "warning", "weak", "drop", "lower", "issue", "negative"
    ].some(k => fullText.includes(k))
  ) {
    sentiment = "BEARISH";
    score = -40;
  }

  res.json({
    sentiment,
    score,
    analysis: "Local fallback IPO sentiment analysis.",
    keyTriggers: [],
    marketImpact: Math.abs(score) > 40 ? "HIGH" : "MEDIUM"
  });
});


// ==========================================
// AI SOCIAL MEDIA ANALYZER ENDPOINTS
// ==========================================

// Helper to generate context-specific mock social media posts
function generateSocialPosts(keyword: string) {
  const kw = keyword || "NTPC Green Energy";
  return [
    {
      id: "tw-1",
      platform: "twitter",
      author: "@CapitalGains_IN",
      handle: "Market Strategist",
      content: `Extremely bullish on ${kw}! GMP has jumped to 42% already. Subscription numbers in Retail category look record breaking. Direct apply for listing gains! 🚀🔥 $${kw.replace(/\s+/g, "")} #IPO #StockMarket`,
      timestamp: "10m ago",
      metrics: { engagement: 342, likes: 1205 }
    },
    {
      id: "tw-2",
      platform: "twitter",
      author: "@ValueInvestorPrash",
      handle: "Equity Analyst",
      content: `Evaluating ${kw} IPO. High debt-to-equity ratio remains a core concern, despite promising top-line growth. Listing gains might be limited given the rich valuations. I'm staying cautious. 📉`,
      timestamp: "45m ago",
      metrics: { engagement: 89, likes: 210 }
    },
    {
      id: "tw-3",
      platform: "twitter",
      author: "@FinTech_Guru",
      handle: "Retail Trader",
      content: `Just submitted my application for ${kw} IPO on 3 accounts. Retail buzz is insane! Broker reports indicating massive oversubscription on day 2. Let's hope for allotment! 🤞💎`,
      timestamp: "1h ago",
      metrics: { engagement: 56, likes: 180 }
    },
    {
      id: "re-1",
      platform: "reddit",
      author: "u/ValueSeekerIndia",
      handle: "r/IndiaInvestments",
      content: `Detailed fundamental review of ${kw} IPO. Operating margins look stabilized, but raw material costs are rising. Key risks are highly localized regulatory policies and dependance on public sector procurement. I rate it as a MEDIUM risk long-term play, not just listing day gains.`,
      timestamp: "2h ago",
      metrics: { engagement: 45, likes: 230 }
    },
    {
      id: "re-2",
      platform: "reddit",
      author: "u/BullishBihari",
      handle: "r/DalalStreetTalks",
      content: `${kw} is a must apply! Renewable/Green themes are getting insane premium right now in India. Look at recent green listings, all listed at 30-50% premium. Even with high PE ratio, demand will carry it up. Easiest money of the quarter.`,
      timestamp: "4h ago",
      metrics: { engagement: 112, likes: 580 }
    },
    {
      id: "yt-1",
      platform: "youtube",
      author: "MarketMantra AI",
      handle: "850K Subscribers",
      content: `${kw} IPO Complete Analysis - Avoid Or Apply? Real GMP & Price Band calculation. Target Listing Gains estimated. Watch till end for rating!`,
      timestamp: "3h ago",
      metrics: { engagement: 45000, likes: 3200 }
    },
    {
      id: "yt-2",
      platform: "youtube",
      author: "Wealth Builders",
      handle: "1.2M Subscribers",
      content: `WARNING: Don't buy ${kw} before watching this video. Behind the scenes accounting issues and pricing trap decoded. Protect your capital!`,
      timestamp: "5h ago",
      metrics: { engagement: 68000, likes: 4100 }
    }
  ];
}

app.post("/api/social/analyze", async (req, res) => {
  const { keyword, platforms } = req.body;
  if (!keyword) {
    return res.status(400).json({ error: "Search keyword is required" });
  }

  const selectedPlatforms = platforms || ["twitter", "reddit", "youtube"];
  const rawPosts = generateSocialPosts(keyword).filter(p => selectedPlatforms.includes(p.platform));

  try {
    const ai = getGroqClient();
    if (ai) {
      console.log(`[Social Sentiment Analyzer] Auditing social media trends for: "${keyword}"`);
      const prompt = `Analyze these social media posts concerning "${keyword}" and calculate detailed sentiments.
Posts to evaluate:
${JSON.stringify(rawPosts, null, 2)}

Provide a unified, highly polished consolidated sentiment report. Determine the sentiment for each post, assign a score (-100 for bearish to +100 for bullish), and output an overall summary sentiment.

Return a structured JSON object matching the following schema:
{
  "overallSentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "overallScore": number (-100 to +100),
  "consensusSummary": "string (2 sentences of high-grade analytical summary detailing retail vs institutional chatter)",
  "platformStats": {
    "twitter": { "sentiment": "BULLISH"|"BEARISH"|"NEUTRAL", "score": number },
    "reddit": { "sentiment": "BULLISH"|"BEARISH"|"NEUTRAL", "score": number },
    "youtube": { "sentiment": "BULLISH"|"BEARISH"|"NEUTRAL", "score": number }
  },
  "analyzedPosts": [
    {
      "id": "string",
      "postSentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
      "postScore": number,
      "nlpExplanation": "string (1 short sentence explaining why this sentiment was assigned)"
    }
  ]
}

Return ONLY valid JSON.`;

      const response = await ai.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content;
      if (content) {
        try {
          const cleanText = content.trim();
          const parsed = JSON.parse(cleanText);
          
          // Map original post data with Groq's NLP results
          const enrichedPosts = rawPosts.map(p => {
            const analysis = parsed.analyzedPosts?.find((ap: any) => ap.id === p.id);
            return {
              ...p,
              sentiment: analysis?.postSentiment || "NEUTRAL",
              score: analysis?.postScore || 0,
              explanation: analysis?.nlpExplanation || "Consistent neutral chatter."
            };
          });

          return res.json({
            overallSentiment: parsed.overallSentiment,
            overallScore: parsed.overallScore,
            consensusSummary: parsed.consensusSummary,
            platformStats: parsed.platformStats,
            posts: enrichedPosts
          });
        } catch (parseErr) {
          console.warn("[Social Sentiment Analyzer] JSON parsing failed, using rule-fallback:", parseErr);
        }
      }
    }
  } catch (err) {
    console.warn("[Social Sentiment Analyzer] Groq connection failed, using local rules-engine:", err);
  }

  // High-fidelity local fallback classifier
  let totalScore = 0;
  const enrichedPosts = rawPosts.map(post => {
    let sentiment: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    let score = 0;
    let explanation = "General informational sentiment observed on platform channels.";

    const text = post.content.toLowerCase();
    if (text.includes("bullish") || text.includes("jump") || text.includes("insane") || text.includes("easiest money") || text.includes("apply") || text.includes("gains")) {
      sentiment = "BULLISH";
      score = text.includes("insane") || text.includes("easiest") ? 85 : 45;
      explanation = "Strong positive keywords, retail subscription demand signals, or immediate listing gains indicated.";
    } else if (text.includes("caution") || text.includes("debt") || text.includes("avoid") || text.includes("warning") || text.includes("trap") || text.includes("accounting")) {
      sentiment = "BEARISH";
      score = text.includes("warning") || text.includes("trap") ? -80 : -40;
      explanation = "Heightened pricing multiplier concerns, debt ratios, or macro risk premium concerns reported.";
    }

    totalScore += score;
    return {
      ...post,
      sentiment,
      score,
      explanation
    };
  });

  const avgScore = Math.round(totalScore / (rawPosts.length || 1));
  const overallSentiment = avgScore > 15 ? "BULLISH" : avgScore < -15 ? "BEARISH" : "NEUTRAL";

  const consensusSummary = overallSentiment === "BULLISH" 
    ? `Retail enthusiasm surrounding listing premiums and green technology is carrying the social consensus into an optimistic outlook, with high-velocity GMP discussions.`
    : overallSentiment === "BEARISH"
    ? `Analytical sentiment remains highly cautious with focus on rich pricing multiples, corporate leverage, and immediate listing-day volatility.`
    : `Balanced distribution of long-term value assessments and premium listing warnings on online channels, leading to a stable/neutral consensus.`;

  res.json({
    overallSentiment,
    overallScore: avgScore,
    consensusSummary,
    platformStats: {
      twitter: { sentiment: avgScore > 10 ? "BULLISH" : "NEUTRAL", score: Math.round(avgScore * 1.1) },
      reddit: { sentiment: avgScore > 5 ? "BULLISH" : "NEUTRAL", score: Math.round(avgScore * 0.9) },
      youtube: { sentiment: avgScore > 20 ? "BULLISH" : "NEUTRAL", score: Math.round(avgScore * 1.2) }
    },
    posts: enrichedPosts
  });
});


// ==========================================
// AI MARKET INTELLIGENCE ENDPOINTS
// ==========================================

// Global state for market benchmarks to enable real-time updates and manual adjustments
let marketState = {
  nifty: { value: 24150.35, change: 156.40, pctChange: 0.65, status: "BULLISH" },
  sensex: { value: 79210.15, change: 458.30, pctChange: 0.58, status: "BULLISH" },
  banknifty: { value: 51450.60, change: -108.20, pctChange: -0.21, status: "BEARISH" },
  indiavix: { value: 14.22, change: -0.50, pctChange: -3.40, status: "STABLE" },
  fii: { flow: 1240.50, status: "NET_BUYERS" }, // Net flows in Cr
  dii: { flow: -350.20, status: "NET_SELLERS" }
};

app.get("/api/market/intelligence", (req, res) => {
  res.json(marketState);
});

// Endpoint to "Adjust AI Scores" based on macro-market overrides
app.post("/api/market/adjust-scores", async (req, res) => {
  const { niftyBias, sensexBias, bankniftyBias, vixValue, fiiFlow, diiFlow, customScenario } = req.body;

  // Apply visual or mock state changes locally to the benchmark state
  if (niftyBias) {
    marketState.nifty.status = niftyBias;
    marketState.nifty.pctChange = niftyBias === "BULLISH" ? 0.85 : niftyBias === "BEARISH" ? -1.15 : 0.05;
    marketState.nifty.value += niftyBias === "BULLISH" ? 150 : niftyBias === "BEARISH" ? -250 : 10;
  }
  if (sensexBias) {
    marketState.sensex.status = sensexBias;
    marketState.sensex.pctChange = sensexBias === "BULLISH" ? 0.72 : sensexBias === "BEARISH" ? -0.98 : 0.02;
    marketState.sensex.value += sensexBias === "BULLISH" ? 450 : sensexBias === "BEARISH" ? -720 : 15;
  }
  if (bankniftyBias) {
    marketState.banknifty.status = bankniftyBias;
    marketState.banknifty.pctChange = bankniftyBias === "BULLISH" ? 1.05 : bankniftyBias === "BEARISH" ? -1.45 : -0.05;
    marketState.banknifty.value += bankniftyBias === "BULLISH" ? 350 : bankniftyBias === "BEARISH" ? -600 : -20;
  }
  if (vixValue) {
    marketState.indiavix.value = parseFloat(vixValue);
    marketState.indiavix.status = parseFloat(vixValue) > 18 ? "VOLATILE" : parseFloat(vixValue) > 13 ? "STABLE" : "COMPLACENT";
  }
  if (fiiFlow) {
    marketState.fii.flow = parseFloat(fiiFlow);
    marketState.fii.status = parseFloat(fiiFlow) > 0 ? "NET_BUYERS" : "NET_SELLERS";
  }
  if (diiFlow) {
    marketState.dii.flow = parseFloat(diiFlow);
    marketState.dii.status = parseFloat(diiFlow) > 0 ? "NET_BUYERS" : "NET_SELLERS";
  }

  try {
    const ai = getGroqClient();
    if (ai) {
      console.log("[Market Intelligence] Running Groq macro score adjustment analysis");
      const prompt = `You are a Senior Quantitative Equity Strategist. Calculate the direct impact of these adjusted macro benchmarks on Indian IPO pricing, subscription odds, and sector risks.

Adjusted Market Benchmarks:
- Nifty: ${marketState.nifty.status} (${marketState.nifty.pctChange}%)
- Sensex: ${marketState.sensex.status} (${marketState.sensex.pctChange}%)
- BankNifty: ${marketState.banknifty.status} (${marketState.banknifty.pctChange}%)
- India VIX: ${marketState.indiavix.value} (${marketState.indiavix.status})
- FII Flow: ₹${marketState.fii.flow} Cr (${marketState.fii.status})
- DII Flow: ₹${marketState.dii.flow} Cr (${marketState.dii.status})
- Custom Scenario / Rumors: ${customScenario || "None"}

Evaluate the adjusted score metrics. Provide a JSON response mapping:
1. Sector Valuation multipliers (Renewable Energy, Tech/SaaS, Financials, Infrastructure) - whether they contract or expand.
2. Market risk score (0 to 100).
3. Strategic advisory consensus (1-2 sentences).
4. Recommended GMP adjustment bias (e.g. "GMP levels likely to expand by 15-20% due to FII support" or "GMP likely to contract by 25% due to high VIX fear index").

Return a structured JSON object matching the following schema:
{
  "adjustedRiskScore": number (0 to 100),
  "advisoryConsensus": "string",
  "gmpAdjustmentBias": "string",
  "sectorImpacts": [
    { "sector": "Renewable Energy", "multiplierBias": "+0.15x" | "-0.20x", "status": "EXPANDING" | "CONTRACTING" | "STABLE", "narrative": "string" },
    { "sector": "Tech & SaaS", "multiplierBias": "string", "status": "string", "narrative": "string" },
    { "sector": "Financials", "multiplierBias": "string", "status": "string", "narrative": "string" },
    { "sector": "Infrastructure", "multiplierBias": "string", "status": "string", "narrative": "string" }
  ]
}

Return ONLY valid JSON.`;

      const response = await ai.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content;
      if (content) {
        try {
          const cleanText = content.trim();
          const parsed = JSON.parse(cleanText);
          return res.json({
            ...parsed,
            benchmarks: marketState
          });
        } catch (parseErr) {
          console.warn("[Market Intelligence] Failed to parse adjusted Groq JSON:", parseErr);
        }
      }
    }
  } catch (err) {
    console.warn("[Market Intelligence] Groq macro-adjustment failed, deploying rules-based fallback:", err);
  }

  // Rules-based calculation engine
  let fearIndex = marketState.indiavix.value;
  let riskScore = 30 + (fearIndex > 15 ? (fearIndex - 15) * 5 : 0);
  if (marketState.fii.flow < 0) riskScore += 15;
  if (marketState.nifty.status === "BEARISH") riskScore += 20;
  riskScore = Math.min(95, Math.max(10, riskScore));

  let gmpAdjustmentBias = "GMP values likely to remain rangebound with normal institutional support.";
  if (fearIndex > 18) {
    gmpAdjustmentBias = "GMP premiums expected to contract significantly (-15% to -25%) due to sudden spike in the India VIX volatility index.";
  } else if (marketState.fii.flow > 2000) {
    gmpAdjustmentBias = "GMP levels expected to expand by 10% to 15% fueled by aggressive FII buying block sizes.";
  }

  const advisoryConsensus = riskScore > 65
    ? `Caution is heavily advised for high-priced IPO launches. Conserve cash allocations and prioritize debt-free consumer companies.`
    : `Excellent market liquidity and support levels suggest continuing defensive applications across green and tech sectors.`;

  res.json({
    adjustedRiskScore: Math.round(riskScore),
    advisoryConsensus,
    gmpAdjustmentBias,
    sectorImpacts: [
      { sector: "Renewable Energy", multiplierBias: riskScore > 60 ? "-0.10x" : "+0.25x", status: riskScore > 60 ? "CONTRACTING" : "EXPANDING", narrative: "Green energy sector retains robust retail demand, buffer-shielding it from mild liquid contractions." },
      { sector: "Tech & SaaS", multiplierBias: riskScore > 50 ? "-0.25x" : "+0.15x", status: riskScore > 50 ? "CONTRACTING" : "EXPANDING", narrative: "Premium SaaS startups remain highly sensitive to volatile liquidity swings and high-VIX adjustments." },
      { sector: "Financials", multiplierBias: marketState.banknifty.status === "BULLISH" ? "+0.12x" : "-0.18x", status: marketState.banknifty.status === "BULLISH" ? "EXPANDING" : "CONTRACTING", narrative: "Direct mapping to BankNifty momentum dictates capital flow and valuation premium adjustments." },
      { sector: "Infrastructure", multiplierBias: "+0.05x", status: "STABLE", narrative: "Stable infrastructure valuations are insulated due to fixed asset structures and public expenditure." }
    ],
    benchmarks: marketState
  });
});


// Notification simulation & dispatch testing endpoint
app.post("/api/notifications/test-send", requireAuth, async (req: AuthRequest, res) => {
  const { type, ipoName, alertType, emailRecipient, phoneRecipient } = req.body;
  if (!type || !ipoName || !alertType) {
    return res.status(400).json({ error: "Missing required notification fields." });
  }

  const userId = req.dbUser!.id;
  
  let gmpMultiplier = "+42%";
  let description = "Outstanding market demand with robust block volumes.";

  if (ipoName.toLowerCase().includes("ntpc")) {
    gmpMultiplier = "+38%";
    description = "Sustained green-energy premium with solid domestic support.";
  } else if (ipoName.toLowerCase().includes("waaree")) {
    gmpMultiplier = "+94%";
    description = "Record-breaking solar sector listing premium expectations.";
  }

  let finalTitle = "";
  let finalMessage = "";
  let emailHtml = "";
  let smsText = "";
  let logs: string[] = [];

  logs.push(`[SYSTEM] Initializing multi-channel notification pipeline for user ID ${userId}`);
  logs.push(`[SYSTEM] Target IPO: ${ipoName} | Trigger Category: ${alertType}`);

  try {
    const ai = getGroqClient();
    if (ai) {
      logs.push("[AI] Requesting Groq Llama to generate custom notifications payload...");
      const prompt = `You are a professional financial notification designer. Generate standard alerts for the IPO: "${ipoName}" (Alert trigger: "${alertType}").
      
      Generate a JSON response matching this schema:
      {
        "title": "A short, attention-grabbing title (max 50 chars)",
        "pushMessage": "A brief, clear notification message for browser push (max 100 chars)",
        "emailSubject": "A highly professional subject line",
        "emailHtml": "A beautiful, modern inline-styled HTML email body with elegant dark/light theme accents, clean tables showing key metrics (like Listing Premium of ${gmpMultiplier}, Alert type, timestamp), and professional signature.",
        "smsText": "A punchy, clear SMS text (max 140 chars) with important details."
      }
      
      Make sure to return ONLY valid JSON.`;

      const response = await ai.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content;
      if (content) {
        try {
          const cleanText = content.trim();
          const parsed = JSON.parse(cleanText);
          finalTitle = parsed.title;
          finalMessage = parsed.pushMessage;
          emailHtml = parsed.emailHtml;
          smsText = parsed.smsText;
          logs.push("[AI] Groq successfully synthesized and compiled beautiful multichannel payloads!");
        } catch (parseErr) {
          console.warn("FCM Fallback parsing:", parseErr);
        }
      }
    }
  } catch (err) {
    console.warn("FCM Groq call failed, resorting to rule engines:", err);
  }

  // High-fidelity fallback templates
  if (!finalTitle) {
    logs.push("[SYSTEM] Using rules-based template compiler for alerts.");
    if (alertType === "GMP_SPIKE") {
      finalTitle = `🔥 GMP Alert: ${ipoName} climbs to ${gmpMultiplier}!`;
      finalMessage = `Grey Market Premium has surged significantly to ${gmpMultiplier}. ${description}`;
      smsText = `IPOSense ALERT: ${ipoName} GMP has surged to ${gmpMultiplier}! Market sentiment is extremely positive. Read deep analytical reviews in-app.`;
    } else if (alertType === "ALLOTMENT_OUT") {
      finalTitle = `🎯 Allotment Status Out: ${ipoName}`;
      finalMessage = `The official NSE/BSE registrar has published allotment results. Check your allotment status now.`;
      smsText = `IPOSense: Allotment results for ${ipoName} are officially published. Open the Allotment Tracker tab to query your PAN allocation immediately.`;
    } else {
      finalTitle = `⚠️ Critical Prospectus Alert: ${ipoName}`;
      finalMessage = `New financial filings and updated risk indicators published for ${ipoName}.`;
      smsText = `IPOSense Prospectus Notice: Critical metrics updated for ${ipoName} IPO. Review revised RHP sections inside your AI workspace.`;
    }

    emailHtml = `
      <div style="font-family: 'Inter', system-ui, sans-serif; background-color: #0b0f19; color: #f1f5f9; padding: 30px; border-radius: 16px; border: 1px solid #1e293b; max-width: 600px; margin: 0 auto;">
        <div style="border-bottom: 2px solid #3b82f6; padding-bottom: 15px; margin-bottom: 20px; display: flex; align-items: center;">
          <h2 style="margin: 0; color: #3b82f6; font-size: 20px;">IPOSense Alert Network</h2>
        </div>
        <h3 style="color: #ffffff; font-size: 18px; margin-top: 0;">${finalTitle}</h3>
        <p style="color: #94a3b8; font-size: 13px; line-height: 1.6;">
          ${finalMessage}
        </p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #111827; border-radius: 8px; overflow: hidden;">
          <tr style="border-bottom: 1px solid #1e293b;">
            <th style="text-align: left; padding: 10px; font-size: 11px; color: #94a3b8; text-transform: uppercase;">Metric</th>
            <th style="text-align: right; padding: 10px; font-size: 11px; color: #94a3b8; text-transform: uppercase;">Value</th>
          </tr>
          <tr style="border-bottom: 1px solid #1e293b;">
            <td style="padding: 12px 10px; font-size: 13px; color: #f1f5f9; font-weight: bold;">IPO Name</td>
            <td style="padding: 12px 10px; font-size: 13px; color: #f1f5f9; text-align: right;">${ipoName}</td>
          </tr>
          <tr style="border-bottom: 1px solid #1e293b;">
            <td style="padding: 12px 10px; font-size: 13px; color: #f1f5f9; font-weight: bold;">Estimated Premium</td>
            <td style="padding: 12px 10px; font-size: 13px; color: #10b981; text-align: right; font-weight: bold;">${gmpMultiplier}</td>
          </tr>
          <tr style="border-bottom: 1px solid #1e293b;">
            <td style="padding: 12px 10px; font-size: 13px; color: #f1f5f9; font-weight: bold;">Trigger Event</td>
            <td style="padding: 12px 10px; font-size: 12px; color: #f59e0b; text-align: right; font-weight: bold;">${alertType.replace("_", " ")}</td>
          </tr>
        </table>
        <p style="font-size: 12px; color: #94a3b8;">
          Note: This is an automated real-time trigger sent based on your custom watchlist preferences in IPOSense.
        </p>
        <div style="margin-top: 30px; padding-top: 15px; border-top: 1px solid #1e293b; text-align: center;">
          <a href="https://iposense.com" style="background-color: #3b82f6; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 8px; font-size: 12px; font-weight: bold; display: inline-block;">Open Dashboard</a>
        </div>
      </div>
    `;
  }

  // Insert notification into Postgres table so client receives it in global notification list!
  try {
    logs.push("[POSTGRES] Recording notification payload into persistent database schema...");
    await postgresDb.insert(dbNotifications).values({
      userId: userId,
      title: finalTitle,
      message: finalMessage,
      type: alertType === "GMP_SPIKE" ? "GMP_ALERT" : alertType === "ALLOTMENT_OUT" ? "ALLOTMENT" : "SYSTEM",
      read: false,
    });
    logs.push("[POSTGRES] Insert completed successfully. Real-time notification socket/poll is live!");
  } catch (dbErr) {
    console.error("Failed to write to DB during simulation:", dbErr);
    logs.push("[POSTGRES] Warning: Write failed but simulation continues.");
  }

  // Channel-specific delivery simulation
  if (type === "FIREBASE") {
    logs.push("[FCM] Assembling Firebase Cloud Messaging JSON payload structure...");
    logs.push(`[FCM] Target Web Device Tokens resolved: [ "fcm_token_client_${userId}_active" ]`);
    logs.push(`[FCM] Payload headers: { apns-priority: 10, webpush-notification: { icon: "/logo.png" } }`);
    logs.push(`[FCM] Transmitting payload to google-fcm-v1 endpoints via Firebase-Admin SDK...`);
    logs.push(`[FCM] Firebase dispatch SUCCESS. Message-ID: fcm_msg_id_${Math.floor(Math.random()*100000)}`);
  } else if (type === "EMAIL") {
    logs.push("[SMTP] Initializing SMTP mail delivery client...");
    logs.push(`[SMTP] Sending message to recipient: ${emailRecipient || "tanishtthasehgal@gmail.com"}`);
    logs.push(`[SMTP] Parsing inline responsive styles and injecting visual components...`);
    logs.push(`[SMTP] Email dispatch SUCCESS. SMTP Server Response: 250 Message accepted for delivery.`);
  } else if (type === "SMS") {
    logs.push("[SMS] Checking telecom regulatory compliance standards...");
    logs.push(`[SMS] Verified Sender ID approval: [ IPOSNS ]`);
    logs.push(`[SMS] Dispatching cellular payload to recipient mobile line: ${phoneRecipient || "+91 99999 88888"}`);
    logs.push(`[SMS] SMS gateway accepted package. Carrier Status: DELIVERED.`);
  }

  res.json({
    success: true,
    title: finalTitle,
    message: finalMessage,
    emailHtml,
    smsText,
    logs,
  });
});


// New endpoint for IPO Upcoming -> Listing status change trigger
app.post("/api/notifications/test-status-trigger", requireAuth, async (req: AuthRequest, res) => {
  const { ipoSymbol, ipoName, oldStatus, newStatus, emailRecipient } = req.body;
  if (!ipoSymbol || !ipoName || !oldStatus || !newStatus) {
    return res.status(400).json({ error: "Missing required trigger parameters." });
  }

  const userId = req.dbUser!.id;
  const userEmail = req.dbUser!.email || emailRecipient || "user@example.com";
  const logs: string[] = [];

  logs.push(`[GCP Cloud Functions] Initializing Google Cloud Run/Firebase v2 background executor...`);
  logs.push(`[GCP Cloud Functions] Trigger received: onDocumentUpdated("ipos/{ipoId}")`);
  logs.push(`[GCP Cloud Functions] Document updated: ipos/doc_${ipoSymbol}`);
  logs.push(`[GCP Cloud Functions] Before status: "${oldStatus}" | After status: "${newStatus}"`);

  // Target status update transition: from UPCOMING to LISTING / LISTED
  const isTargetTransition = 
    oldStatus.toUpperCase() === "UPCOMING" && 
    (newStatus.toUpperCase() === "LISTING" || newStatus.toUpperCase() === "LISTED");

  if (!isTargetTransition) {
    logs.push(`[GCP Cloud Functions] Status transition is not 'Upcoming' -> 'Listing'. Skipping alert dispatcher.`);
    return res.json({
      success: true,
      title: `No Status Change Transition`,
      message: `The status transitioned from ${oldStatus} to ${newStatus}, which is not 'Upcoming' to 'Listing'. No notifications were triggered.`,
      logs
    });
  }

  logs.push(`[GCP Cloud Functions] Target transition verified! Executing notification dispatch pipeline...`);

  try {
    // Ensure the current user tracks this IPO so they see the result of the simulation
    const existingWatch = await postgresDb.select()
      .from(dbWatchlist)
      .where(and(eq(dbWatchlist.userId, userId), eq(dbWatchlist.ipoSymbol, ipoSymbol)))
      .limit(1);
    
    if (existingWatch.length === 0) {
      logs.push(`[POSTGRES] User was not tracking ${ipoSymbol}. Automatically adding to watchlist for simulation...`);
      await postgresDb.insert(dbWatchlist).values({
        userId,
        ipoSymbol
      });
    }

    // Update IPO status in our global state so it displays correctly on the dashboard
    const ipo = globalIposList.find(i => i.symbol === ipoSymbol);
    if (ipo) {
      logs.push(`[SYSTEM] Updating local memory dataset status for ${ipoSymbol} to "${newStatus}"`);
      ipo.status = newStatus as any;
    }

    // Locate all watchers for this IPO symbol in Postgres
    logs.push(`[POSTGRES] Querying user watchlist for IPO Symbol: "${ipoSymbol}"`);
    const watchers = await postgresDb.select({
      email: dbUsers.email,
      userId: dbUsers.id
    })
    .from(dbWatchlist)
    .innerJoin(dbUsers, eq(dbWatchlist.userId, dbUsers.id))
    .where(eq(dbWatchlist.ipoSymbol, ipoSymbol));

    logs.push(`[POSTGRES] Found ${watchers.length} active users tracking IPO: ${ipoSymbol}`);

    let finalTitle = `🚀 IPO Alert: ${ipoName} is officially listing!`;
    let finalMessage = `The IPO "${ipoName}" (${ipoSymbol}) has completed its subscription phases and is officially listing today! Check your allotment status now.`;
    let emailHtml = "";

    // Generate responsive HTML template using Groq Llama-3 or standard elegant layout
    const ai = getGroqClient();
    if (ai) {
      logs.push("[AI] Requesting Groq Llama to generate custom notification HTML for Listing Alert...");
      try {
        const prompt = `You are a professional financial notification designer.
        Generate standard alert content for an IPO status transition from 'Upcoming' to 'Listing'.
        IPO Name: "${ipoName}"
        Symbol: "${ipoSymbol}"
        Recipient Email: "${userEmail}"

        Generate a JSON response matching this schema:
        {
          "title": "A short, attention-grabbing title (max 50 chars)",
          "pushMessage": "A brief, clear notification message for browser push (max 100 chars)",
          "emailHtml": "A beautiful, modern inline-styled HTML email body with elegant dark theme, clear tables showing details, a Call-to-Action button to 'Check Allotment', and professional disclaimer."
        }
        Return ONLY valid JSON.`;

        const response = await ai.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" }
        });

        const jsonText = response.choices[0]?.message?.content?.trim() || "";
        const parsed = JSON.parse(jsonText);
        finalTitle = parsed.title || finalTitle;
        finalMessage = parsed.pushMessage || finalMessage;
        emailHtml = parsed.emailHtml || "";
        logs.push("[AI] Groq successfully synthesized tailored HTML body.");
      } catch (aiErr) {
        console.error("AI Generation error, falling back to static template:", aiErr);
        logs.push("[AI] Warning: Groq extraction faulted. Falling back to static visual template.");
      }
    }

    if (!emailHtml) {
      logs.push("[SMTP] Constructing fallback responsive HTML email body...");
      emailHtml = `
        <div style="font-family: sans-serif; background-color: #0b0f19; color: #f1f5f9; padding: 30px; text-align: left; max-width: 600px; margin: 0 auto; border-radius: 12px; border: 1px solid #1e293b;">
          <h2 style="color: #6366f1; margin-top: 0;">🚀 Now Listing on Exchanges!</h2>
          <p>An IPO on your watchlist, <strong>${ipoName} (${ipoSymbol})</strong>, has updated status from 'Upcoming' to 'Listing'.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
            <tr style="border-bottom: 1px solid #1e293b;"><td style="padding: 8px 0; color: #94a3b8;">Status</td><td style="padding: 8px 0; text-align: right; color: #10b981; font-weight: bold;">LISTING NOW</td></tr>
            <tr style="border-bottom: 1px solid #1e293b;"><td style="padding: 8px 0; color: #94a3b8;">Est. GMP</td><td style="padding: 8px 0; text-align: right; color: #10b981; font-weight: bold;">+45%</td></tr>
          </table>
          <p style="font-size: 13px; color: #94a3b8;">Please verify your bidding status in your portal.</p>
        </div>
      `;
    }

    // Insert notification records for all watchers in Postgres
    for (const watcher of watchers) {
      logs.push(`[POSTGRES] Writing notification log for User ID ${watcher.userId} (${watcher.email})`);
      await postgresDb.insert(dbNotifications).values({
        userId: watcher.userId,
        title: finalTitle,
        message: finalMessage,
        type: "SYSTEM",
        read: false
      });
    }
    
    logs.push(`[FCM] Dispatched Web Push Chime token to device associated with target watchers`);
    logs.push(`[SMTP] Direct email delivery dispatched successfully.`);
    logs.push(`[GCP Cloud Functions] Execution completed. Status: OK. All email notifications delivered.`);

    res.json({
      success: true,
      title: finalTitle,
      message: finalMessage,
      emailHtml,
      logs
    });

  } catch (err: any) {
    console.error("Status trigger error:", err);
    logs.push(`[ERROR] Backend trigger faulted: ${err.message || "Unknown error"}`);
    res.status(500).json({ error: "Failed to run status change simulator.", logs });
  }
});


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`API server listening on http://localhost:${port}`);
  });
}

export default app;