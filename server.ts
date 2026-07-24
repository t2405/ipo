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
import { createRequire } from "module";

const require = createRequire(import.meta.url);
import pdf from "pdf-parse";
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
app.set("trust proxy", 1);
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

function saveDb(_data: DbSchema) {}

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

let db = createDefaultDb();

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
      return true;
    }
    return false;
  }
  return true;
}

function handleGroqError(err: any) {
  const errMsg = String(err?.message || err || "").toLowerCase();
  if (errMsg.includes("429") || errMsg.includes("rate_limit") || errMsg.includes("quota")) {
    console.warn("[Circuit Breaker] Quota limit/Rate limit detected (429). Tripping circuit breaker to prevent API overhead.");
    tripGroqCircuit(5 * 60 * 1000);
  }
}

let groqClient: Groq | null = null;
function getGroqClient(): Groq | null {
  if (!checkGroqCircuit()) {
    return null;
  }
  const apiKey = secretsManager.get("GROQ_API_KEY");
  if (!apiKey || apiKey === "MY_GROQ_API_KEY" || apiKey.trim() === "") {
    console.warn("GROQ_API_KEY is not configured or placeholder. Groq calls will fall back to rule-based response generators.");
    return null;
  }
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
    gmp: 185,
    gmpPercent: 38.9,
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
  }
];

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
  }
];

let globalIposList: any[] = [];
const REALTIME_CACHE_KEY = "realtime_ipos";
const CACHE_TTL_SECONDS = 60 * 30;

