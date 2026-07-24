import express from "express";

const router = express.Router();

const HEADERS = {
  "X-APP-ID": "growwWeb",
  "x-platform": "web",
};

const urls = {
  nifty:
    "https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/NIFTY",
  sensex:
    "https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/BSE/segment/CASH/latest_indices_ohlc/1",
  bankNifty:
    "https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/BANKNIFTY",
  indiaVix:
    "https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/INDIAVIX",
};

async function fetchMarketSnapshot() {
  const [nifty, sensex, bankNifty, indiaVix] = await Promise.all(
    Object.values(urls).map(async (url) => {
      const response = await fetch(url, { headers: HEADERS });
      const data = await response.json();
      return data.value;
    })
  );

  return {
    nifty,
    sensex,
    bankNifty,
    indiaVix,
    updatedAt: Date.now(),
  };
}

router.get("/market/indices", async (_req, res) => {
  try {
    const marketCache = await fetchMarketSnapshot();
    res.json(marketCache);
  } catch (error) {
    console.error("Market cache update failed:", error);
    res.status(500).json({ error: "Failed to fetch market indices." });
  }
});

export default router;