import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import {
  BRAND_AUTHOR,
  BRAND_NAME,
  BRAND_TAGLINE,
  DEFAULT_TITLE,
  FAVICON_PATH,
  LOGO_PATH,
  ORGANIZATION_SAME_AS,
  SITE_URL,
  TWITTER_HANDLE,
  absoluteUrl,
} from "../config/brand";
import "./globals.css";
import { NO_TRAINING_CLAIM } from "../config/privacy";
import { ANALYTICS_SCRIPT_SRC, ANALYTICS_WEBSITE_ID } from "../config/analytics";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: DEFAULT_TITLE,
    template: `%s | ${BRAND_NAME}`,
  },
  description:
    "Automated AI code review for GitHub and GitLab pull requests. Catch timing attacks, N+1 query bottlenecks, and memory leaks with 1-click inline mergeable patches.",
  keywords: [
    "AI PR reviewer",
    "CodeRabbit alternative",
    "automated code review",
    "GitHub PR review bot",
    "GitLab AI code review",
    "AST security scanner",
    "pull request automation",
    "AI code auditor",
    "Claude 5 code review",
    "ChatGPT 5.6 PR reviewer",
    "Gemini 3.0 Pro code review",
  ],
  authors: [{ name: BRAND_AUTHOR, url: SITE_URL }],
  creator: BRAND_NAME,
  publisher: BRAND_NAME,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: `${BRAND_NAME} AI PR Reviewer`,
    title: `${BRAND_NAME} | AI PR Reviewer | ${BRAND_TAGLINE}`,
    description:
      "Automated AI code review on every pull request with Claude 5, ChatGPT 5.6, and Gemini 3.0 Pro. Catch timing attacks, N+1 query bottlenecks, and memory leaks.",
    images: [
      {
        url: LOGO_PATH,
        width: 512,
        height: 512,
        alt: `${BRAND_NAME} AI PR Reviewer Logo`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${BRAND_NAME} | AI PR Reviewer | ${BRAND_TAGLINE}`,
    description:
      "Automated AI code review on every pull request with Claude 5, ChatGPT 5.6 & Gemini 3.0 Pro.",
    images: [LOGO_PATH],
    creator: `@${TWITTER_HANDLE}`,
  },
  alternates: {
    canonical: SITE_URL,
  },
  icons: {
    icon: [
      { url: FAVICON_PATH, type: "image/svg+xml" },
      { url: LOGO_PATH, type: "image/svg+xml" },
    ],
    apple: [{ url: LOGO_PATH }],
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: BRAND_NAME,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Cloud, Linux, Docker, macOS, Windows",
      url: SITE_URL,
      offers: {
        type: "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      description:
        "AI-powered code review bot that automatically scans pull request diffs for security vulnerabilities, performance regressions, and architectural bugs.",
      featureList: [
        "Multi-model AI switching (Claude 5, ChatGPT 5.6, Gemini 3.0 Pro, Grok 4)",
        NO_TRAINING_CLAIM,
        "1-click inline GitHub mergeable patches",
        "Declarative .aipr.yml repository configuration",
        "GNU AGPL-3.0 auditable open core",
      ],
    },
    {
      "@type": "Organization",
      name: BRAND_NAME,
      url: SITE_URL,
      logo: absoluteUrl(LOGO_PATH),
      sameAs: [...ORGANIZATION_SAME_AS],
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <link rel="icon" type="image/svg+xml" href={LOGO_PATH} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {ANALYTICS_SCRIPT_SRC && ANALYTICS_WEBSITE_ID ? (
          <script defer src={ANALYTICS_SCRIPT_SRC} data-website-id={ANALYTICS_WEBSITE_ID} />
        ) : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