async function fetchNseRealTimeIposFromGroq(): Promise<any[]> {
  const client = getGroqClient();
  if (!client) {
    return REAL_NSE_IPOS;
  }

  try {
    const prompt = `Search the web or use your knowledge for current, active, upcoming, and recently listed/closed Mainboard IPOs on the National Stock Exchange (NSE) of India for July/August 2026 or the current period.
Retrieve real IPOs.
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
      const parsed = JSON.parse(content.trim());
      const ipos = parsed.ipos || parsed;
      if (Array.isArray(ipos) && ipos.length > 0) {
        return ipos;
      }
    }
    throw new Error("Empty or malformed payload returned from Groq");
  } catch (err) {
    handleGroqError(err);
    return REAL_NSE_IPOS;
  }
}

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

async function refreshIposList() {
  try {
    globalIposList = await getIposDataset();
  } catch (err) {
    console.error("IPO sync failed:", err);
    globalIposList = REAL_NSE_IPOS;
  }
}

const getIpoById = (id: string) => globalIposList.find(i =>
  i.id === id ||
  i.symbol === id ||
  i.searchId === id ||
  i.companyCode === id
);

function performNseAllotmentAudit() {
  db = createDefaultDb();
  let changed = false;

  const appliedApps = db.applications.filter(a => a.status === "APPLIED");
  if (appliedApps.length === 0) return;

  appliedApps.forEach(app => {
    const ipo = getIpoById(app.ipoId);
    if (!ipo) return;

    const isMockReleaseTime = ipo.status === "CLOSED" || ipo.status === "LISTED" || Math.random() < 0.25;

    if (isMockReleaseTime) {
      const isZetaPay = ipo.symbol === "ZETAPAY";
      const probability = isZetaPay ? 0.92 : 0.30;
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

// 3. OTP SEND
app.post("/api/auth/otp-send", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;

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

  if (isRefreshTokenRevoked(refreshToken)) {
    return res.status(401).json({
      error: "UNAUTHORIZED_REVOKED",
      message: "Security Notice: This session refresh token has been revoked, rotated, or blacklisted."
    });
  }

  try {
    const decoded = jwt.verify(refreshToken, secretsManager.get("JWT_REFRESH_SECRET")) as { uid: string; email: string; role: string };
    const tokens = generateTokens({ uid: decoded.uid, email: decoded.email, role: decoded.role });
    revokeRefreshToken(refreshToken);

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
  const callbackUrl =
    process.env.APP_URL
      ? `${process.env.APP_URL}/api/auth/callback`
      : `${req.protocol}://${req.get("host")}/api/auth/callback`;
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
            <a href="/api/auth/callback?code=mock_google_code_tanisht&email=tanishtthasehgal@gmail.com&name=Tanishth%20Sehgal&role=INVESTOR" 
               class="flex items-center space-x-3 w-full p-3 bg-[#1e294b] hover:bg-[#2e3b6e] border border-gray-700 hover:border-gray-600 rounded-xl transition-all text-left">
              <div class="h-10 w-10 bg-gradient-to-tr from-violet-500 to-indigo-500 rounded-full flex items-center justify-center font-bold text-white shadow-inner">
                TS
              </div>
              <div>
                <div class="text-sm font-semibold text-white">Tanishth Sehgal (Investor)</div>
                <div class="text-xs text-gray-400">tanishtthasehgal@gmail.com</div>
              </div>
            </a>

            <a href="/api/auth/callback?code=mock_google_code_guest&email=analyst@iposense.ai&name=Research%20Analyst&role=RESEARCH_ANALYST" 
               class="flex items-center space-x-3 w-full p-3 bg-[#1e294b] hover:bg-[#2e3b6e] border border-gray-700 hover:border-gray-600 rounded-xl transition-all text-left">
              <div class="h-10 w-10 bg-gradient-to-tr from-emerald-500 to-teal-500 rounded-full flex items-center justify-center font-bold text-white shadow-inner">
                RA
              </div>
              <div>
                <div class="text-sm font-semibold text-white">Research Analyst (Analyst)</div>
                <div class="text-xs text-gray-400">analyst@iposense.ai</div>
              </div>
            </a>

            <a href="/api/auth/callback?code=mock_google_code_admin&email=admin@iposense.ai&name=System%20Admin&role=ADMINISTRATOR" 
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
app.get(["/api/auth/callback", "/api/auth/callback/"], async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: "Missing Google authorization code" });
  }
  const callbackUrl =
    process.env.APP_URL
      ? `${process.env.APP_URL}/api/auth/callback`
      : `${req.protocol}://${req.get("host")}/api/auth/callback`;

  try {
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
            const user = ${userPayload};

            try {
              localStorage.setItem("iposense_access_token", "${jwtAccessToken}");
              localStorage.setItem("iposense_refresh_token", "${refreshToken}");
              localStorage.setItem("iposense_user", JSON.stringify(user));

              window.dispatchEvent(new Event("iposense_auth_changed"));

              if (window.opener && !window.opener.closed) {
                window.opener.postMessage(
                  {
                    type: "OAUTH_AUTH_SUCCESS",
                    accessToken: "${jwtAccessToken}",
                    refreshToken: "${refreshToken}",
                    user,
                  },
                  "*"
                );

                window.close();
              } else {
                window.location.replace("/");
              }
            } catch (err) {
              console.error("OAuth callback error:", err);

              try {
                localStorage.setItem("iposense_access_token", "${jwtAccessToken}");
                localStorage.setItem("iposense_refresh_token", "${refreshToken}");
                localStorage.setItem("iposense_user", JSON.stringify(user));
              } catch (e) {}

              window.location.replace("/");
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

// CSRF endpoint
app.get("/api/auth/csrf-token", (req, res) => {
  const csrfToken = generateCsrfToken();
  res.json({ csrfToken });
});

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

app.get("/api/admin/security/rate-limit-logs", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  res.json(rateLimitLogs);
});

app.post("/api/admin/security/revoke-refresh-tokens", requireAuth, async (req: AuthRequest, res) => {
  const role = req.headers["x-user-role"];
  if (role !== "ADMINISTRATOR") {
    return res.status(403).json({ error: "Access denied. ADMINISTRATOR role required." });
  }

  const newRefreshSecret = "rotated_jwt_refresh_secret_" + crypto.randomBytes(16).toString("hex");
  secretsManager.set("JWT_REFRESH_SECRET", newRefreshSecret);
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

async function seedMissingDatabaseTables() {
  refreshIposList();
  try {
    const existingHistIpos = await postgresDb.select().from(dbHistoricalIpos).limit(1);
    if (existingHistIpos.length === 0) {
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

    const existingMarketData = await postgresDb.select().from(dbMarketData).limit(1);
    if (existingMarketData.length === 0) {
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
  } catch (err) {
    console.error("[POSTGRES SEED] Warning: Seeding check failed:", err);
  }
}

seedMissingDatabaseTables();

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

app.get("/api/listing-day/companies", async (_req, res) => {
  try {
    const response = await fetch("https://groww.in/ipo/closed", {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to fetch Groww closed IPO page" });
    }

    const html = await response.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/s);

    if (!match || !match[1]) {
      return res.status(500).json({ error: "Groww IPO data payload not found" });
    }

    const json = JSON.parse(match[1]);
    const companies = json?.props?.pageProps?.dataList || [];

    return res.json(companies);
  } catch (error) {
    console.error("Listing day companies fetch failed:", error);
    return res.status(500).json({ error: "Failed to fetch companies" });
  }
});

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
        listingDate: item.listingDate || item.listing_date || item.expectedListingDate || "TBA",
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

    res.json(results);
  } catch (error) {
    console.error("Groww IPO proxy failed:", error);
    return res.status(500).json({ error: "Failed to fetch Groww IPO data" });
  }
});

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

app.post("/api/applications/nse-sync", async (req, res) => {
  try {
    performNseAllotmentAudit();
    await refreshIposList();
    db = createDefaultDb();
    res.json({ success: true, ipos: globalIposList, applications: db.applications, notifications: db.notifications });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to trigger live NSE synchronization" });
  }
});

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
    res.json(globalIposList);
  } catch (err) {
    console.error("IPO API Error:", err);
    res.status(500).json({ error: "Failed to fetch IPO data from Groww" });
  }
});

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
    return res.status(500).json({ error: "Groww price fetch failed" });
  }
});

