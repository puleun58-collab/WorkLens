type WorkLensLogoTone = "default" | "dark" | "light";

interface WorkLensMarkProps {
  size?: number;
  tone?: WorkLensLogoTone;
  title?: string;
}

interface WorkLensLogoProps extends WorkLensMarkProps {
  showWordmark?: boolean;
}

/** Four independent focus brackets. Kept thick enough to read at 24px on navy. */
const FRAME_PATH = "M3 12V5.5A2.5 2.5 0 0 1 5.5 3H12v3H6v6ZM20 3h6.5A2.5 2.5 0 0 1 29 5.5V12h-3V6h-6ZM3 20h3v6h6v3H5.5A2.5 2.5 0 0 1 3 26.5ZM26 20h3v6.5A2.5 2.5 0 0 1 26.5 29H20v-3h6Z";
/** Geometric W, solid so small sizes never thin out. */
const W_PATH = "M8.4 10.6h3.3l1.7 7.2 2.1-7.2h1l2.1 7.2 1.7-7.2h3.3l-3.2 11.8h-3.1L16 16.4l-1.3 6h-3.1Z";

export function WorkLensMark({ size = 33, tone = "default", title }: WorkLensMarkProps) {
  return (
    <svg
      className="worklens-mark"
      data-tone={tone}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <path className="worklens-frame" d={FRAME_PATH} />
      <path className="worklens-w" d={W_PATH} />
    </svg>
  );
}

export function WorkLensLogo({ size = 33, tone = "default", showWordmark = true }: WorkLensLogoProps) {
  return (
    <span className="worklens-logo" data-tone={tone} role="img" aria-label="WorkLens">
      <WorkLensMark size={size} tone={tone} />
      {showWordmark ? (
        <span className="worklens-wordmark" aria-hidden="true">
          Work<em>Lens</em>
        </span>
      ) : null}
    </span>
  );
}
