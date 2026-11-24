/** The position printed on a US keyboard, independent of the active layout. */
export function physicalKey(
  event: Pick<KeyboardEvent, "key" | "code">,
): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  const punctuation: Record<string, string> = {
    Slash: "/",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Minus: "-",
    Equal: "=",
  };
  return punctuation[event.code] ?? event.key.toLowerCase();
}