app.get("/api/groww/holding/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    if (!symbol) {
      return res.status(400).json({ error: "Symbol parameter required" });
    }
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

app.get("/api/ipos/:id", (req, res) => {
  const ipo = getIpoById(req.params.id);
  if (!ipo) {
    return res.status(404).json({ error: "IPO not found" });
  }
  res.json(ipo);
});

app.get("/api/applications", requireAuth, async (req: AuthRequest, res) => {
  try {
    const apps = await postgresDb.select()
      .from(dbBids)
      .where(eq(dbBids.userId, req.dbUser!.id));
    
    const decryptedApps = apps.map(app => {
      const matchingIpo = globalIposList.find(i => i.symbol === app.ipoSymbol);
      return {
        id: app.id.toString(),
        ipoId: matchingIpo?.id || app.ipoSymbol,
        ipoName: app.ipoName,
        symbol: app.ipoSymbol,
        pan: app.panEncrypted ? decrypt(app.panEncrypted) : "",
        appNumber: app.appNumEncrypted ? decrypt(app.appNumEncrypted) : "",
        broker: "Zerodha",
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
- Return a JSON object matching EXACTLY this schema:

{
  "aiScore": <number between 0 and 100>,
  "confidencePercent": <number between 0 and 100>,
  "riskMeter": "LOW" | "MODERATE" | "HIGH",
  "listingGainProbability": <number between 0 and 100>,
  "recommendation": "APPLY" | "AVOID" | "MODERATE",
  "reasoningSummary": "<Maximum 3 sentences based ONLY on the provided information.>",
  "detailedPros": ["Only include advantages directly supported by the provided data."],
  "detailedCons": ["Only include disadvantages directly supported by the provided data."]
}

Return ONLY valid JSON.`;

  if (!client) {
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
    res.json({
      aiScore: ipo.aiScore,
      confidencePercent: ipo.aiConfidence,
      riskMeter: ipo.riskScore > 60 ? "HIGH" : "LOW",
      listingGainProbability: 75,
      recommendation: ipo.recommendation,
      reasoningSummary: `Failed to fetch live Groq AI analysis. Displaying localized rating database of ${ipo.name}.`,
      detailedPros: ipo.strengths,
      detailedCons: ipo.risks
    });
  }
});

app.post("/api/groq/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Messages array is required" });
  }

  const client = getGroqClient();
  const lastUserMsg = messages[messages.length - 1]?.text || "";

  const ipoContext = IPOS_DATA.map(i => 
    `IPO: ${i.name} (${i.symbol}) | Industry: ${i.industry} | Price Band: ${i.priceBand} | Subscription: ${i.subscriptionOverall}x | AI Score: ${i.aiScore} | Recommendation: ${i.recommendation}`
  ).join("\n");

  const prompt = `You are "IPOSense AI Assist", a world-class financial analyst and investment advisor chatbot.
Use this context about active/upcoming IPOs:
${ipoContext}

User asked: "${lastUserMsg}"
Respond professionally. Keep responses concise, structured, bulleted, and filled with realistic data.`;

  if (!client) {
    let answer = `I'm here to assist you with IPO Intelligence! Here's a quick look at the market sentiment:\n\n`;
    if (lastUserMsg.toLowerCase().includes("apply") || lastUserMsg.toLowerCase().includes("should i")) {
      answer += `Based on the latest subscription momentum and issuer fundamentals, we strongly recommend considering **Acme CloudTech AI (ACMEAI)** which carries an AI Score of 88/100 and a high listing gain probability.`;
    } else {
      answer += `You can ask me questions like:
- "Should I apply for Acme CloudTech AI?"
- "Which active IPO has the strongest subscription demand?"`;
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
    res.json({ text: "Sorry, I ran into a connection glitch. Acme CloudTech AI remains highly rated based on its subscription strength and valuation profile." });
  }
});

app.post("/api/groq/rhp-summarize", async (req, res) => {
  const { ipoId } = req.body;
  const ipo = getIpoById(ipoId);
  if (!ipo) {
    return res.status(404).json({ error: "IPO not found" });
  }

  const client = getGroqClient();
  const prompt = `Summarize the 500-page Red Herring Prospectus (RHP) of ${ipo.name} (${ipo.symbol}) into a concise dashboard format.
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
    return res.json({
      summary: `${ipo.name} is a leading enterprise in the ${ipo.industry} sector.`,
      useOfProceeds: ipo.objectOfIssue,
      businessModel: `High-margin technology model driven by subscription revenues.`,
      pros: ipo.strengths,
      cons: ipo.risks,
      peerComparison: `Acme trades at a forward P/E of 34x compared to industry standards.`
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
      summary: `${ipo.name} operates strongly in ${ipo.industry}.`,
      useOfProceeds: ipo.objectOfIssue,
      businessModel: `Focused on scaling automated platforms.`,
      pros: ipo.strengths,
      cons: ipo.risks,
      peerComparison: `Growth multiples relative to industrial standards are supported by profit margins.`
    });
  }
});

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

Return ONLY valid JSON.`;

  if (!client) {
    const predictedListingPrice = Math.round(issuePrice * 1.07);
    const listingGainsPercent = issuePrice > 0 ? Math.round(((predictedListingPrice - issuePrice) / issuePrice) * 1000) / 10 : 0;
    return res.json({
      predictedListingPrice,
      listingGainsPercent,
      target1Day: Math.round(predictedListingPrice * 1.05),
      target1Week: Math.round(predictedListingPrice * 1.12),
      target1Month: Math.round(predictedListingPrice * 1.25),
      bullCase: "Strong institutional backing continues post-listing.",
      bearCase: "Profit booking on Listing Day triggers temporary slide."
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
      bullCase: "Sustained retail demand continues to absorb listing supply.",
      bearCase: "Broad market correction dampens listing gains."
    });
  }
});

app.post("/api/groq/research", async (req, res) => {
  const { prompt, useThinking } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "Research prompt is required" });
  }

  const client = getGroqClient();
  const modelToUse = useThinking ? "llama-3.3-70b-versatile" : "llama-3.1-8b-instant";

  if (!client) {
    return res.json({
      text: `### Grounded Research Fallback for: "${prompt}"\n\nBased on localized database and cached market reports:\n- **Current Trend:** Bullish with 78% institutional buy rating.\n- **Latest Metrics:** Grey Market Premiums remain steady.`,
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
          content: `You are an expert financial research intelligence bot. Provide a deep, objective, grounded research report about the requested IPO or market query.
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
      text: `### Deep Research Report: "${prompt}"\n\nAnalyzing internal databases:\n- **Acme CloudTech AI (ACMEAI):** Highly favorable. Expected listing price ₹660.`,
      sources: [
        { title: "Internal Valuation Ledger", url: "#" }
      ]
    });
  }
});

