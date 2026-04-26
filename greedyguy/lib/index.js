/**
 * greedyguy — Node.js API
 *
 * Byte-prediction compressor using context mixing + arithmetic coding.
 * Uses the CLI binary in pipe mode (stdin/stdout) for streaming IPC.
 *
 * NOTE: The native binary allocates ~764 MB for its prediction tables.
 * Ensure sufficient memory is available before calling compress/decompress.
 *
 * @creator Q3JlYXRlZCBieSBAcGF1bHRzdW5ueQ==
 *
 * @example
 *   const gg = require('greedyguy');
 *   const compressed = await gg.compress(Buffer.from('Hello World'));
 *   const original  = await gg.decompress(compressed);
 *   console.log(gg.version());            // "1.0.0"
 *   console.log(gg.isGGCompressed(compressed)); // true
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

/* ── Magic bytes ────────────────────────────────────────────────────── */

const GG_MAGIC = Buffer.from('GG01');

/* ── Binary discovery ───────────────────────────────────────────────── */

const BIN_NAMES = ['greedyguy', 'greedyguy.exe'];
let _binaryPath = null;

/**
 * Locate the greedyguy binary.
 * Search order: package root → PATH.
 * @returns {string} Absolute path to the binary
 * @throws {Error} If binary cannot be found
 */
function findBinary() {
    if (_binaryPath) return _binaryPath;

    // 1. Package root (same dir as package.json)
    const pkgRoot = path.resolve(__dirname, '..');
    for (const name of BIN_NAMES) {
        const p = path.join(pkgRoot, name);
        if (fs.existsSync(p)) { _binaryPath = p; return p; }
    }

    // 2. Search PATH
    try {
        const cmd  = process.platform === 'win32' ? 'where' : 'which';
        const found = require('child_process')
            .execSync(`${cmd} greedyguy`, { encoding: 'utf8', timeout: 5000 })
            .trim().split(/\r?\n/)[0];
        if (found && fs.existsSync(found)) { _binaryPath = found; return found; }
    } catch (_) { /* not in PATH */ }

    throw new Error(
        'greedyguy binary not found. Run "make" in the package directory, ' +
        'or ensure "greedyguy" is in your PATH.\n' +
        '  npm rebuild greedyguy   # if installed as a dependency'
    );
}

/* ── Pipe helper ────────────────────────────────────────────────────── */

/**
 * Spawn the binary in pipe mode and stream data through it.
 * @param {string}  cmd   'pc' (compress) or 'pd' (decompress)
 * @param {Buffer}  input Data to feed on stdin
 * @param {object}  [opts]
 * @param {number}  [opts.timeout=300000] Process timeout in ms (default 5 min)
 * @param {number}  [opts.maxOutputSize=536870912] Max output bytes (default 512MB)
 * @returns {Promise<Buffer>}
 */
function runPipe(cmd, input, opts = {}) {
    const timeout = opts.timeout || 300000;
    const maxOutputSize = opts.maxOutputSize || 512 * 1024 * 1024; // 512MB default cap
    const bin = findBinary();

    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalSize = 0;
        let stderrBuf = '';
        let settled = false;

        const proc = spawn(bin, [cmd], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout
        });

        proc.stdout.on('data', (chunk) => {
            totalSize += chunk.length;
            if (totalSize > maxOutputSize) {
                if (!settled) {
                    settled = true;
                    proc.kill('SIGKILL');
                    reject(new Error(
                        `greedyguy ${cmd}: output exceeds ${maxOutputSize} byte limit (possible decompression bomb)`
                    ));
                }
                return;
            }
            chunks.push(chunk);
        });
        proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

        proc.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });

        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            if (code !== 0) {
                reject(new Error(`greedyguy ${cmd} exited with code ${code}: ${stderrBuf}`));
            } else {
                resolve(Buffer.concat(chunks));
            }
        });

        // Stream input in 64 KiB chunks to avoid blocking the event loop
        const CHUNK = 64 * 1024;
        let offset = 0;

        function writeNext() {
            while (offset < input.length) {
                const end = Math.min(offset + CHUNK, input.length);
                const ok  = proc.stdin.write(input.slice(offset, end));
                offset = end;
                if (!ok) {
                    proc.stdin.once('drain', writeNext);
                    return;
                }
            }
            proc.stdin.end();
        }

        proc.stdin.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });

        writeNext();
    });
}

/* ── File helper ────────────────────────────────────────────────────── */

/**
 * Spawn the binary in file mode (`greedyguy c|d inPath outPath`).
 * @param {string} mode 'c' or 'd'
 * @param {string} inPath
 * @param {string} outPath
 * @returns {Promise<void>}
 */
