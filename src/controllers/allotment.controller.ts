import { Request, Response } from "express";
import {
  getCachedKfintechIpoList,
  refreshKfintechIpoList,
  checkKfintechAllotmentStatus,
} from "../services/kfintech.service";
import {
  getCachedMufgIpoList,
  refreshMufgIpoList,
  checkMufgAllotmentStatus,
} from "../services/mufg.service";
import { AuthRequest } from "../middleware/auth";
import { db } from "../db/index";
import { allotmentChecks } from "../db/schema";
import { eq, desc } from "drizzle-orm";

export async function getKfintechList(req: AuthRequest, res: Response) {
  try {
    console.log('[API] GET /api/allotment/kfintech/list invoked - forcing refresh');
    // Force a fresh scrape on-demand to ensure latest registry is returned.
    const list = await refreshKfintechIpoList();
    res.json(list || []);
  } catch (err) {
    console.error("GET /api/allotment/kfintech/list failed", err);
    res.status(500).json({ error: "Failed to fetch KFintech IPO list" });
  }
}

export async function checkKfintechAllotment(req: AuthRequest, res: Response) {
  try {
    if (!req.dbUser?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { clientId, pan } = req.body;
    if (!clientId || !pan) {
      return res.status(400).json({ error: "clientId and pan are required" });
    }
    const result = await checkKfintechAllotmentStatus(clientId, pan);

    try {
      const saved = await db.insert(allotmentChecks).values({
        userId: req.dbUser!.id,
        provider: "kfintech",
        ipoId: clientId,
        ipoName: null,
        panEncrypted: pan,
        status: result?.response?.error || "CHECKED",
        response: JSON.stringify(result),
      });
      console.log("[ALLOTMENT SAVE] KFINTECH saved", saved);
    } catch (saveErr) {
      console.error("[ALLOTMENT SAVE] Failed", saveErr);
    }

    res.json(result);
  } catch (err) {
    console.error("POST /api/allotment/kfintech/check failed", err);
    res.status(500).json({ error: "Failed to check KFintech allotment" });
  }
}

export async function getMufgList(req: AuthRequest, res: Response) {
  try {
    const list = await getCachedMufgIpoList();
    res.json(list);
  } catch (err) {
    console.error("GET /api/allotment/mufg/list failed", err);
    res.status(500).json({ error: "Failed to fetch MUFG IPO list" });
  }
}

export async function checkMufgAllotment(req: AuthRequest, res: Response) {
  try {
    if (!req.dbUser?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { companyId, pan } = req.body;
    if (!companyId || !pan) {
      return res.status(400).json({ error: "companyId and pan are required" });
    }
    const result = await checkMufgAllotmentStatus(companyId, pan);

    try {
      const saved = await db.insert(allotmentChecks).values({
        userId: req.dbUser!.id,
        provider: "mufg",
        ipoId: companyId,
        ipoName: null,
        panEncrypted: pan,
        status: result?.response?.error || "CHECKED",
        response: JSON.stringify(result),
      });
      console.log("[ALLOTMENT SAVE] MUFG saved", saved);
    } catch (saveErr) {
      console.error("[ALLOTMENT SAVE] Failed", saveErr);
    }

    res.json(result);
  } catch (err) {
    console.error("POST /api/allotment/mufg/check failed", err);
    res.status(500).json({ error: "Failed to check MUFG allotment" });
  }
}

export async function getAllotmentHistory(req: AuthRequest, res: Response) {
  try {
    if (!req.dbUser?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const history = await db
      .select()
      .from(allotmentChecks)
      .where(eq(allotmentChecks.userId, req.dbUser!.id))
      .orderBy(desc(allotmentChecks.createdAt));

    res.json(history);
  } catch (err) {
    console.error("GET /api/allotment/history failed", err);
    res.status(500).json({ error: "Failed to fetch allotment history" });
  }
}

export async function deleteAllotmentHistory(req: AuthRequest, res: Response) {
  try {
    await db
      .delete(allotmentChecks)
      .where(eq(allotmentChecks.id, Number(req.params.id)));

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/allotment/history/:id failed", err);
    res.status(500).json({ error: "Failed to delete allotment history" });
  }
}