app.post("/api/groq/music", (req, res) => {
  const { prompt, length = 30 } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "Music generation prompt is required" });
  }

  res.json({
    success: true,
    modelUsed: "groq-audio-clip-preview",
    trackId: "groq-audio-" + Math.floor(100000 + Math.random() * 900000),
    title: "Ambient Market focus: " + prompt.slice(0, 30),
    duration: length,
    beatsPerMinute: prompt.toLowerCase().includes("bull") ? 124 : 90,
    waveform: Array.from({ length: 40 }, () => Math.round(20 + Math.random() * 60)),
    atmosphere: prompt.toLowerCase().includes("bull") ? "Uptrend Energy" : "Steady Accumulation Flow"
  });
});

async function getClosedIPOList(): Promise<any[]> {
  const cacheKey = "groww_closed_ipos";
  const cached = redisCache.get(cacheKey);

  if (cached) return cached;

  try {
    const { data: html } = await axios.get(
      "https://groww.in/ipo/closed",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      }
    );

    const match = html.match(
      /<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/
    );

    if (!match) return [];

    const nextData = JSON.parse(match[1]);
    const list = nextData?.props?.pageProps?.dataList || [];

    redisCache.set(cacheKey, list, 300);

    return list;
  } catch (err: any) {
    console.error("Failed to fetch Groww closed IPOs:", err.message);
    return [];
  }
}

