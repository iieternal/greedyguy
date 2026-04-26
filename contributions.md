# Contributing to GreedyGuy 🦖

Thank you for your interest in contributing to GreedyGuy! This project aims to provide a high-performance, context-mixing compressor for the web and Node.js.

## Monorepo Overview

GreedyGuy is managed as a monorepo containing several packages:

- `greedyguy`: The core C implementation and Node.js native wrapper.
- `greedyguy-wasm`: WebAssembly build for Node.js and browsers.
- `greedyguy-web`: Browser-optimized distribution.
- `gg-cache`: Caching middleware for Express, Fastify, and Electron.
- `gg-cache-expo`: Interceptor for Expo and React Native.

## Development Setup

### Prerequisites

- **Node.js**: Version 18 or higher.
- **pnpm**: We use `pnpm` for package management.
- **C Compiler**: `gcc` or `clang` for building the native core.
- **Make**: For running build scripts in the core.
- **Emscripten** (optional): Required if you plan to rebuild the WASM binary.

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/paultsunny/greedyguy.git
   cd greedyguy
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

## Development Workflow

### Working on the C Core (`greedyguy`)

The core logic resides in `greedyguy/src/gg_lib.c`. If you modify the core:
1. Rebuild the native binary:
   ```bash
   cd greedyguy
   make
   ```
2. Run tests:
   ```bash
   pnpm test
   ```

### Rebuilding WASM (`greedyguy-wasm`)

If you change the C core and need to update the WASM build:
1. Ensure you have Emscripten installed and activated.
2. Run the build script (check `greedyguy/Makefile` or the package-specific scripts).
3. Verify the WASM build:
   ```bash
   cd greedyguy-wasm
   pnpm test
   ```

### Updating Middleware (`gg-cache`, `gg-cache-expo`)

These packages depend on `greedyguy-wasm`. Ensure the WASM build is up to date before testing changes here.
```bash
cd gg-cache
pnpm test
```

## Testing

Each package has its own test suite. You can run all tests from the root (if workspace is configured) or individually:

```bash
# Run tests for a specific package
cd <package-dir>
pnpm test
```

## Pull Request Guidelines

1. **Branching**: Create a feature branch for your changes (e.g., `feat/faster-mixing` or `fix/memory-leak`).
2. **Commits**: Follow [Conventional Commits](https://www.conventionalcommits.org/) if possible.
3. **Tests**: Ensure all tests pass before submitting. Add new tests for new features or bug fixes.
4. **Documentation**: Update the relevant `README.md` or this guide if your changes affect the API or development flow.

## Security

If you discover a security vulnerability, please do not open an issue. Instead, contact the maintainers directly at the email listed in the `package.json` or through a private channel.

## License

By contributing to GreedyGuy, you agree that your contributions will be licensed under the MIT License.
