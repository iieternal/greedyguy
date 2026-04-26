/**
 * GG-Cache — TypeScript definitions
 */

export interface CacheEntry {
  data: Uint8Array;
  meta: {
    contentType: string;
    originalSize: number;
    compressed: boolean;
    createdAt: number;
    [key: string]: unknown;
  };
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  bytesIn: number;
  bytesStored: number;
  compressTimeMs: number;
  decompressTimeMs: number;
  hitRate: number;
  compressionRatio: number;
  store: StoreStats;
}

export interface StoreStats {
  entries: number;
  bytes: number;
  maxSize: number;
  utilization: number;
}

export interface SetOptions {
  ttl?: number;
  contentType?: string;
  meta?: Record<string, unknown>;
}

export interface CacheOptions {
  store?: Store;
  compressor?: Compressor;
  compress?: boolean;
  ttl?: number;
  minCompressSize?: number;
  maxSize?: number;
  compressible?: Set<string>;
  sweepInterval?: number;
  wasmPath?: string;
}

export interface Store {
  get(key: string): Promise<StoreEntry | null>;
  set(key: string, entry: StoreEntry): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  stats?(): StoreStats;
  sweep?(): Promise<number>;
}

export interface StoreEntry {
  data: Uint8Array;
  size: number;
  expiresAt: number | null;
  meta: Record<string, unknown>;
  lastAccess?: number;
}

export interface Compressor {
  init(): Promise<void>;
  compress(input: Uint8Array): Uint8Array;
  decompress(input: Uint8Array): Uint8Array;
  readonly loaded: boolean;
}

export class GGCache {
  constructor(opts?: CacheOptions);
  init(): Promise<void>;
  set(key: string, value: Uint8Array | Buffer | string, opts?: SetOptions): Promise<void>;
  get(key: string): Promise<CacheEntry | null>;
  getText(key: string): Promise<{ data: string; meta: CacheEntry['meta'] } | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  stats(): CacheStats;
  destroy(): Promise<void>;
}

export class GGCompressor implements Compressor {
  constructor(opts?: { wasmPath?: string; wasmUrl?: string });
  init(): Promise<void>;
  compress(input: Uint8Array): Uint8Array;
  decompress(input: Uint8Array): Uint8Array;
  readonly loaded: boolean;
  static isCompressed(data: Uint8Array): boolean;
}

export class NoopCompressor implements Compressor {
  init(): Promise<void>;
  compress(input: Uint8Array): Uint8Array;
  decompress(input: Uint8Array): Uint8Array;
  readonly loaded: boolean;
}

export class MemoryStore implements Store {
  constructor(opts?: { maxSize?: number });
  get(key: string): Promise<StoreEntry | null>;
  set(key: string, entry: StoreEntry): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  readonly size: number;
  readonly bytes: number;
  readonly maxSize: number;
  stats(): StoreStats;
  sweep(): Promise<number>;
}

export class FileStore implements Store {
  constructor(opts: { dir: string; maxSize?: number });
  get(key: string): Promise<StoreEntry | null>;
  set(key: string, entry: StoreEntry): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  readonly size: number;
  readonly bytes: number;
  stats(): StoreStats & { dir: string };
  sweep(): Promise<number>;
}

// Strategies
export type StrategyFn = (key: string, opts?: Record<string, unknown>) => Promise<CacheEntry & { fromCache: boolean }>;
export type Fetcher = (key: string, opts?: Record<string, unknown>) => Promise<{ data: Uint8Array; contentType: string; meta?: Record<string, unknown> }>;

export function cacheFirst(cache: GGCache, fetcher: Fetcher, opts?: { ttl?: number }): StrategyFn;
export function networkFirst(cache: GGCache, fetcher: Fetcher, opts?: { ttl?: number; timeout?: number }): StrategyFn;
export function staleWhileRevalidate(cache: GGCache, fetcher: Fetcher, opts?: { ttl?: number }): StrategyFn;
export function cacheOnly(cache: GGCache): StrategyFn;
export function networkOnly(fetcher: Fetcher): StrategyFn;

// --- Middleware: Express ---

export interface ExpressMiddlewareOptions {
  methods?: string[];
  statuses?: number[];
  ttl?: number;
  include?: RegExp[];
  exclude?: RegExp[];
  staleOnError?: boolean;
}

export function ggCacheMiddleware(cache: GGCache, opts?: ExpressMiddlewareOptions): any;

// --- Middleware: Fastify ---

export interface FastifyPluginOptions {
  cache: GGCache;
  methods?: string[];
  statuses?: number[];
  ttl?: number;
  include?: RegExp[];
  exclude?: RegExp[];
  statsRoute?: string | boolean;
}

export function ggCachePlugin(fastify: any, opts: FastifyPluginOptions): Promise<void>;

// --- Middleware: Fastify Request Decompression ---

export interface FastifyRequestDecompressorOptions {
  allowedRoutes?: RegExp[];
  maxCompressedSize?: number;
  maxDecompressedSize?: number;
  maxRatio?: number;
  poolSize?: number;
  queueLimit?: number;
  timeout?: number;
  wasmPath?: string;
}

export function ggRequestDecompressor(fastify: any, opts?: FastifyRequestDecompressorOptions): Promise<void>;

// --- Middleware: Express Request Decompression ---

export interface ExpressRequestMiddlewareOptions {
  allowedRoutes?: RegExp[];
  maxCompressedSize?: number;
  maxDecompressedSize?: number;
  maxRatio?: number;
  queueLimit?: number;
  wasmPath?: string;
}

export function ggRequestMiddleware(opts?: ExpressRequestMiddlewareOptions): any;

// --- Middleware: Electron ---

export function registerGGProtocol(cache: GGCache): void;

// --- Middleware: Fetch Interceptor ---

export interface FetchInterceptorOptions {
  include?: RegExp[];
  exclude?: RegExp[];
  staleOnError?: boolean;
}

export function interceptFetch(cache: GGCache, opts?: FetchInterceptorOptions): void;
export function restoreFetch(): void;