function runFile(mode, inPath, outPath) {
    const bin = findBinary();

    return new Promise((resolve, reject) => {
        let stderrBuf = '';
        let settled = false;

        const proc = spawn(bin, [mode, inPath, outPath], {
            stdio: ['ignore', 'ignore', 'pipe']
        });

        proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

        proc.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });

        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            if (code !== 0) {
                reject(new Error(`greedyguy ${mode} exited with code ${code}: ${stderrBuf}`));
            } else {
                resolve();
            }
        });
    });
}

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Compress data in memory using pipe mode.
 *
 * @param {Buffer|Uint8Array|string} input Data to compress (strings are UTF-8 encoded)
 * @param {object}  [opts]
 * @param {number}  [opts.timeout=300000] Timeout in ms
 * @returns {Promise<Buffer>} Compressed data (GG01 format)
 */
async function compress(input, opts) {
    if (typeof input === 'string') input = Buffer.from(input, 'utf8');
    if (input instanceof Uint8Array && !Buffer.isBuffer(input)) input = Buffer.from(input);
    if (!Buffer.isBuffer(input)) throw new TypeError('input must be a Buffer, Uint8Array, or string');
    return runPipe('pc', input, opts);
}

/**
 * Decompress data in memory using pipe mode.
 *
 * @param {Buffer|Uint8Array} input Compressed data (GG01 format)
 * @param {object}  [opts]
 * @param {number}  [opts.timeout=300000] Timeout in ms
 * @returns {Promise<Buffer>} Decompressed data
 */
async function decompress(input, opts) {
    if (input instanceof Uint8Array && !Buffer.isBuffer(input)) input = Buffer.from(input);
    if (!Buffer.isBuffer(input)) throw new TypeError('input must be a Buffer or Uint8Array');
    return runPipe('pd', input, opts);
}

/**
 * Compress a file using the binary's file mode (`greedyguy c inPath outPath`).
 *
 * @param {string} inputPath  Path to the source file
 * @param {string} outputPath Path for the compressed output
 * @returns {Promise<{inputSize: number, outputSize: number, ratio: number}>}
 */
async function compressFile(inputPath, outputPath) {
    const inputSize = fs.statSync(inputPath).size;
    await runFile('c', inputPath, outputPath);
    const outputSize = fs.statSync(outputPath).size;
    return {
        inputSize,
        outputSize,
        ratio: inputSize / (outputSize || 1)
    };
}

/**
 * Decompress a file using the binary's file mode (`greedyguy d inPath outPath`).
 *
 * @param {string} inputPath  Path to the compressed file
 * @param {string} outputPath Path for the decompressed output
 * @returns {Promise<{inputSize: number, outputSize: number}>}
 */
async function decompressFile(inputPath, outputPath) {
    const inputSize = fs.statSync(inputPath).size;
    await runFile('d', inputPath, outputPath);
    const outputSize = fs.statSync(outputPath).size;
    return { inputSize, outputSize };
}

/**
 * Round-trip integrity test: compress → decompress → compare.
 *
 * @param {string} inputPath Path to source file
 * @returns {Promise<{ok: boolean, inputSize: number, compressedSize: number, ratio: number}>}
 */
async function test(inputPath) {
    const original = fs.readFileSync(inputPath);
    const compressed   = await compress(original);
    const decompressed = await decompress(compressed);
    const ok = original.equals(decompressed);
    return {
        ok,
        inputSize:      original.length,
        compressedSize: compressed.length,
        ratio:          original.length / (compressed.length || 1)
    };
}

/**
 * Benchmark: time compression and decompression of a file.
 *
 * @param {string} inputPath Path to source file
 * @returns {Promise<{inputSize: number, compressedSize: number, ratio: number, compressTimeMs: number, decompressTimeMs: number}>}
 */
async function bench(inputPath) {
    const original = fs.readFileSync(inputPath);

    const t0 = process.hrtime.bigint();
    const compressed = await compress(original);
    const t1 = process.hrtime.bigint();
    const decompressed = await decompress(compressed);
    const t2 = process.hrtime.bigint();

    if (!original.equals(decompressed)) {
        throw new Error('bench: round-trip verification failed');
    }

    return {
        inputSize:      original.length,
        compressedSize: compressed.length,
        ratio:          original.length / (compressed.length || 1),
        compressTimeMs:   Number(t1 - t0) / 1e6,
        decompressTimeMs: Number(t2 - t1) / 1e6
    };
}

/**
 * Return the library version string (read from the C header at build time).
 * This is synchronous and does NOT require the binary.
 *
 * @returns {string} e.g. "1.0.0"
 */
function version() {
    return '1.0.0';
}

/**
 * Check whether a buffer begins with the GG01 magic bytes.
 *
 * @param {Buffer|Uint8Array} data
 * @returns {boolean}
 */
function isGGCompressed(data) {
    if (!data || data.length < 4) return false;
    return data[0] === 0x47 &&  // 'G'
           data[1] === 0x47 &&  // 'G'
           data[2] === 0x30 &&  // '0'
           data[3] === 0x31;    // '1'
}

/* ── Exports ────────────────────────────────────────────────────────── */

module.exports = {
    compress,
    decompress,
    compressFile,
    decompressFile,
    test,
    bench,
    version,
    isGGCompressed,
    findBinary
};
