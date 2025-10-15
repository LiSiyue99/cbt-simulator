import 'dotenv/config';
import { createDb } from '../db/client';
import { users, whitelistEmails } from '../db/schema';
import { eq } from 'drizzle-orm';

function cleanEmail(e: string): string {
  return (e || '')
    .replace(/[\u2000-\u200B\u3000]/g, '') // remove common zero-width/full-width spaces
    .trim()
    .toLowerCase();
}

async function main() {
  const db = createDb();
  let usersUpdated = 0;
  let whiteUpdated = 0;

  const allUsers = await db.select().from(users);
  for (const u of allUsers as any[]) {
    const email = String((u as any).email || '');
    const cleaned = cleanEmail(email);
    if (email !== cleaned && cleaned) {
      await db.update(users).set({ email: cleaned } as any).where(eq(users.id as any, (u as any).id));
      usersUpdated += 1;
    }
  }

  const allWhite = await db.select().from(whitelistEmails);
  for (const w of allWhite as any[]) {
    const email = String((w as any).email || '');
    const cleaned = cleanEmail(email);
    if (email !== cleaned && cleaned) {
      await db.update(whitelistEmails).set({ email: cleaned } as any).where(eq(whitelistEmails.email as any, email));
      whiteUpdated += 1;
    }
  }

  console.log(JSON.stringify({ usersUpdated, whiteUpdated }));
}

main().catch((e)=>{ console.error(e); process.exit(1); });
