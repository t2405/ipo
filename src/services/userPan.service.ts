import { db as postgresDb } from "../db/index";
import { userPans } from "../db/schema";
import { eq } from "drizzle-orm";

export async function getUserPanByUserId(userId: number): Promise<string | null> {
  const rows = await postgresDb.select().from(userPans).where(eq(userPans.userId, userId)).limit(1);
  return rows.length > 0 ? rows[0].panEncrypted : null;
}

export async function upsertUserPan(userId: number, pan: string): Promise<void> {
  const existing = await postgresDb.select().from(userPans).where(eq(userPans.userId, userId)).limit(1);
  if (existing.length > 0) {
    await postgresDb.update(userPans).set({ panEncrypted: pan }).where(eq(userPans.userId, userId));
  } else {
    await postgresDb.insert(userPans).values({ userId, panEncrypted: pan });
  }
}