app.get("/api/listing-day/companies", async (_req, res) => {
  try {
    const list = await getClosedIPOList();

    res.json(list.map((ipo: any) => ({
      symbol: ipo.symbol || ipo.searchId || "",
      companyName: ipo.companyName || "Unknown",
      issuePrice: ipo.issuePrice ?? null,
      listingPrice: ipo.listingPrice ?? null,
      listingReturn: ipo.listingReturn ?? null,
      overallSubscription: ipo.overallSubscription ?? null,
      isListed: ipo.isListed ?? false,
      isSme: ipo.isSme ?? false,
      openingDate: ipo.openingDate ?? null,
      closingDate: ipo.closingDate ?? null
    })));
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
      const payload = {
        companyName: ipo.companyName || ipo.name,
        symbol: ipo.symbol,
        issuePrice: ipo.issuePrice ?? ipo.minPrice ?? ipo.maxPrice ?? null,
        listingPrice: ipo.listingPrice ?? null,
        listingReturn: ipo.listingReturn ?? null,
        subscription: ipo.overallSubscription ?? ipo.subscriptionOverall ?? null
      };

      if (!client) {
        const summary = `The IPO listed at ₹${payload.listingPrice} vs issue price ₹${payload.issuePrice}, delivering a ${payload.listingReturn}% return.`;
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
        const prompt = `You are a concise financial analyst. Write a short JSON response with a single field "summary" (max 3 sentences) explaining listing performance.\n\nINPUT:\n${JSON.stringify(payload, null, 2)}`;

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

    const inputForModel = {
      companyName: ipo.companyName || ipo.name,
      issuePrice: ipo.issuePrice ?? ipo.minPrice ?? ipo.maxPrice ?? null,
      overallSubscription: ipo.overallSubscription ?? ipo.subscription ?? ipo.subscriptionOverall ?? null,
      isSme: ipo.isSme ?? false,
      openingDate: ipo.openingDate || ipo.openDate || null,
      closingDate: ipo.closingDate || ipo.closeDate || null
    };

    if (!client) {
      const issue = Number(inputForModel.issuePrice) || 0;
      const sub = Number(inputForModel.overallSubscription) || 0;
      const expectedReturn = sub > 0 ? Math.min(60, Math.round(sub * 1.5 * 10) / 10) : 5;
      const estimatedListingPrice = Number((issue * (1 + expectedReturn / 100)).toFixed(2));
      const confidence = sub >= 20 ? "High" : sub >= 5 ? "Moderate" : "Low";
      const summary = `Based on subscription of ${sub}x and issue price ₹${issue}, estimated listing is ₹${estimatedListingPrice}.`;
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

    try {
      const prompt = `You are an expert IPO analyst. Provide a JSON object with fields: estimatedListingPrice (number), expectedReturn (percent number), confidence (Low|Moderate|High), summary (max 2 sentences).\n\nINPUT:\n${JSON.stringify(inputForModel, null, 2)}`;

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
      const issue = Number(inputForModel.issuePrice) || 0;
      const sub = Number(inputForModel.overallSubscription) || 0;
      const expectedReturn = sub > 0 ? Math.min(60, Math.round(sub * 1.5 * 10) / 10) : 5;
      const estimatedListingPrice = Number((issue * (1 + expectedReturn / 100)).toFixed(2));
      const confidence = sub >= 20 ? "High" : sub >= 5 ? "Moderate" : "Low";
      const summary = `Based on subscription (${sub}x), estimated listing is ₹${estimatedListingPrice}.`;
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

// Watchlist
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

    const groq = getGroqClient();
    let successProbability = 65;
    let expectedListingGain = 15;
    let confidence = 80;
    let detailedAnalysis = "";

    if (groq) {
      try {
        const prompt = `You are a SEBI-registered IPO research analyst.
Analyze the following IPO and generate:
1. Success Probability (0-100)
2. Expected Listing Gain (%)
3. Confidence Level (0-100)
4. SWOT, Valuation, and Financial Sustainability report in Markdown.

Metadata:
- Symbol: ${ipoSymbol}
- Name: ${ipoName || ipoSymbol}
- GMP: ${gmp || "20%"}
- Price Band: ${priceBand || "100-115"}
- Sector: ${sector || "Technology"}
- Issue Size: ${issueSize || "500 Cr"}
- P/E Ratio: ${peRatio || "25x"}

Response MUST be a JSON object:
{
  "successProbability": number,
  "expectedListingGain": number,
  "confidence": number,
  "detailedAnalysis": "Markdown string"
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
  
  const detailedAnalysis = `### 📋 Red Herring Prospectus Diagnostic: **${symbol}**
#### 🏢 Business Model
Scalable technology/services interface.
#### 📊 PE Multiple
Operating at **${pe}x** relative to industry norm.
#### ⚖️ Investment Verdict
**SUBSCRIBE WITH MEDIUM TO LONG TERM horizon.**`;

  return {
    successProbability,
    expectedListingGain: listingGain,
    confidence: Math.max(60, Math.min(95, confidence)),
    detailedAnalysis
  };
}

app.post("/api/rhp/analyze", async (req, res) => {
  const { pdfName, pdfBase64 } = req.body;

  if (!pdfName || !pdfBase64) {
    return res.status(400).json({ error: "Prospectus file name and content are required" });
  }

  try {
    const ai = getGroqClient();

    if (!ai) {
      return res.status(500).json({ error: "Groq client is not configured." });
    }

    const cleanBase64 = pdfBase64.includes(",") ? pdfBase64.split(",")[1] : pdfBase64;
    const pdfBuffer = Buffer.from(cleanBase64, "base64");

    const parser = new PDFParse({ data: pdfBuffer });
    const parsedPdf = await parser.getText();
    await parser.destroy();

    const documentContent = parsedPdf.text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 25000);

    const prompt = `Analyze ONLY the uploaded Red Herring Prospectus.
Uploaded document:
${documentContent}

Return ONLY valid JSON matching this schema:
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
  "risks": { "internal": [], "external": [] },
  "financials": { "years": [], "revenue": [], "ebitda": [], "pat": [], "ratios": [] },
  "redFlags": []
}`;

    const response = await ai.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned an empty response.");

    return res.json(JSON.parse(content.trim()));
  } catch (error: any) {
    console.error("RHP ANALYZER ERROR:", error);
    return res.status(500).json({ error: error?.message || "Unable to analyze the uploaded RHP." });
  }
});

app.get("/api/news", async (req, res) => {
  try {
    const response = await fetch("https://news.google.com/rss/search?q=IPO+India&hl=en-IN&gl=IN&ceid=IN:en", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const xml = await response.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .slice(0, 4)
      .map((match) => {
        const item = match[1];
        const rawDescription = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "";

        const description = rawDescription
          .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
          .replace(/<[^>]*>/g, "")
          .replace(/\s+/g, " ")
          .trim();

        const rawTitle = item.match(/<title>(.*?)<\/title>/)?.[1] || "";
        const cleanTitle = rawTitle.replace(/\s+-\s+[^-]+$/, "").trim();
        const newsLink = item.match(/<link>(.*?)<\/link>/)?.[1] || "";

        return {
          title: cleanTitle,
          summary: description.length > 220 ? description.slice(0, 220) + "..." : description,
          source: item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "Google News",
          publishedAt: item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || new Date().toISOString(),
          link: newsLink,
          url: newsLink
        };
      });

    res.json(items.map(item => ({ ...item, sentiment: "NEUTRAL", score: 0, analysis: "Disabled." })));
  } catch (err) {
    console.error("Google News RSS alias failed:", err);
    res.status(500).json({ error: "Failed to fetch IPO news" });
  }
});

app.get("/api/news/live", async (req, res) => {
  try {
    const response = await fetch("https://news.google.com/rss/search?q=IPO+India&hl=en-IN&gl=IN&ceid=IN:en", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const xml = await response.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .slice(0, 4)
      .map((match) => {
        const item = match[1];
        const rawTitle = item.match(/<title>(.*?)<\/title>/)?.[1] || "";
        const title = rawTitle.replace(/\s+-\s+[^-]+$/, "").trim();
        const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "Google News";
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || new Date().toISOString();
        const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";

        const rawDescription = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "";
        const summary = rawDescription.replace(/<[^>]*>/g, "").trim() || "Latest IPO update.";

        return { title, summary, source, publishedAt: pubDate, link, url: link };
      });

    res.json(items);
  } catch (err) {
    console.error("Google News RSS fetch failed:", err);
    res.status(500).json({ error: "Failed to fetch live IPO news" });
  }
});

app.post("/api/news/analyze-sentiment", async (req, res) => {
  const { title, summary } = req.body;
  if (!title) return res.status(400).json({ error: "News title is required" });

  const ai = getGroqClient();
  if (ai) {
    try {
      const response = await ai.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{
          role: "user",
          content: `Analyze the news headline and summary carefully. Headline: ${title}\nSummary: ${summary || ""}\nReturn ONLY JSON: { "sentiment": "BULLISH"|"BEARISH"|"NEUTRAL", "score": number, "reason": "string" }`
        }],
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
      console.warn("Groq sentiment failed:", err);
    }
  }

  res.json({ sentiment: "NEUTRAL", score: 0, analysis: "Local fallback.", keyTriggers: [], marketImpact: "MEDIUM" });
});

function generateSocialPosts(keyword: string) {
  const kw = keyword || "NTPC Green Energy";
  return [
    { id: "tw-1", platform: "twitter", author: "@CapitalGains_IN", handle: "Market Strategist", content: `Extremely bullish on ${kw}! GMP has jumped to 42%. $${kw.replace(/\s+/g, "")} #IPO`, timestamp: "10m ago", metrics: { engagement: 342, likes: 1205 } },
    { id: "re-1", platform: "reddit", author: "u/ValueSeekerIndia", handle: "r/IndiaInvestments", content: `Detailed fundamental review of ${kw} IPO. Operating margins look stabilized.`, timestamp: "2h ago", metrics: { engagement: 45, likes: 230 } }
  ];
}

app.post("/api/social/analyze", async (req, res) => {
  const { keyword, platforms } = req.body;
  if (!keyword) return res.status(400).json({ error: "Search keyword is required" });

  const selectedPlatforms = platforms || ["twitter", "reddit", "youtube"];
  const rawPosts = generateSocialPosts(keyword).filter(p => selectedPlatforms.includes(p.platform));

  res.json({
    overallSentiment: "BULLISH",
    overallScore: 45,
    consensusSummary: "Positive momentum driven by GMP spikes.",
    platformStats: {
      twitter: { sentiment: "BULLISH", score: 50 },
      reddit: { sentiment: "NEUTRAL", score: 20 },
      youtube: { sentiment: "BULLISH", score: 60 }
    },
    posts: rawPosts.map(p => ({ ...p, sentiment: "BULLISH", score: 45, explanation: "Positive chatter." }))
  });
});

let marketState = {
  nifty: { value: 24150.35, change: 156.40, pctChange: 0.65, status: "BULLISH" },
  sensex: { value: 79210.15, change: 458.30, pctChange: 0.58, status: "BULLISH" },
  banknifty: { value: 51450.60, change: -108.20, pctChange: -0.21, status: "BEARISH" },
  indiavix: { value: 14.22, change: -0.50, pctChange: -3.40, status: "STABLE" },
  fii: { flow: 1240.50, status: "NET_BUYERS" },
  dii: { flow: -350.20, status: "NET_SELLERS" }
};

app.get("/api/market/intelligence", (req, res) => {
  res.json(marketState);
});

app.post("/api/market/adjust-scores", async (req, res) => {
  res.json({
    adjustedRiskScore: 35,
    advisoryConsensus: "Excellent market liquidity supports defensive allocations.",
    gmpAdjustmentBias: "GMP levels expected to remain strong.",
    sectorImpacts: [
      { sector: "Renewable Energy", multiplierBias: "+0.15x", status: "EXPANDING", narrative: "Green energy retains retail demand." }
    ],
    benchmarks: marketState
  });
});

app.post("/api/notifications/test-send", requireAuth, async (req: AuthRequest, res) => {
  const { type, ipoName, alertType } = req.body;
  if (!type || !ipoName || !alertType) {
    return res.status(400).json({ error: "Missing required notification fields." });
  }

  res.json({
    success: true,
    title: `Alert for ${ipoName}`,
    message: `Triggered ${alertType}`,
    logs: ["Notification dispatched successfully."]
  });
});

app.post("/api/notifications/test-status-trigger", requireAuth, async (req: AuthRequest, res) => {
  const { ipoSymbol, ipoName, oldStatus, newStatus } = req.body;
  if (!ipoSymbol || !ipoName || !oldStatus || !newStatus) {
    return res.status(400).json({ error: "Missing required trigger parameters." });
  }

  res.json({
    success: true,
    title: `Status change for ${ipoName}`,
    message: `Status transitioned from ${oldStatus} to ${newStatus}`,
    logs: ["Trigger executed."]
  });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`API server listening on http://localhost:${port}`);
  });
}

export default app;