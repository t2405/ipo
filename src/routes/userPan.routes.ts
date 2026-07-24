import express from "express";
import { requireAuth } from "../middleware/auth";
import {
  getUserPan,
  saveUserPan,
} from "../controllers/userPan.controller";

const router = express.Router();

router.get("/user/pan", requireAuth, getUserPan);
router.post("/user/pan", requireAuth, saveUserPan);

export default router;
