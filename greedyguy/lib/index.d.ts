/**
 * GreedyGuy — Byte-prediction compressor
 * TypeScript type definitions
 *
 * NOTE: The native binary allocates ~764 MB for its prediction tables.
 */

export interface CompressOptions {
    /** Timeout in milliseconds (default: 300000 = 5 min) */
    timeout?: number;
}

export interface CompressFileResult {
    inputSize: number;
    outputSize: number;
    /** Compression ratio (inputSize / outputSize) */
    ratio: number;
}

export interface DecompressFileResult {
    inputSize: number;
    outputSize: number;
}

export interface TestResult {
    /** true if decompressed output matches original */
    ok: boolean;
    inputSize: number;
    compressedSize: number;
    ratio: number;
}

export interface BenchResult {
    inputSize: number;
    compressedSize: number;
    ratio: number;
    compressTimeMs: number;
    decompressTimeMs: number;
}

/**
 * Compress data in memory via pipe mode.
 * @param input - Data to compress (strings are UTF-8 encoded)
 * @param opts  - Options
 * @returns Compressed data buffer (GG01 format)
 */
export function compress(
    input: Buffer | Uint8Array | string,
    opts?: CompressOptions
): Promise<Buffer>;

/**
 * Decompress data in memory via pipe mode.
 * @param input - Compressed data (GG01 format)
 * @param opts  - Options
 * @returns Decompressed data buffer
 */
export function decompress(
    input: Buffer | Uint8Array,
    opts?: CompressOptions
): Promise<Buffer>;

/**
 * Compress a file using the binary's file mode (`greedyguy c inPath outPath`).
 */
export function compressFile(
    inputPath: string,
    outputPath: string
): Promise<CompressFileResult>;

/**
 * Decompress a file using the binary's file mode (`greedyguy d inPath outPath`).
 */
export function decompressFile(
    inputPath: string,
    outputPath: string
): Promise<DecompressFileResult>;

/**
 * Round-trip integrity test: compress → decompress → compare.
 */
export function test(inputPath: string): Promise<TestResult>;

/**
 * Benchmark: time compression and decompression of a file.
 */
export function bench(inputPath: string): Promise<BenchResult>;

/**
 * Return the library version string (from the C header).
 * Synchronous — does NOT require the binary.
 */
export function version(): string;

/**
 * Check whether a buffer begins with the GG01 magic bytes.
 */
export function isGGCompressed(data: Buffer | Uint8Array): boolean;

/**
 * Locate the greedyguy binary.
 * @throws {Error} If binary cannot be found
 */
export function findBinary(): string;
