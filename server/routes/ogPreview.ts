import { Router, Request, Response } from 'express';
import Canvas from 'canvas';
import Redis from 'ioredis';

export function createOGPreviewRouter(redis: Redis): Router {
  const router = Router();

  router.get('/og/:requestId', async (req: Request, res: Response) => {
    const { requestId } = req.params;
    const cacheKey = `og:${requestId}`;

    try {
      const cached = await redis.getBuffer(cacheKey);
      if (cached) {
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=3600');
        return res.send(cached);
      }

      const canvas = Canvas.createCanvas(1200, 630);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0f1419';
      ctx.fillRect(0, 0, 1200, 630);

      ctx.fillStyle = '#00d4ff';
      ctx.font = 'bold 48px Arial';
      ctx.fillText('HelPhone Help Request', 100, 150);

      ctx.fillStyle = '#ffffff';
      ctx.font = '32px Arial';
      ctx.fillText(`Request ID: ${requestId}`, 100, 250);

      ctx.fillStyle = '#00d4ff';
      ctx.font = '24px Arial';
      ctx.fillText('Emergency Response Network', 100, 550);

      const buffer = canvas.toBuffer('image/png');
      await redis.setex(cacheKey, 3600, buffer);

      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    } catch (error) {
      console.error('OG preview error:', error);
      res.status(500).json({ error: 'Failed to generate preview' });
    }
  });

  return router;
}
