import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type { BookExportScope } from '@bookorbit/types';

export const EXPORT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_EXPORT_SESSIONS_PER_USER = 3;

export type BookExportSession = {
  token: string;
  userId: number;
  scope: BookExportScope;
  parts: number[][];
  archiveBaseName: string;
  createdAt: number;
  expiresAt: number;
  activeParts: Map<number, number>;
};

/**
 * In-memory store for prepared multi-part exports. Sessions only hold book IDs
 * per part, so a whole-library session stays small; losing them on restart just
 * means the user prepares the download again.
 */
@Injectable()
export class BookExportSessionStore {
  private readonly sessions = new Map<string, BookExportSession>();

  create(input: Omit<BookExportSession, 'token' | 'createdAt' | 'expiresAt' | 'activeParts'>): BookExportSession {
    this.sweepExpired();
    const userSessions = [...this.sessions.values()].filter((s) => s.userId === input.userId).sort((a, b) => a.createdAt - b.createdAt);
    for (const stale of userSessions.slice(0, Math.max(0, userSessions.length - MAX_EXPORT_SESSIONS_PER_USER + 1))) {
      this.sessions.delete(stale.token);
    }

    const now = Date.now();
    const session: BookExportSession = {
      ...input,
      token: randomUUID(),
      createdAt: now,
      expiresAt: now + EXPORT_SESSION_TTL_MS,
      activeParts: new Map(),
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string, userId: number): BookExportSession {
    this.sweepExpired();
    const session = this.sessions.get(token);
    if (!session || session.userId !== userId) {
      throw new NotFoundException('Download session not found or expired');
    }
    return session;
  }

  /** Marks a part as streaming until the returned release function is called. */
  trackActivePart(session: BookExportSession, index: number): () => void {
    session.activeParts.set(index, (session.activeParts.get(index) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (session.activeParts.get(index) ?? 1) - 1;
      if (next <= 0) session.activeParts.delete(index);
      else session.activeParts.set(index, next);
    };
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}
