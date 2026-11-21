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
      <path fill="#8693FF" d="M382 312 728 187 882 258 600 363 882 496V674L538 800V679L784 585 574 486V374L523 389Z" />
      <path fill="#2EDAD5" fillRule="evenodd" d="M142 400 382 312 522 385V576L380 636 555 800 442 840 251 674 239 678V789L142 829ZM239 483 414 421V512L239 588Z" />
    </svg>
  );
}
