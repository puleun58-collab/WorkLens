/** 점검한 표시용 구분만 변환하며, 원문과 문제 지문값은 변경하지 않는다. */
export function LearnSeparatedText({ text }: { text: string }) {
  const separator = / [—–] /u.exec(text);
  if (separator) {
    const label = text.slice(0, separator.index);
    const explanation = text.slice(separator.index + separator[0].length);
    return <><strong>{label}:</strong> {explanation}</>;
  }
  const label = /^([^:。.!?'"()[\]\\/]{1,40}): ([\s\S]+)$/.exec(text);
  return label ? <><strong>{label[1]}:</strong> {label[2]}</> : <>{text}</>;
}
