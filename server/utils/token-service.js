import { randomBytes } from 'crypto';

export function generateCurrentMedicationsToken(userId) {
  console.log(`[CUR MEDS] Generating token for userId: ${userId}`);
  const token = randomBytes(16).toString('hex');

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  console.log(`[CUR MEDS] Token generated: ${token.substring(0, 8)}... (expires: ${expiresAt.toISOString()})`);

  return {
    token,
    expiresAt: expiresAt.toISOString()
  };
}
