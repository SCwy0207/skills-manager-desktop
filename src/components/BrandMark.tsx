import { useId } from "react";

export interface BrandMarkProps {
  className?: string;
  title?: string;
}

/**
 * Skills Manager's compact "skill relay" mark.
 *
 * One local management hub fans out to three Agent targets inside a repository
 * frame. The geometry is intentionally simple so the same silhouette remains
 * legible in the Windows taskbar and installer.
 */
export function BrandMark({ className = "", title }: BrandMarkProps) {
  const gradientId = `skills-manager-mark-${useId().replace(/:/g, "")}`;

  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <linearGradient id={gradientId} x1="8" y1="5" x2="56" y2="59" gradientUnits="userSpaceOnUse">
          <stop stopColor="#16B7B1" />
          <stop offset="0.56" stopColor="#5368ED" />
          <stop offset="1" stopColor="#0B1936" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="58" height="58" rx="14.5" fill={`url(#${gradientId})`} />
      <path
        d="m37 15.4-5-2.9-16 9.25v20.5L32 51.5l5-2.9"
        fill="none"
        stroke="rgba(255,255,255,.48)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M27.25 32h4.25m0 0 9.25-11.5M31.5 32h9.25m-9.25 0 9.25 11.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="40.5" y="17" width="6.75" height="7" rx="2" fill="#FFFFFF" />
      <rect x="40.5" y="28.5" width="6.75" height="7" rx="2" fill="#FFFFFF" />
      <rect x="40.5" y="40" width="6.75" height="7" rx="2" fill="#FFFFFF" />
      <circle cx="22" cy="32" r="5.25" fill="#142859" stroke="#59E3CF" strokeWidth="2.75" />
      <circle cx="22" cy="32" r="1.35" fill="#FFFFFF" />
    </svg>
  );
}
