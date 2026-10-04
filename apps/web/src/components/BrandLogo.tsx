import React from 'react';

interface PullPilotLogoProps {
  size?: number;
  className?: string;
  showSparkle?: boolean;
}

export function PullPilotLogo({ size = 28, className = '', showSparkle = true }: PullPilotLogoProps) {
  const iconSize = Math.round(size * 0.58);

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: 'linear-gradient(135deg, #007fff 0%, #1211ff 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        boxShadow: '0 2px 8px rgba(18, 17, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
        position: 'relative',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {/* Subtle Top Inner Bevel */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '45%',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Custom Vector PR / Pilot Delta Logo */}
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ overflow: 'visible' }}
      >
        {/* Main Branch Line */}
        <path
          d="M6 4v16"
          stroke="#ffffff"
          strokeWidth="2.5"
          strokeLinecap="round"
        />

        {/* PR Fork Branch Line */}
        <path
          d="M6 14c0-3 3-5 6.5-5h4"
          stroke="#ffffff"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Base Main Nodes */}
        <circle cx="6" cy="5" r="2.2" fill="#ffffff" />
        <circle cx="6" cy="19" r="2.2" fill="#ffffff" />

        {/* PR Head Node (Target with AI Glow) */}
        <circle cx="18" cy="9" r="2.8" fill="#ffffff" />
        <circle cx="18" cy="9" r="1.3" fill="#1211ff" />

        {/* AI Sparkle Star on Top Right */}
        {showSparkle && (
          <path
            d="M21 2.5l.5 1.1 1.1.5-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.5z"
            fill="#ffea79"
          />
        )}
      </svg>
    </div>
  );
}
