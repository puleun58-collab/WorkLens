"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CopyButtonProps = {
  text: string;
  label: string;
  iconOnly?: boolean;
  className?: string;
  errorClassName?: string;
};

export function CopyButton({ text, label, iconOnly = false, className, errorClassName }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { window.clearTimeout(timer.current); }, []);
  async function copy() {
    window.clearTimeout(timer.current);
    setCopied(false);
    let success = false;
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch {
      const holder = document.createElement("textarea");
      holder.value = text;
      holder.setAttribute("readonly", "");
      holder.style.position = "fixed";
      holder.style.opacity = "0";
      document.body.append(holder);
      holder.select();
      try { success = document.execCommand("copy"); } catch { success = false; } finally { holder.remove(); }
    }
    setFailed(!success);
    if (success) {
      setCopied(true);
      timer.current = window.setTimeout(() => setCopied(false), 1_600);
    }
  }
  return <>
    <span className="sr-only" aria-live="polite">{copied ? "복사 완료" : ""}</span>
    <Button type="button" variant={iconOnly ? "ghost" : "default"} size={iconOnly ? "icon-xs" : "default"} className={className} data-copied={copied ? "true" : undefined} aria-label={label} onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{iconOnly ? null : "복사"}</Button>
    {failed ? <p className={errorClassName ?? "m-0 text-sm text-destructive"} role="status">복사하지 못했습니다. 직접 선택해 복사해주세요</p> : null}
  </>;
}

type CommandCodeBlockProps = {
  command: string;
  label?: string;
  copyLabel?: string;
  ariaLabel?: string;
  displayText?: string;
  className?: string;
  variant?: "default" | "ax";
  singleLine?: boolean;
};

export function CommandCodeBlock({ command, label = "PowerShell", copyLabel, ariaLabel = `${label} 명령`, displayText = command, className, variant = "default", singleLine = false }: CommandCodeBlockProps) {
  const ax = variant === "ax";
  return <div className={cn(ax ? "ax-guide-code-wrap" : "relative min-w-0 max-w-full rounded-lg bg-[#e9ebef] text-foreground", className)}>
    <pre className={ax ? cn("ax-guide-code", singleLine && "ax-guide-code--single-line") : "relative m-0 min-w-0 max-w-full overflow-x-auto rounded-lg px-3.5 pt-9 pb-3 font-mono text-[13px] leading-[1.7] whitespace-pre"} aria-label={ariaLabel}>
      <span className={ax ? "ax-guide-code-label" : "absolute top-1.5 left-3.5 font-sans text-[11px] tracking-[.04em] text-muted-foreground"} aria-hidden="true">{label}</span><code>{displayText}</code>
    </pre>
    <CopyButton key={command} text={command} label={copyLabel ?? `${ariaLabel} 복사`} iconOnly className={ax ? "ax-guide-copy-button" : "absolute top-[3px] right-[5px] size-8 text-muted-foreground data-[copied=true]:text-primary"} errorClassName={ax ? "ax-copy-error" : "m-0 px-3.5 pb-3 text-sm text-destructive"} />
  </div>;
}
