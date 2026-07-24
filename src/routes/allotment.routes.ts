import { Router, Request, Response } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
import { db } from "../db";
import { allotmentChecks } from "../db/schema";
import { eq, desc, and } from "drizzle-orm";
import {
  getKfintechList,
  checkKfintechAllotment,
  getMufgList,
  checkMufgAllotment,
} from "../controllers/allotment.controller";

export const getAllotmentHistory = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.dbUser?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const history = await db
      .select()
      .from(allotmentChecks)
      .where(eq(allotmentChecks.userId, userId))
      .orderBy(desc(allotmentChecks.createdAt));

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch allotment history" });
  }
};

export const deleteAllotmentHistory = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.dbUser?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await db
      .delete(allotmentChecks)
      .where(
        and(
          eq(allotmentChecks.id, Number(req.params.id)),
          eq(allotmentChecks.userId, userId)
        )
      );

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: "Failed to delete allotment history" });
  }
};

router.get("/allotment/kfintech/list", getKfintechList);
router.post("/allotment/kfintech/check", requireAuth, checkKfintechAllotment);

router.get("/allotment/mufg/list", getMufgList);
router.post("/allotment/mufg/check", requireAuth, checkMufgAllotment);

router.get("/allotment/history", requireAuth, getAllotmentHistory);
router.delete("/allotment/history/:id", requireAuth, deleteAllotmentHistory);

export default router;
