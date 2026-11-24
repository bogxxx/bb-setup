/**
 * Selectors that style an element's inside by what the element holds, such as
 * `A:has(B) C` or `A:has(B) > C`. While an A exists, Chrome restyles much of
 * the page on every change to it, so typing and switching threads slow down.
 * Nested rules resolve as CSS nesting does. Sibling combinators are cheap and
 * pass.
 */
export function insideHasSelectors(css: string): string[] {
  const found: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: string[][] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") {
      i = text.indexOf(char, i + 1);
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && (char === "{" || char === "}" || char === ";")) {
      const prelude = text.slice(start, i).trim();
      start = i + 1;
      if (char === "{") {
        const parents = stack.at(-1) ?? [];
        if (prelude.startsWith("@")) {
          // Conditional groups keep the enclosing selectors for nested rules.
          stack.push(parents);
          continue;
        }
        const selectors = splitTop(prelude, ",").map((selector) => resolve(selector, parents));
        for (const selector of selectors) if (insideHas(selector)) found.push(selector);
        stack.push(selectors);
      } else if (char === "}") stack.pop();
    }
  }
  return [...new Set(found)];
}

function resolve(selector: string, parents: string[]): string {
  if (!parents.length) return selector;
  const parent = parents.length === 1 ? parents[0]! : `:is(${parents.join(", ")})`;
  if (selector.includes("&")) return selector.replaceAll("&", `:is(${parent})`);
  return `:is(${parent}) ${selector}`;
}

/** Whether a compound holding :has() comes before a descendant or child combinator. */
function insideHas(selector: string): boolean {
  const parts = splitCompounds(selector);
  for (let i = 0; i < parts.length; i++) {
    const { compound, combinator } = parts[i]!;
    if ((combinator === " " || combinator === ">") && compound.includes(":has(")) return true;
    // Selectors in :is(), :where() and :not() are checked the same way.
    for (const match of compound.matchAll(/:(?:is|where|not)\(/g)) {
      const args = argument(compound, match.index! + match[0].length);
      if (splitTop(args, ",").some(insideHas)) return true;
    }
  }
  return false;
}

/** The compounds of a complex selector, each with the combinator after it. */
function splitCompounds(selector: string) {
  const parts: { compound: string; combinator: string | null }[] = [];
  let depth = 0;
  let current = "";
  const text = selector.trim();
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (depth === 0 && /[\s>+~]/.test(char)) {
      let j = i;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const combinator = /[>+~]/.test(text[j] ?? "") ? text[j]! : " ";
      if (combinator !== " ") j++;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (current) parts.push({ compound: current, combinator });
      current = "";
      i = j - 1;
      continue;
    }
    current += char;
  }
  if (current) parts.push({ compound: current, combinator: null });
  return parts;
}

function argument(text: string, from: number): string {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

function splitTop(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (depth === 0 && char === separator) {
      out.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
