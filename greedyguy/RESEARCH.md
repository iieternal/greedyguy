# GreedyGuy: Byte Prediction Compressor — Application Research

## Core Principle

A byte predictor works like a language model for raw bytes:
- **Better prediction → fewer bits** (Shannon's source coding theorem)
- If you can predict the next byte with 99% confidence → it costs ~0.07 bits
- If you have no idea (uniform distribution) → it costs 8 bits
- The model LEARNS the file's patterns online, adapting as it goes

## Where This Approach Excels vs Traditional LZ

| Strength | Why |
|----------|-----|
| **Sequential dependencies** | Byte prediction captures patterns that span beyond LZ's match window |
| **Near-repeats** | LZ needs exact matches; prediction handles "almost the same" patterns |
| **Grammar-driven data** | Format grammars create strong byte-level predictions |
| **Small alphabets in context** | After `color:`, only a few byte values are likely |
| **Incremental variation** | Numbers that change slightly between records |

## Where LZ Still Wins

| Weakness | Why |
|----------|-----|
| **Exact long repeats** | LZ copies them at ~0 cost; prediction still pays per byte |
| **Already-compressed data** | Random bytes can't be predicted |
| **Huge files with simple patterns** | LZ's O(1) per matched byte beats O(model) per byte |

## Ideal Hybrid: Prediction + LZ

The best compressors (LZMA, Zstandard) already combine LZ matching with statistical
modeling of residuals. GreedyGuy is pure prediction — ideal for files where
**every byte position has strong contextual probability** but exact matches are rare.

---

## Application Targets (Ranked by Prediction Advantage)

### Tier 1: Extremely Predictable Structure (Best Candidates)

#### 1. HTML (Already Building)
- **Why perfect**: Tags, attributes, values follow strict grammar
- **Key patterns**: After `<div ` → predict `class`, `id`, `style`; after `="` → predict value patterns
- **Context features**: Tag state, attribute name hash, nesting depth
- **Expected gain vs gzip**: 30-50%+ (HTML is very redundant but in grammar-dependent ways)

#### 2. CSS
- **Why perfect**: Property-value grammar is extremely predictable
- **Key patterns**: After `.class {` → predict properties; after `margin:` → predict `0`, `auto`, `Npx`
- **Context features**:
  - Selector vs property vs value state
  - Current property name (predicts value vocabulary)
  - After `:` the value type is constrained by property
  - Unit patterns: `px`, `em`, `rem`, `%`, `vh`, `vw`
- **Special**: CSS values have property-dependent distributions. `font-size:` expects numbers+units, `color:` expects hex/rgb, `display:` expects keywords
- **Expected model**: ~6 context models + CSS state machine + property-name hash
- **Estimated advantage**: 20-40% over gzip

#### 3. JavaScript / TypeScript
- **Why excellent**: Programming language with strict syntax, keyword-driven
- **Key patterns**:
  - After `function` → predict `(` or space+name
  - After `const ` / `let ` / `var ` → predict identifier  
  - After `if (` → predict expression
  - After `.` → predict method/property names
  - Indentation predicts nesting structure
- **Context features**:
  - Token type state: keyword, identifier, operator, string, number, regex
  - Bracket/brace/paren depth
  - Current keyword hash
  - String delimiter tracking (`, ', ")
- **Special**: Variable and function names repeat within a file. After seeing `handleClick` once, the model learns to predict it cheaply.
- **Estimated advantage**: 25-40% over gzip

#### 4. JSON / NDJSON
- **Why excellent**: Extremely structured, limited vocabulary per context
- **Key patterns**:
  - Keys repeat across objects → model learns key vocabulary
  - After `"key_name":` → value type is predictable (string, number, bool, null, array, object)
  - Array elements often have same structure
  - Numbers follow key-specific distributions
- **Context features**:
  - Object/array depth
  - Current key name hash
  - Previous key in same object (predicts next key)
  - Array element index (mod N)
- **Special**: JSON-lines (NDJSON) has repeating schema — model adapts after first few lines
- **Estimated advantage**: 30-50% over gzip

#### 5. XML / SOAP / SVG
- **Why excellent**: Tag-based structure like HTML but with domain vocabularies
- **Key patterns**: Same as HTML but with custom tag/attribute names
- **SVG special**: Path data (`M`, `L`, `C` commands + coordinates) has very predictable structure
- **Context features**: Namespace tracking, tag name hash, attribute context
- **Estimated advantage**: 25-45% over gzip

### Tier 2: Strong Patterns (Good Candidates)

#### 6. Log Files (syslog, Apache, nginx, application logs)
- **Why good**: Timestamps, log levels, message templates repeat
- **Key patterns**:
  - Timestamp format is fixed: `2024-01-01 12:00:00.000` — model learns the format quickly
  - Log level from small set: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`
  - Message templates: "User %s logged in from %s" — template is predictable, values vary
  - IP addresses: `192.168.x.x` patterns repeat
- **Context features**: Line-start detection, timestamp position, log level, message template hash
- **Special**: Log files can be 100GB+. A streaming prediction model handles them without memory issues.
- **Estimated advantage**: 30-50% over gzip (logs are VERY predictable)

#### 7. CSV / TSV
- **Why good**: Column structure repeats, data types consistent per column
- **Key patterns**:
  - Column delimiters at regular intervals
  - Per-column data distribution (column 1 = names, column 2 = ages, etc.)
  - Header predicts column data types
  - Number formats consistent within columns
- **Context features**: Column index (mod N), row position, header hash per column
- **Estimated advantage**: 25-35% over gzip

#### 8. SQL Queries
- **Why good**: Keyword-driven grammar, table/column names repeat
- **Key patterns**: `SELECT` → columns, `FROM` → table, `WHERE` → conditions
- **Context features**: SQL state (select/from/where/join), keyword hash, table name hash
- **Estimated advantage**: 20-35% over gzip

#### 9. Markdown
- **Why good**: Headers, lists, links, code blocks have predictable syntax
- **Key patterns**: `#` at line start = header; `- ` or `* ` = list; `[text](url)` = link
- **Context features**: Line state (header/list/paragraph/code/table), nesting depth
- **Estimated advantage**: 15-25% over gzip

#### 10. YAML / TOML / INI Config Files
- **Why good**: Indentation-driven structure, key-value patterns
- **Key patterns**: Indent level predicts nesting, keys from limited vocabulary
- **Context features**: Indent level, section name hash, key position
- **Estimated advantage**: 20-30% over gzip

### Tier 3: Structured Binary (Moderate Candidates)

#### 11. HTTP/2 and HTTP/3 Headers (HPACK/QPACK Alternative)
- **Why interesting**: Header names from small set (~100 common), values predictable
- **Key patterns**: Standard headers repeat across requests, Cookie/Set-Cookie patterns
- **Context**: Header name hash predicts value distribution
- **Note**: HPACK already uses Huffman + dynamic table. Byte prediction might beat it.
- **Estimated advantage**: 10-20% over HPACK in some cases

#### 12. Protocol Buffers / Protobuf
- **Why moderate**: Field tags repeat, varint encoding has patterns
- **Key patterns**: Field numbers in order, repeated message structures
- **Context features**: Current field number, wire type, message nesting
- **Estimated advantage**: 10-20% over gzip

#### 13. WebSocket Frames
- **Why moderate**: Opcode+mask overhead, payload is often JSON (see #4)
- **Key patterns**: Frame header structure, mask bits, JSON payload
- **Context**: Frame type, payload position
- **Estimated advantage**: Depends on payload type

#### 14. DNS Packets
- **Why moderate**: Domain names follow patterns, record types predictable
- **Key patterns**: Label length + name, type/class fields from small set
- **Estimated advantage**: 15-25% over generic compression

#### 15. TLS Records
- **Why limited**: Most content is encrypted (random bytes)
- **Useful for**: Handshake messages, certificates (DER-encoded X.509 has patterns)
- **Context**: Record type, handshake state machine
- **Estimated advantage**: Only for unencrypted parts (certificates, handshake)

### Tier 4: Specialized Binary (Niche Candidates)

#### 16. WASM (WebAssembly)
- **Why niche**: Structured binary with sections, opcodes follow patterns
- **Key patterns**: Type section, function section, code section have predictable structure
- **Context**: Section type, opcode sequence, local variable index
- **Estimated advantage**: 10-15% over generic (WASM already compresses well with Brotli)

#### 17. Font Files (WOFF2 / TTF / OTF)
- **Why niche**: Glyph outlines have coordinate patterns, tables are structured
- **Key patterns**: Point coordinates follow glyph geometry, hinting instructions repeat
- **Context**: Table type, glyph index, point index
- **Note**: WOFF2 already uses specialized preprocessing. Hard to beat.

#### 18. Source Maps
- **Why niche**: Base64-encoded VLQ segments, file paths repeat
- **Key patterns**: VLQ numbers follow distributions, mapping line structure
- **Estimated advantage**: 15-25% over gzip

---

## Implementation Strategy: Plugin Architecture

```
greedyguy/
  core/
    gg_rc.h          — Range coder (shared)
    gg_mixer.h       — Logistic mixer (shared)
    gg_context.h     — Context model infrastructure (shared)
    gg_stretch.h     — Stretch/squash tables (shared)
  plugins/
    gg_html.c        — HTML predictor (built first)
    gg_css.c         — CSS predictor
    gg_js.c          — JavaScript predictor
    gg_json.c        — JSON predictor
    gg_log.c         — Log file predictor
    gg_csv.c         — CSV predictor
    gg_generic.c     — Generic text predictor (no format-specific context)
  greedyguy.c        — Main driver (dispatches to plugins by format detection)
```

Each plugin defines:
1. **State machine** — Format-specific parse state
2. **Context models** — Format-specific context hashing
3. **Initialization** — Pre-seeded weights or dictionaries
4. **Format detection** — Heuristic to identify file type

The core infrastructure (range coder, mixer, context tables) is shared.

---

## Build Order (Priority by Impact)

### Phase 1: HTML (NOW)
- Single-file `greedyguy.c` with everything inline
- Prove the concept: beat gzip-9 on HTML

### Phase 2: CSS + JS
- Extract core into headers
- Build CSS predictor (property-value grammar model)
- Build JS predictor (token-type state machine)
- Both should beat gzip-9 easily

### Phase 3: JSON + Log
- JSON predictor with key-aware context
- Log predictor with timestamp/template models
- These have the HIGHEST volume in real-world use

### Phase 4: Network Formats
- HTTP headers, WebSocket, Protocol Buffers
- Integrate with C2E12 plugins for combined LZ+prediction

### Phase 5: Hybrid LZ+Prediction
- Use prediction model to improve LZ's literal coding
- Prediction model runs on matched bytes too (for model coherence)
- This is what LZMA does, but with our richer prediction models

---

## Key Insight: Why This Works for Web Formats

Web formats (HTML, CSS, JS, JSON) share a critical property:
**The byte at position N is strongly predicted by the grammatical context,
not just by nearby bytes.**

Example in CSS:
```css
.container { margin: 10px; padding: 5px; }
```
After `.container { m`, a traditional compressor checks if `argin:` appeared before.
A byte predictor knows:
- We're in property position (after `{` + space)
- Properties starting with `m` are: `margin`, `max-width`, `min-height`, etc.
- `margin` is the most common → predict `argin` with ~80% confidence
- That's ~1.4 bits instead of ~48 bits (6 bytes × 8)

This grammatical prediction is what makes byte predictors devastatingly
effective on structured text formats.

---

## Theoretical Limits

For a file with entropy H bits per byte:
- **Perfect predictor**: H bits/byte (Shannon limit)  
- **Order-8 context model**: Approaches H for most text
- **LZ77 (gzip)**: Within 2-3× of H on large files
- **LZMA (xz)**: Within 1.5-2× of H
- **PAQ/CMIX**: Within 1.1-1.3× of H (closest to limit)
- **GreedyGuy (target)**: Within 1.2-1.5× of H on focused file types

The key: by focusing on ONE file type, we can get closer to H because
our context models are tuned for that specific grammar.

Generic compressors must hedge across all possible data types.
We don't.
