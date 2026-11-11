/** The same geometry as `@rescene/design-tokens/assets/rescene-mark.svg`, inlined for UI reuse. */
export function BrandMark({ size = 34, title = "ReScene" }: { size?: number; title?: string }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label={title}
    >
      <g fill="none" stroke="currentColor" strokeWidth={46} strokeLinejoin="round">
        <path d="M252 634V348l260-150 260 150v286L512 784 252 634Z" />
        <path d="m252 348 260 150 260-150M512 498v286" />
      </g>
      <circle cx="512" cy="498" r="48" fill="currentColor" opacity={0.85} />
    </svg>
  );
}
