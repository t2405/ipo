import { Request, Response } from "express";
import { getUserPanByUserId, upsertUserPan } from "../services/userPan.service";
import { AuthRequest } from "../middleware/auth";

export async function getUserPan(req: AuthRequest, res: Response) {
  try {
    const pan = await getUserPanByUserId(req.dbUser!.id);
    res.json({ pan: pan || null });
  } catch (err) {
    console.error("GET /api/user/pan failed", err);
    res.status(500).json({ error: "Failed to load saved PAN" });
  }
}

export async function saveUserPan(req: AuthRequest, res: Response) {
  try {
    const { pan } = req.body;
    if (!pan || typeof pan !== "string") {
      return res.status(400).json({ error: "PAN is required" });
    }
    const normalized = pan.trim().toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(normalized)) {
      return res.status(400).json({ error: "PAN format is invalid" });
    }
    await upsertUserPan(req.dbUser!.id, normalized);
    res.json({ pan: normalized });
  } catch (err) {
    console.error("POST /api/user/pan failed", err);
    res.status(500).json({ error: "Failed to save PAN" });
  }
}
