import { SignJWT, jwtVerify } from 'jose';

const alg = 'HS256';
const enc = new TextEncoder();

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  return enc.encode(secret);
}

export type JwtPayload = { userId: string; role: string; email: string };

export async function signJwt(payload: JwtPayload): Promise<string> {
  return await new SignJWT(payload as any)
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getSecret());
}

export async function verifyJwt(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}
