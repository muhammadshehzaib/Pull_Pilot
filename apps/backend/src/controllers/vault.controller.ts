import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { EncryptionService } from '../services/encryption.service';
import { VALID_PROVIDERS } from '../utils/constants';

export class VaultController {
  static async getVault(req: Request, res: Response) {
    const vault = await prisma.vault.findUnique({
      where: { userId: req.auth!.userId },
      select: { provider: true, updatedAt: true },
    });
    if (!vault) return res.json({ vault: null });
    return res.json({ vault });
  }

  static async upsertVault(req: Request, res: Response) {
    const { provider, apiKey } = req.body ?? {};

    if (!apiKey || typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    if (!provider || !VALID_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: 'provider must be one of GEMINI, OPENAI, CLAUDE, GROK' });
    }

    const { encryptedData, iv, authTag, salt } = EncryptionService.encrypt(apiKey);

    const vault = await prisma.vault.upsert({
      where: { userId: req.auth!.userId },
      create: {
        userId: req.auth!.userId,
        provider,
        encryptedGeminiKey: encryptedData,
        iv,
        authTag,
        salt,
      },
      update: {
        provider,
        encryptedGeminiKey: encryptedData,
        iv,
        authTag,
        salt,
      },
      select: { provider: true, updatedAt: true },
    });

    return res.json({ vault });
  }

  static async deleteVault(req: Request, res: Response) {
    await prisma.vault.deleteMany({ where: { userId: req.auth!.userId } });
    return res.json({ status: 'OK' });
  }
}
