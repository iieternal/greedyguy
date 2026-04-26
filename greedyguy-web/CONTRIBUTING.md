# Contributing to greedyguy-web

Thanks for your interest! Here's how to contribute.

## Setup

```bash
git clone https://github.com/niceguydave/greedyguy-web.git
cd greedyguy-web
```

No `npm install` needed — zero dependencies.

## Development

```bash
# Build the IIFE bundle
node build.js

# Run tests
node test/test.js

# Serve examples locally
npx serve -p 8080 .
```

## Project Structure

```
greedyguy-web/
├── src/
│   ├── index.js      — ESM source module (the canonical API)
│   └── index.d.ts    — TypeScript declarations
├── dist/
│   ├── greedyguy-web.iife.js  — Built IIFE for <script> tags
│   ├── greedyguy-glue.js      — Emscripten glue (generated)
│   └── greedyguy.wasm         — WASM binary (generated)
├── examples/         — HTML demos
├── test/             — Node.js tests
├── build.js          — IIFE build script
└── package.json
```

## Guidelines

- Keep it zero-dependency
- Test any changes with `node test/test.js`
- Update examples if the API changes
- Run `node build.js` to regenerate the IIFE

## Reporting Issues

Please include:
- Browser + version
- Minimal reproduction (HTML file ideally)
- Error messages / console output
