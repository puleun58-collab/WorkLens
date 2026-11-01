// Presentation only: never apply to stored values, user input, commands, or prompt bodies.
export function uiText(text: string): string {
  const end = text.trimEnd();
  if (!/[.。]$/u.test(end) || /(?:\.{2,}|\d\.|\s\.)$/u.test(end) || /(?:https?:\/\/|www\.|(?:[a-z]:)?[\\/])\S+[.]$/iu.test(end)) return text;
  return end.slice(0, -1);
}
