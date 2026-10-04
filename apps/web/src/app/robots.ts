import { MetadataRoute } from 'next';
import { absoluteUrl } from '../config/brand';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard/', '/vault/', '/history/', '/repositories/'],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
