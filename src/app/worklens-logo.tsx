type WorkLensLogoTone = "default" | "dark" | "light";

interface WorkLensMarkProps {
  size?: number;
  tone?: WorkLensLogoTone;
  title?: string;
}

interface WorkLensLogoProps extends WorkLensMarkProps {
  showWordmark?: boolean;
}

const FRAME_PATH = "M2 9V2H9V4H4V9ZM23 2H30V9H28V4H23ZM2 23H4V28H9V30H2ZM28 23H30V30H23V28H28Z";
const W_PATH = "M9.5 10.5 13 22.5 16 13.5 19 22.5 22.5 10.5";

export function WorkLensMark({ size = 26, tone = "default", title }: WorkLensMarkProps) {
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
      <path className="worklens-w" d={W_PATH} pathLength="1" />
    </svg>
  );
}

export function WorkLensLogo({ size = 26, tone = "default", showWordmark = true }: WorkLensLogoProps) {
  return (
    <span className="worklens-logo" data-tone={tone} role="img" aria-label="WorkLens">
      <WorkLensMark size={size} tone={tone} />
      {showWordmark ? <span className="worklens-wordmark" aria-hidden="true">WorkLens</span> : null}
    </span>
  );
}
