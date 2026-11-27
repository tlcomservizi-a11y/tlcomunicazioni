import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { one, run } from "./db.js";

export const COOKIE = "tl_session";
const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}

export function createSession(res: Response, userId: number) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", token, userId, expires.toISOString());
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
  });
}

export function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[COOKIE];
  if (token) run("DELETE FROM sessions WHERE token = ?", token);
  res.clearCookie(COOKIE);
}

export interface AuthedRequest extends Request {
  userId: number;
  businessId: number;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  const row = token
    ? one<{ user_id: number; business_id: number; expires_at: string }>(
        `SELECT s.user_id, s.expires_at, u.business_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
        token,
      )
    : undefined;
  if (!row || row.expires_at < new Date().toISOString()) {
    res.status(401).json({ error: "Accesso richiesto" });
    return;
  }
  (req as AuthedRequest).userId = row.user_id;
  (req as AuthedRequest).businessId = row.business_id;
  next();
}
