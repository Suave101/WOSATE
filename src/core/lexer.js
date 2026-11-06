// Shared lexer for AADL and annex languages. Keywords are returned as plain
// identifiers; parsers compare them case-insensitively (AADL is case-insensitive).

export class Token {
  constructor(type, value, pos, end, line, col) {
    this.type = type; // 'id' | 'int' | 'real' | 'string' | 'op' | 'annex' | 'eof'
    this.value = value;
    this.pos = pos;
    this.end = end;
    this.line = line;
    this.col = col;
  }
  get lower() {
    return this.type === "id" ? this.value.toLowerCase() : this.value;
  }
}

export const AADL_OPERATORS = [
  "+=>", "<->", "::", "=>", "->", "..", "{", "}", "(", ")", "[", "]", ";", ":", ",", ".", "*", "-", "+",
];

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]} [opts.operators] operator list (longest first is not required)
 * @param {boolean} [opts.annexBlocks] recognise `{** ... **}` as a single 'annex' token
 * @param {number} [opts.line] starting line (1-based), for lexing embedded text
 * @param {number} [opts.col] starting column (1-based) of the first character
 * @param {number} [opts.offset] added to every token's pos/end (for text embedded in a larger file)
 * @param {(d: {line:number,col:number,message:string}) => void} [opts.onError]
 */
export function tokenize(text, opts = {}) {
  const operators = [...(opts.operators || AADL_OPERATORS)].sort((a, b) => b.length - a.length);
  const tokens = [];
  let i = 0;
  let line = opts.line || 1;
  let col = opts.col || 1;
  const onError = opts.onError || (() => {});
  const base = opts.offset || 0;

  const advance = (n) => {
    for (let k = 0; k < n; k++) {
      if (text[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f") {
      advance(1);
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") advance(1);
      continue;
    }
    const startPos = i, startLine = line, startCol = col;

    if (opts.annexBlocks && ch === "{" && text[i + 1] === "*" && text[i + 2] === "*") {
      const close = text.indexOf("**}", i + 3);
      const bodyStart = i + 3;
      const bodyLine = line;
      const bodyCol = col + 3;
      if (close < 0) {
        onError({ line, col, message: "Unterminated annex block: missing '**}'" });
        const body = text.slice(bodyStart);
        advance(text.length - i);
        const t = new Token("annex", body, startPos, i, startLine, startCol);
        t.bodyLine = bodyLine;
        t.bodyCol = bodyCol;
        tokens.push(t);
        break;
      }
      const body = text.slice(bodyStart, close);
      advance(close + 3 - i);
      const t = new Token("annex", body, startPos, i, startLine, startCol);
      t.bodyLine = bodyLine;
      t.bodyCol = bodyCol;
      tokens.push(t);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const value = text.slice(i, j);
      advance(j - i);
      tokens.push(new Token("id", value, startPos, i, startLine, startCol));
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9_]/.test(text[j])) j++;
      let isReal = false;
      // A '.' followed by a digit is a decimal point; '..' is the range operator.
      if (text[j] === "." && /[0-9]/.test(text[j + 1] || "")) {
        isReal = true;
        j++;
        while (j < text.length && /[0-9_]/.test(text[j])) j++;
      }
      if ((text[j] === "e" || text[j] === "E") && /[-+0-9]/.test(text[j + 1] || "")) {
        let k = j + 1;
        if (text[k] === "+" || text[k] === "-") k++;
        if (/[0-9]/.test(text[k] || "")) {
          isReal = isReal || text[k - 1] === "-";
          j = k;
          while (j < text.length && /[0-9]/.test(text[j])) j++;
        }
      }
      const raw = text.slice(i, j).replace(/_/g, "");
      advance(j - i);
      const t = new Token(isReal ? "real" : "int", raw, startPos, i, startLine, startCol);
      tokens.push(t);
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") {
        value += text[j];
        j++;
      }
      if (text[j] !== '"') {
        onError({ line, col, message: "Unterminated string literal" });
      } else {
        j++;
      }
      advance(j - i);
      tokens.push(new Token("string", value, startPos, i, startLine, startCol));
      continue;
    }

    const op = operators.find((o) => text.startsWith(o, i));
    if (op) {
      advance(op.length);
      tokens.push(new Token("op", op, startPos, i, startLine, startCol));
      continue;
    }

    onError({ line, col, message: `Unexpected character '${ch}'` });
    advance(1);
  }
  tokens.push(new Token("eof", "<end of file>", i, i, line, col));
  if (base) {
    for (const t of tokens) {
      t.pos += base;
      t.end += base;
    }
  }
  return tokens;
}

export class ParseError extends Error {
  constructor(message, token) {
    super(message);
    this.token = token;
  }
}

/** Small cursor over a token list shared by the hand-written parsers. */
export class TokenStream {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }
  peek(k = 0) {
    return this.tokens[Math.min(this.i + k, this.tokens.length - 1)];
  }
  next() {
    const t = this.peek();
    if (t.type !== "eof") this.i++;
    return t;
  }
  atEnd() {
    return this.peek().type === "eof";
  }
  /** Source offset just after the most recently consumed token. */
  lastEnd() {
    return this.i > 0 ? this.tokens[this.i - 1].end : 0;
  }
  isKw(word, k = 0) {
    const t = this.peek(k);
    return t.type === "id" && t.value.toLowerCase() === word;
  }
  isOp(op, k = 0) {
    const t = this.peek(k);
    return t.type === "op" && t.value === op;
  }
  acceptKw(word) {
    if (this.isKw(word)) return this.next();
    return null;
  }
  acceptOp(op) {
    if (this.isOp(op)) return this.next();
    return null;
  }
  expectKw(word) {
    if (this.isKw(word)) return this.next();
    throw new ParseError(`Expected '${word}' but found '${this.peek().value}'`, this.peek());
  }
  expectOp(op) {
    if (this.isOp(op)) return this.next();
    throw new ParseError(`Expected '${op}' but found '${this.peek().value}'`, this.peek());
  }
  expectId(what = "identifier") {
    const t = this.peek();
    // `end` is reserved in AADL and its annexes; refusing it keeps half-typed lines from eating `end X;`.
    if (t.type === "id" && t.lower !== "end") return this.next();
    throw new ParseError(`Expected ${what} but found '${t.value}'`, t);
  }
}
