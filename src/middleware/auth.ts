import { Request, Response, NextFunction } from "express";
import { adminAuth } from "../lib/firebase-admin.js";
import { db } from "../db/index.js";
import { users, userSettings, portfolioHoldings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { secretsManager } from "./security.js";

const getJwtSecret = () => secretsManager.get("JWT_SECRET");

export interface AuthRequest extends Request {
  user?: {
    uid: string;
    email: string;
  };
  dbUser?: {
    id: number;
    uid: string;
    email: string;
  };
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  console.log("[AUTH DEBUG] Authorization header present:", !!authHeader);
  const isGuestFallback = !authHeader || !authHeader.startsWith("Bearer ") || authHeader.split("Bearer ")[1] === "null" || authHeader.split("Bearer ")[1] === "undefined" || authHeader.split("Bearer ")[1].trim() === "";

  if (isGuestFallback) {
    // Falls back to global guest user in Postgres
    const guestUid = "GUEST_USER_DEFAULT";
    const guestEmail = "guest@iposense.com";
    req.user = {
      uid: guestUid,
      email: guestEmail,
    };

    try {
      let dbUserRecord = await db.query.users.findFirst({
        where: eq(users.uid, guestUid),
      });

      if (!dbUserRecord) {
        const result = await db.insert(users)
          .values({
            uid: guestUid,
            email: guestEmail,
          })
          .onConflictDoNothing()
          .returning();
        
        dbUserRecord = result[0] || await db.query.users.findFirst({
          where: eq(users.uid, guestUid),
        });

        if (dbUserRecord) {
          await db.insert(userSettings)
            .values({
              userId: dbUserRecord.id,
              gmpAlerts: true,
              allotmentAlerts: true,
              aiReports: true,
              riskAppetite: "Moderate",
            })
            .onConflictDoNothing();
        }
      }

      if (dbUserRecord) {
        req.dbUser = {
          id: dbUserRecord.id,
          uid: dbUserRecord.uid,
          email: dbUserRecord.email,
        };
      } else {
        return res.status(500).json({ error: "Failed to establish Guest database context" });
      }

      return next();
    } catch (dbErr) {
      console.error("Failed setting up guest fallback in Postgres:", dbErr);
      return res.status(500).json({ error: "Failed to establish Guest database context" });
    }
  }

  const token = authHeader.split("Bearer ")[1];

  // Try custom JWT verification first
  try {
    const customDecoded = jwt.verify(token, getJwtSecret()) as { uid: string; email: string; role?: string };
    console.log("[AUTH DEBUG] JWT decoded uid:", customDecoded.uid);
    if (customDecoded && customDecoded.uid) {
      req.user = {
        uid: customDecoded.uid,
        email: customDecoded.email,
      };

      let dbUserRecord = await db.query.users.findFirst({
        where: eq(users.uid, customDecoded.uid),
      });

      if (!dbUserRecord) {
        try {
          const result = await db.insert(users)
            .values({
              uid: customDecoded.uid,
              email: customDecoded.email,
              role: customDecoded.role || "INVESTOR",
            })
            .onConflictDoUpdate({
              target: users.uid,
              set: { email: customDecoded.email }
            })
            .returning();
          dbUserRecord = result[0];

          if (dbUserRecord) {
            await db.insert(userSettings)
              .values({
                userId: dbUserRecord.id,
                gmpAlerts: true,
                allotmentAlerts: true,
                aiReports: true,
                riskAppetite: "Moderate",
              })
              .onConflictDoNothing();
          }
        } catch (err) {
          console.error("Failed to register custom user in Postgres:", err);
          dbUserRecord = await db.query.users.findFirst({
            where: eq(users.uid, customDecoded.uid),
          });
        }
      }

      if (dbUserRecord) {
        console.log("[AUTH DEBUG] DB user found:", dbUserRecord.id, dbUserRecord.email);
        req.dbUser = {
          id: dbUserRecord.id,
          uid: dbUserRecord.uid,
          email: dbUserRecord.email,
        };
        // Inject role into request headers for RBAC
        req.headers["x-user-role"] = dbUserRecord.role;
      } else {
        return res.status(500).json({ error: "Failed to establish database user context" });
      }

      return next();
    }
  } catch (jwtErr) {
    if (jwtErr instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        error: "UNAUTHORIZED_EXPIRED",
        message: "JWT Access Token expired",
      });
    }

    // Only try Firebase verification if the token looks like a Firebase ID token.
    // Custom JWTs (three-part HS256 tokens issued by this backend) should not be
    // passed to Firebase Admin.
    const looksLikeFirebaseToken =
      token.split(".").length === 3 &&
      !token.includes("GOOGLE_UID_");

    if (!looksLikeFirebaseToken) {
      return res.status(401).json({
        error: "Unauthorized: Invalid access token",
      });
    }
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    const email = decodedToken.email || `${decodedToken.uid}@firebase.com`;
    
    req.user = {
      uid: decodedToken.uid,
      email: email,
    };

    // Synchronize / Register user in Postgres users table
    let dbUserRecord = await db.query.users.findFirst({
      where: eq(users.uid, decodedToken.uid),
    });

    if (!dbUserRecord) {
      try {
        // Concurrency safe registration
        const result = await db.insert(users)
          .values({
            uid: decodedToken.uid,
            email: email,
          })
          .onConflictDoUpdate({
            target: users.uid,
            set: { email: email }
          })
          .returning();
        
        dbUserRecord = result[0];

        // Also seed default user settings
        await db.insert(userSettings)
          .values({
            userId: dbUserRecord.id,
            gmpAlerts: true,
            allotmentAlerts: true,
            aiReports: true,
            riskAppetite: "Moderate",
          })
          .onConflictDoNothing();
      } catch (err) {
        console.error("Failed to register user in Postgres:", err);
        // Fallback retry
        dbUserRecord = await db.query.users.findFirst({
          where: eq(users.uid, decodedToken.uid),
        });
      }
    }

    if (dbUserRecord) {
      console.log("[AUTH DEBUG] Firebase DB user found:", dbUserRecord.id, dbUserRecord.email);
      req.dbUser = {
        id: dbUserRecord.id,
        uid: dbUserRecord.uid,
        email: dbUserRecord.email,
      };
      // Inject role into request headers for RBAC
      req.headers["x-user-role"] = dbUserRecord.role;
    } else {
      return res.status(500).json({ error: "Failed to establish database user context" });
    }

    next();
  } catch (error: any) {
    console.warn("Firebase token verification failed:", error?.message ?? error);
    return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
  }
};
