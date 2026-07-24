export interface IPOFinancial {
  year: string;
  revenue: number; // in Cr
  profit: number;  // in Cr
  debt: number;    // in Cr
}

export interface IPO {
  id: string;
  name: string;
  symbol: string;
  companyName?: string;
  logo?: string;
  priceBand: string; // e.g. "₹250 - ₹265"
  minPrice: number;
  maxPrice: number;
  lotSize: number;
  issueSize: string; // e.g. "₹4,500 Cr"
  openDate: string;
  closeDate: string;
  listingDate: string;
  registrar: string;
  leadManagers: string[];
  retailQuota: number; // %
  qibQuota: number;    // %
  hniQuota: number;    // %
  promoterHoldingBefore: number; // %
  promoterHoldingAfter: number;  // %
  gmp: number; // Grey Market Premium in ₹
  gmpPercent: number; // % GMP gain
  subscriptionOverall: number; // x times
  subscriptionRetail: number; // x times
  subscriptionQib: number; // x times
  subscriptionHni: number; // x times
  aiScore: number; // 0-100
  aiConfidence: number; // 0-100
  riskScore: number; // 0-100
  recommendation: 'APPLY' | 'AVOID' | 'MODERATE';
  industry: string;
  competitors: string[];
  strengths: string[];
  risks: string[];
  objectOfIssue: string;
  financials: IPOFinancial[];
  status: 'UPCOMING' | 'ACTIVE' | 'CLOSED' | 'ALLOTMENT_OUT' | 'LISTED';
  aiAnalysis?: any;
  aiSummary?: string;
  analysis?: any;
}

export interface Application {
  id: string;
  ipoId: string;
  ipoName: string;
  pan: string;
  appNumber: string;
  broker: string;
  upiId: string;
  category: 'RETAIL' | 'HNI' | 'EMPLOYEE' | 'SHAREHOLDER';
  applicationDate: string;
  investmentAmount: number;
  lots: number;
  status: 'APPLIED' | 'ALLOTTED' | 'NOT_ALLOTTED' | 'REFUNDED';
  allottedLots: number;
  refundStatus: string;
}

export interface Message {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface ListingDayData {
  symbol: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  currentPrice: number;
  volume: number;
  vwap: number;
  rsi: number;
  macd: string; // e.g., "Bullish Crossover"
  support: number;
  resistance: number;
  institutionalBuying: 'HIGH' | 'MEDIUM' | 'LOW';
  retailSelling: 'HIGH' | 'MEDIUM' | 'LOW';
  aiRecommendation: 'SELL NOW' | 'HOLD' | 'BOOK PARTIAL' | 'EXIT' | 'BUY MORE';
  aiConfidence: number;
  reasoning: string;
  lastUpdated: string;
}

export interface PortfolioHolding {
  id: string;
  ipoId: string;
  ipoName?: string;
  symbol: string;
  companyName?: string;
  avgCost: number;
  quantity: number;
  currentPrice: number;
  status?: 'HELD' | 'SOLD';
  realizedPnL?: number;
}
